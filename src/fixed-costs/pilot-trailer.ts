import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import { InvalidFixedCostQuery, parseFixedCostRequest } from './contracts.js';
import {
  assertDecimalString, fixedCostAuthoritativeSource, fixedCostMonetaryMaxRecords, fixedCostTrailerBreakdownSources,
  InvalidFixedCostMonetaryResult,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostMonetaryGroup, type FixedCostMonetaryResult,
  type FixedCostRepresentation,
} from './monetary-contract.js';
import {
  fixedCostTrailerComponentFields, queryFixedCostMonetaryTotals, type FixedCostTrailerComponentAmounts,
} from './monetary-repository.js';
import {
  pilotIncludedPopulation, resolveTruckFixedCostPilotMonth, truckFixedCostPilotDeletedRowPolicy,
} from './pilot-summary.js';
import type { FixedCostDifferenceBucket } from './reconciliation-contract.js';
import { orderFixedCostLimitations } from './summary-contract.js';

/**
 * Single-trailer fixed-cost pilot (MP-8), behind its own fail-closed flag
 * `ERP_FIXED_COST_TRAILER_PILOT_ENABLED`.
 *
 * TEMPORARY PILOT POLICY, NOT A PERMANENT FINANCE APPROVAL. It reuses the truck
 * pilot rules unchanged — one settled complete calendar month, `deleted = 0` only,
 * every included task locked, the stored total never recomputed from components —
 * against the trailer columns of the same summary table:
 *
 * - source `kastai_fiksuoti_ataskaita`, amounts `kastaiPriekabos` /
 *   `locked_kastaiPriekabos`, lock date `locked_kastaiPriekabos_data`, period basis
 *   `kastai_data`;
 * - components from `kastai_fiksuoti_priekabos_det` / `..._det_locked`;
 * - population: exactly one trailer, `uzdaviniai.uzdavinio_priekaba = trailerId`,
 *   always a bound value, and only when that identifier exists in `priekabos`. A
 *   number that is not a trailer master id matches nothing and is refused as
 *   `NO_DATA_FOR_PERIOD`. The fleet-wide read lives in `pilot-trailer-fleet.ts`.
 *
 * The task-trailer field is business-confirmed (FC-09, 2026-09-30): it is the
 * trailer identity for locked historical trailer costs and is not changed after
 * task close. One point still rests on structural analogy with the truck scope and
 * is not ERP-confirmed: the `0000-00-00` unlocked sentinel on the trailer lock date
 * (FCB-05 covers the truck).
 */

export const trailerFixedCostPilotSemanticsVersion = 'trailer-fixed-cost-summary-pilot-v1' as const;

/** The truck pilot's deleted-row policy, unchanged: no trailer evidence requires a different rule. */
export const trailerFixedCostPilotDeletedRowPolicy: FixedCostDeletedRowPolicy = truckFixedCostPilotDeletedRowPolicy;

const sharedLimitations = [
  'Provisional internal pilot result for BT Finance Analyst; it is not an officially reconciled Finance report.',
  'Not reconciled against an accepted official ERP report (FC-11); reconciliationStatus stays provisional_unreconciled_erp_reference.',
  'Rows with deleted = 1 are excluded under a temporary MP-8 pilot policy; the deleted-row rule is not permanently approved by Finance (FC-03).',
  'Supports exactly one settled complete calendar month that starts at least six months before the current month.',
  'Zero and negative stored amounts are passed through unchanged; their treatment is unapproved (FC-13).',
  'Month filtering on kastai_data has no supporting index and scans the summary table; this is internal low-volume pilot behaviour and is not production-ready (FC-P17).',
  'The trailer population is the summary rows whose task trailer (uzdaviniai.uzdavinio_priekaba) equals trailerId, the business-confirmed trailer identity for locked historical costs (FC-09), and only when trailerId exists in the trailer master (priekabos). Rows whose task is absent from uzdaviniai cannot be attributed to any trailer and are excluded (FC-P18).',
  'Lock state uses the 0000-00-00 sentinel on locked_kastaiPriekabos_data by analogy with the ERP-confirmed truck rule (FCB-05); ERP has not confirmed it for trailers.',
];

export const trailerFixedCostPilotSummaryLimitations = orderFixedCostLimitations([
  ...sharedLimitations,
  'The amount is the stored locked_kastaiPriekabos total from kastai_fiksuoti_ataskaita; it is never recomputed from component fields and no current value is reported.',
]);

export const trailerFixedCostPilotBreakdownLimitations = orderFixedCostLimitations([
  ...sharedLimitations,
  'Current amounts are live calculations that ERP may recalculate; they are not final results.',
  'Current and locked amounts are separate representations and must never be added together or substituted for one another.',
  'Authoritative totals are read from kastai_fiksuoti_ataskaita and are never recomputed from component fields.',
  'Component fields are raw ERP column names and explanatory only; their independent additivity is unapproved and no component total may stand in for an authoritative total (FC-06, FC-07).',
]);

