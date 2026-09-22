import type { FastifyInstance } from 'fastify';
import { ApiError, apiErrorBody } from '../errors.js';
import { fixedCostSemanticCapabilities } from './capabilities.js';
import { InvalidFixedCostQuery, parseFixedCostRequest } from './contracts.js';

const invalidQuery = () => apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid fixed-cost query'));
const semanticsUnverified = () => apiErrorBody(new ApiError(
  422,
  'SEMANTICS_UNVERIFIED',
  'The requested fixed-cost allocation scope has not passed source, amount, currency, date, lock/status, and reconciliation validation.',
));

export async function registerFixedCostRoutes(app: FastifyInstance) {
  for (const path of ['summary', 'breakdown', 'dimensions'] as const) {
    app.get<{ Querystring: Record<string, unknown> }>(`/expense-analytics/fixed-costs/${path}`, async (request, reply) => {
      try {
        const parsed = parseFixedCostRequest(request.query);
        // The semantic gate intentionally runs before any replica, repository,
        // or analytics-gate work. No monetary query exists in this slice.
        if (!fixedCostSemanticCapabilities[parsed.allocationScope].enabled) return reply.code(422).send(semanticsUnverified());
        // Fail closed even if a future registry edit is made before a verified
        // monetary executor is implemented.
        return reply.code(422).send(semanticsUnverified());
      } catch (error) {
        if (error instanceof InvalidFixedCostQuery) return reply.code(400).send(invalidQuery());
        throw error;
      }
    });
  }
}
