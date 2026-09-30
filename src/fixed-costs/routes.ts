import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { ApiError, apiErrorBody } from '../errors.js';
import { fixedCostEndpoints, resolveFixedCostCapability, type FixedCostEndpoint } from './capabilities.js';
import { InvalidFixedCostQuery, parseFixedCostRequest } from './contracts.js';
import { FixedCostDeletedPolicyUnapproved, InvalidFixedCostMonetaryQuery, InvalidFixedCostMonetaryResult } from './monetary-contract.js';
import { FixedCostMonetaryError, FixedCostMonetaryTruncated } from './monetary-repository.js';
import { TruckFixedCostBreakdownUnavailable } from './breakdown-contract.js';
import { runTruckFixedCostPilotBreakdown } from './pilot-breakdown.js';
import { runTruckFixedCostPilotSummary, TruckFixedCostPilotRefused, type TruckFixedCostPilotRefusal } from './pilot-summary.js';
import { parseTrailerFixedCostRequest, runTrailerFixedCostPilotBreakdown, runTrailerFixedCostPilotSummary } from './pilot-trailer.js';
import { parseTruckFixedCostSummaryRequest } from './summary-contract.js';

const invalidQuery = () => apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid fixed-cost query'));
const semanticsUnverified = () => apiErrorBody(new ApiError(
  422,
  'SEMANTICS_UNVERIFIED',
  'The requested fixed-cost allocation scope has not passed source, amount, currency, date, lock/status, and reconciliation validation.',
));

const pilotRefusalMessages: Record<TruckFixedCostPilotRefusal, string> = {
  PERIOD_NOT_COMPLETE_MONTH: 'The fixed-cost pilot accepts exactly one complete calendar month: dateFrom must be its first day and dateTo its last day.',
  PERIOD_NOT_SETTLED: 'The fixed-cost pilot accepts only months starting at least six months before the current month.',
  PERIOD_NOT_FULLY_LOCKED: 'The selected month contains included tasks that are not locked, so no authoritative locked total can be reported.',
  INCOMPLETE_RESULT: 'The fixed-cost result could not be proven complete, so no amount is reported.',
  NO_DATA_FOR_PERIOD: 'No included fixed-cost records exist for the selected month; absence of records is not reported as a zero amount.',
};

// MariaDB connector codes raised before any statement executes: pool acquisition
// timed out, or a new connection could not be opened (replica unreachable, or the
// pool exhausted by other traffic).
const connectionFailureCodes = new Set(['ER_GET_CONNECTION_TIMEOUT', 'ER_CONNECTION_TIMEOUT']);

export interface FixedCostRouteOptions {
  /** Validated application configuration only; never request, model or query input. */
  fixedCosts?: AppConfig['fixedCosts'];
}

export async function registerFixedCostRoutes(app: FastifyInstance, options: FixedCostRouteOptions = {}) {
  // Missing or partial options resolve to disabled, so an unwired pilot fails closed.
  const fixedCosts: AppConfig['fixedCosts'] = Object.freeze({
    truckSummaryPilotEnabled: options.fixedCosts?.truckSummaryPilotEnabled === true,
    trailerPilotEnabled: options.fixedCosts?.trailerPilotEnabled === true,
  });
  for (const path of fixedCostEndpoints) {
    app.get<{ Querystring: Record<string, unknown> }>(`/expense-analytics/fixed-costs/${path}`, async (request, reply) => {
      try {
        // truckId and trailerId belong to the summary and breakdown contracts; on dimensions they stay unknown.
        const selectors = path !== 'dimensions';
        const parsed = parseFixedCostRequest(request.query, { allowTruckId: selectors, allowTrailerId: selectors });
        // The capability gate runs before any replica, repository, or analytics-gate
        // work. Only the configured truck and trailer pilots can resolve as enabled.
        const capability = resolveFixedCostCapability(path, parsed.allocationScope, fixedCosts, { truckId: parsed.truckId, trailerId: parsed.trailerId });
        if (!capability.enabled) return reply.code(422).send(semanticsUnverified());
        return await pilot(app, request, reply, capability.mode);
      } catch (error) {
        if (error instanceof InvalidFixedCostQuery) return reply.code(400).send(invalidQuery());
        throw error;
      }
    });
  }
}