export interface TrailerFixedCostRequest {
  allocationScope: 'trailer';
  trailerId: number;
  dateFrom: string;
  dateTo: string;
}

/** Exactly `allocationScope=trailer`, one positive integer `trailerId` and a paired date range. */
export function parseTrailerFixedCostRequest(input: Record<string, unknown>): TrailerFixedCostRequest {
  const parsed = parseFixedCostRequest(input, { allowTrailerId: true });
  if (parsed.allocationScope !== 'trailer' || parsed.trailerId === undefined) throw new InvalidFixedCostQuery();
  if (parsed.dateFrom === undefined || parsed.dateTo === undefined) throw new InvalidFixedCostQuery();
  return { allocationScope: 'trailer', trailerId: parsed.trailerId, dateFrom: parsed.dateFrom, dateTo: parsed.dateTo };
}

export interface TrailerFixedCostPilotSummaryResponse {
  data: {
    allocationScope: 'trailer';
    trailerId: number;
    periodMonth: string;
    amount: DecimalString;
    currency: 'EUR';
    representation: 'locked';
    totalTaskCount: number;
    lockedTaskCount: number;
  };
  meta: {
    sourceFamily: 'trailer_fixed_costs';
    amountSemantics: 'authoritative_locked_task_total_excluding_deleted';
    dateBasis: 'kastai_data';
    semanticsVersion: typeof trailerFixedCostPilotSemanticsVersion;
    reconciliationStatus: 'provisional_unreconciled_erp_reference';
    complete: true;
    pilot: true;
    limitations: readonly string[];
  };
}

/** Per-representation reconciliation evidence, same fields as the truck breakdown. */
export interface TrailerFixedCostBreakdownReconciliation {
  status: 'unreconciled' | 'structurally_non_comparable';
  comparableRecords: number;
  affectedRecords: number;
  componentTotal: DecimalString | null;
  netDifference: DecimalString | null;
  grossAbsoluteDifference: DecimalString | null;
  buckets: Record<FixedCostDifferenceBucket, number>;
  noDetailRecords: number;
  multipleDetailRecords: number;
  /** Raw ERP component columns; they sum to `componentTotal`, not to the authoritative amount. */
  components: FixedCostTrailerComponentAmounts | null;
}

export interface TrailerFixedCostPilotBreakdownResponse {
  data: {
    allocationScope: 'trailer';
    dateFrom: string;
    dateTo: string;
    currency: 'EUR';
    /** Always exactly one group: the requested trailer. */
    groups: readonly [{
      trailerId: number;
      /** Stored authoritative totals, read never recomputed. */
      currentAmount: DecimalString | null;
      lockedAmount: DecimalString | null;
      taskCount: number;
      lockStates: { locked: number; unlocked: number; unknown: number };
      reconciliation: { current: TrailerFixedCostBreakdownReconciliation; locked: TrailerFixedCostBreakdownReconciliation };
    }];
  };
  meta: {
    sourceFamily: 'fixed_cost_trailer_allocation';
    authoritativeSource: typeof fixedCostAuthoritativeSource;
    breakdownSources: typeof fixedCostTrailerBreakdownSources;
    amountSemantics: 'stored_task_level_authoritative_total';
    dateBasis: 'kastai_data';
    semanticsVersion: null;
    classificationVersion: null;
    classificationApplied: false;
    reconciliationStatus: 'unreconciled';
    componentInventory: {
      status: 'explanatory_semantics_unverified';
      fields: readonly string[];
      independentlyAdditive: false;
      syntheticResidualBucket: false;
      blockers: readonly string[];
    };
    periodMonths: readonly string[];
    complete: true;
    deletedRowPolicy: FixedCostDeletedRowPolicy;
    limitations: readonly string[];
  };
}

/**
 * The trailer read must be a trailer read: scope, representation, period, source
 * and the applied trailer filter are all checked before the shared population
 * rules run, so a truck result can never be projected as a trailer amount.
 */
export function trailerPilotIncludedGroup(
  result: FixedCostMonetaryResult, representation: FixedCostRepresentation, periodMonth: string,
): FixedCostMonetaryGroup {
  const { meta } = result;
  if (meta.allocationScope !== 'trailer' || meta.representation !== representation || meta.periodMonth !== periodMonth
    || meta.currency !== 'EUR' || meta.dateBasis !== 'kastai_data' || meta.authoritativeSource !== fixedCostAuthoritativeSource
    || meta.breakdownSource !== fixedCostTrailerBreakdownSources[representation]
    || meta.trailerFilterApplied !== true || meta.truckFilterApplied !== false) {
    throw new InvalidFixedCostMonetaryResult('Repository result does not match the trailer pilot read');
  }
  return pilotIncludedPopulation(result);
}

const read = (
  pool: ReplicaPool, gate: AnalyticsGate, representation: FixedCostRepresentation, periodMonth: string, trailerId: number,
  now: Date, includeComponents: boolean,
) => queryFixedCostMonetaryTotals(pool, gate, {
  allocationScope: 'trailer', representation, periodMonth, limit: fixedCostMonetaryMaxRecords, trailerId,
  ...(includeComponents ? { includeComponents: true } : {}),
}, trailerFixedCostPilotDeletedRowPolicy, now);

/** One locked read for one trailer. Period rules run before any gate or replica access. */
export async function runTrailerFixedCostPilotSummary(
  pool: ReplicaPool, gate: AnalyticsGate, request: TrailerFixedCostRequest, now: Date = new Date(),
): Promise<TrailerFixedCostPilotSummaryResponse> {
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const group = trailerPilotIncludedGroup(await read(pool, gate, 'locked', periodMonth, request.trailerId, now, false), 'locked', periodMonth);
  return {
    data: {
      allocationScope: 'trailer',
      trailerId: request.trailerId,
      periodMonth,
      // The stored locked total, copied as decimal text. No JavaScript arithmetic.
      amount: assertDecimalString(group.authoritativeTotal!, 'amount'),
      currency: 'EUR',
      representation: 'locked',
      totalTaskCount: group.authoritativeRecords,
      lockedTaskCount: group.lockedRecords,
    },
    meta: {
      sourceFamily: 'trailer_fixed_costs',
      amountSemantics: 'authoritative_locked_task_total_excluding_deleted',
      dateBasis: 'kastai_data',
      semanticsVersion: trailerFixedCostPilotSemanticsVersion,
      reconciliationStatus: 'provisional_unreconciled_erp_reference',
      complete: true,
      pilot: true,
      limitations: trailerFixedCostPilotSummaryLimitations,
    },
  };
}

function reconciliation(group: FixedCostMonetaryGroup): TrailerFixedCostBreakdownReconciliation {
  // The repository returns components whenever includeComponents is set; absent means miswired.
  if (group.components === undefined) throw new InvalidFixedCostMonetaryResult('Component amounts missing from the breakdown read');
  return {
    status: group.reconciliationStatus,
    comparableRecords: group.comparableRecords,
    affectedRecords: group.affectedRecords,
    componentTotal: group.componentTotal,
    netDifference: group.netDifference,
    grossAbsoluteDifference: group.grossAbsoluteDifference,
    buckets: group.buckets,
    noDetailRecords: group.noDetailRecords,
    multipleDetailRecords: group.multipleDetailRecords,
    // trailerPilotIncludedGroup proved a trailer read, so these are the trailer component fields.
    components: group.components as FixedCostTrailerComponentAmounts | null,
  };
}

/**
 * Current and locked are read separately, each with its own detail table, and are
 * never added or substituted. Both reads apply the summary's population rules, so
 * absent data, unlocked tasks and incomplete reads refuse exactly as the summary does.
 */
export async function runTrailerFixedCostPilotBreakdown(
  pool: ReplicaPool, gate: AnalyticsGate, request: TrailerFixedCostRequest, now: Date = new Date(),
): Promise<TrailerFixedCostPilotBreakdownResponse> {
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const current = trailerPilotIncludedGroup(await read(pool, gate, 'current', periodMonth, request.trailerId, now, true), 'current', periodMonth);
  const locked = trailerPilotIncludedGroup(await read(pool, gate, 'locked', periodMonth, request.trailerId, now, true), 'locked', periodMonth);
  // Both representations must describe the same task population.
  for (const key of ['authoritativeRecords', 'lockedRecords', 'unlockedRecords', 'unknownLockRecords', 'missingTaskCount'] as const) {
    if (current[key] !== locked[key]) {
      throw new InvalidFixedCostMonetaryResult('Current and locked breakdowns describe different task populations');
    }
  }
  return {
    data: {
      allocationScope: 'trailer',
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      currency: 'EUR',
      groups: [{
        trailerId: request.trailerId,
        currentAmount: current.authoritativeTotal,
        lockedAmount: locked.authoritativeTotal,
        taskCount: current.authoritativeRecords,
        lockStates: { locked: current.lockedRecords, unlocked: current.unlockedRecords, unknown: current.unknownLockRecords },
        reconciliation: { current: reconciliation(current), locked: reconciliation(locked) },
      }],
    },
    meta: {
      sourceFamily: 'fixed_cost_trailer_allocation',
      authoritativeSource: fixedCostAuthoritativeSource,
      breakdownSources: fixedCostTrailerBreakdownSources,
      amountSemantics: 'stored_task_level_authoritative_total',
      dateBasis: 'kastai_data',
      semanticsVersion: null,
      classificationVersion: null,
      classificationApplied: false,
      reconciliationStatus: 'unreconciled',
      componentInventory: {
        status: 'explanatory_semantics_unverified',
        fields: Object.freeze([...fixedCostTrailerComponentFields].sort()),
        independentlyAdditive: false,
        syntheticResidualBucket: false,
        blockers: Object.freeze(['FC-06', 'FC-07']),
      },
      periodMonths: Object.freeze([periodMonth]),
      complete: true,
      deletedRowPolicy: trailerFixedCostPilotDeletedRowPolicy,
      limitations: trailerFixedCostPilotBreakdownLimitations,
    },
  };
}