async function pilot(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: Record<string, unknown> }>,
  reply: FastifyReply,
  mode: 'truck_summary_pilot' | 'truck_breakdown_pilot' | 'trailer_summary_pilot' | 'trailer_breakdown_pilot',
) {
  const trailer = mode === 'trailer_summary_pilot' || mode === 'trailer_breakdown_pilot';
  // The trailer pilots take exactly allocationScope=trailer, one trailerId and one month.
  const trailerRequest = trailer ? parseTrailerFixedCostRequest(request.query) : undefined;
  // Both truck pilots share one public request shape: allocationScope=truck, one month, optional truckId.
  const pilotRequest = trailer ? undefined : parseTruckFixedCostSummaryRequest(request.query);
  const breakdown = mode === 'truck_breakdown_pilot' || mode === 'trailer_breakdown_pilot';
  // Defence in depth: the resolver already requires a truckId for the breakdown.
  if (breakdown && pilotRequest !== undefined && pilotRequest.truckId === undefined) return reply.code(422).send(semanticsUnverified());

  const startedAt = performance.now();
  const endpoint: FixedCostEndpoint = breakdown ? 'breakdown' : 'summary';
  const operation = `fixed_cost.${trailer ? 'trailer' : 'truck'}_${endpoint}_pilot`;
  // Duration, outcome and safe counters only: no amount, task, truck, date or row.
  const telemetry = (outcome: 'success' | 'refused' | 'error' | 'timeout' | 'busy', extra: Record<string, unknown> = {}) => {
    const event = {
      request_id: request.id, endpoint: `/expense-analytics/fixed-costs/${endpoint}`, operation,
      duration_ms: Number((performance.now() - startedAt).toFixed(2)), outcome,
      timeout: outcome === 'timeout', busy: outcome === 'busy', ...extra,
    };
    if (outcome === 'success' && event.duration_ms < app.vehicleSafety.slowQueryMs) request.log.info(event, 'Fixed-cost pilot request');
    else request.log.warn(event, outcome === 'success' ? 'Slow fixed-cost pilot request' : 'Fixed-cost pilot request refused or failed');
  };

  try {
    if (trailerRequest !== undefined) {
      if (breakdown) {
        const result = await runTrailerFixedCostPilotBreakdown(app.replica, app.analyticsGate, trailerRequest);
        telemetry('success', { group_count: result.data.groups.length });
        return result;
      }
      const result = await runTrailerFixedCostPilotSummary(app.replica, app.analyticsGate, trailerRequest);
      telemetry('success', { total_task_count: result.data.totalTaskCount });
      return result;
    }
    if (pilotRequest === undefined) return reply.code(422).send(semanticsUnverified());
    if (breakdown) {
      const result = await runTruckFixedCostPilotBreakdown(app.replica, app.analyticsGate, { ...pilotRequest, truckId: pilotRequest.truckId! });
      telemetry('success', { group_count: result.meta.pagination.groupCount });
      return result;
    }
    const result = await runTruckFixedCostPilotSummary(app.replica, app.analyticsGate, pilotRequest);
    telemetry('success', { total_task_count: result.data.totalTaskCount });
    return result;
  } catch (error) {
    if (error instanceof TruckFixedCostPilotRefused) {
      telemetry('refused', { refusal: error.code });
      return reply.code(422).send(apiErrorBody(new ApiError(422, error.code, pilotRefusalMessages[error.code])));
    }
    if (error instanceof FixedCostMonetaryTruncated || error instanceof InvalidFixedCostMonetaryResult || error instanceof TruckFixedCostBreakdownUnavailable) {
      telemetry('refused', { refusal: 'INCOMPLETE_RESULT' });
      return reply.code(422).send(apiErrorBody(new ApiError(422, 'INCOMPLETE_RESULT', pilotRefusalMessages.INCOMPLETE_RESULT)));
    }
    if (error instanceof ApiError) {
      // Analytics-gate saturation, preserved unchanged by the repository.
      telemetry('busy');
      return reply.code(error.statusCode).send(apiErrorBody(error));
    }
    if (error instanceof FixedCostMonetaryError) {
      // The shared timeout classifier also matches connection-acquisition timeouts.
      // No statement ran in that case, so it is reported as unavailable, not as a
      // query timeout. Only the classification is logged, never driver diagnostics.
      const connectionFailure = error.diagnostics.some(entry => entry.code !== undefined && connectionFailureCodes.has(entry.code));
      if (error.code === 'QUERY_TIMEOUT' && !connectionFailure) {
        telemetry('timeout', { failure: 'statement_timeout' });
        return reply.code(504).send(apiErrorBody(new ApiError(504, 'QUERY_TIMEOUT', 'Fixed-cost query timed out')));
      }
      telemetry('error', { failure: connectionFailure ? 'connection' : 'replica' });
      return reply.code(503).send(apiErrorBody(new ApiError(503, 'REPLICA_UNAVAILABLE', 'Fixed-cost data temporarily unavailable')));
    }
    if (error instanceof FixedCostDeletedPolicyUnapproved || error instanceof InvalidFixedCostMonetaryQuery) {
      // Internal pilot inputs are constants; reaching this means the pilot is miswired.
      telemetry('error');
      return reply.code(422).send(semanticsUnverified());
    }
    throw error;
  }
}
