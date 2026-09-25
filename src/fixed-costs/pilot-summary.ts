import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import {
  assertDecimalString, fixedCostAuthoritativeSource, fixedCostMonetaryMaxRecords, InvalidFixedCostMonetaryResult,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostMonetaryResult,
} from './monetary-contract.js';
import { queryFixedCostMonetaryTotals } from './monetary-repository.js';
import { parseFixedCostReconciliationMonth } from './reconciliation-contract.js';
import { orderFixedCostLimitations, type TruckFixedCostSummaryRequest } from './summary-contract.js';

/**
 * Slice 6P — provisional locked truck fixed-cost summary pilot.
 *
 * TEMPORARY MP-8 PILOT POLICY, NOT A PERMANENT FINANCE APPROVAL:
 *
 * - `allocationScope=truck`, summary endpoint only;
 * - exactly one complete calendar month, at least six months before the current month;
 * - source `kastai_fiksuoti_ataskaita`, reportable amount `locked_kastaiVilkiko`,
 *   period basis `kastai_data`, currency EUR;
 * - only the `deleted = 0` population is included; `deleted = 1` is excluded;
 * - every included task must be locked, otherwise the request is refused;
 * - the amount is the stored locked total, never a component sum and never the
 *   current (live) value.
 *
 * Nothing here is request-controlled: the policy, representation and record bound
 * are constants. The route reaches this module only when the fail-closed
 * `ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED` flag is strictly `true`.
 */

export const truckFixedCostPilotSemanticsVersion = 'truck-fixed-cost-summary-pilot-v1' as const;

/**
 * The internal deleted-row policy for the pilot. `approved` satisfies the
 * repository gate for this pilot only; `approvedBy` names the temporary MP-8
 * pilot decision so it can never be read as Finance approval of FC-03.
 */
export const truckFixedCostPilotDeletedRowPolicy: FixedCostDeletedRowPolicy = Object.freeze({
  treatment: 'exclude_deleted',
  approved: true,
  approvedBy: 'MP-8 Slice 6P temporary pilot policy (not Finance approval)',
  reference: 'FC-03',
});

const sharedPilotLimitations = [
  'Provisional internal pilot result for BT Finance Analyst; it is not an officially reconciled Finance report.',
  'Not reconciled against an accepted official ERP report (FC-11); reconciliationStatus stays provisional_unreconciled_erp_reference.',
  'Rows with deleted = 1 are excluded under a temporary MP-8 pilot policy; the deleted-row rule is not permanently approved by Finance (FC-03).',
  'Supports exactly one settled complete calendar month that starts at least six months before the current month.',
  'The amount is the stored locked_kastaiVilkiko total from kastai_fiksuoti_ataskaita; it is never recomputed from component fields and no current value is reported.',
  'Zero and negative stored amounts are passed through unchanged; their treatment is unapproved (FC-13).',
  'Month filtering on kastai_data has no supporting index and scans the summary table; this is internal low-volume pilot behaviour and is not production-ready (FC-P17).',
];

export const truckFixedCostPilotLimitations = orderFixedCostLimitations([
  ...sharedPilotLimitations,
  'Summary rows whose task is absent from uzdaviniai remain in the included population; their inclusion rule is unresolved (FC-P18).',
]);

/** Single-truck responses: orphan rows cannot be attributed to a truck, so they are outside the population. */
export const truckFixedCostPilotSingleTruckLimitations = orderFixedCostLimitations([
  ...sharedPilotLimitations,
  'The truck population is the summary rows whose task truck (uzdaviniai.uzdavinio_masina, FC-08) equals truckId; rows whose task is absent from uzdaviniai cannot be attributed to any truck and are excluded (FC-P18).',
]);

export interface TruckFixedCostPilotSummaryResponse {
  data: {
    allocationScope: 'truck';
    /** Present only on single-truck requests; fleet-wide responses omit it. */
    truckId?: number;
    periodMonth: string;
    amount: DecimalString;
    currency: 'EUR';
    representation: 'locked';
    totalTaskCount: number;
    lockedTaskCount: number;
  };
  meta: {
    sourceFamily: 'truck_fixed_costs';
    amountSemantics: 'authoritative_locked_task_total_excluding_deleted';
    dateBasis: 'kastai_data';
    semanticsVersion: typeof truckFixedCostPilotSemanticsVersion;
    reconciliationStatus: 'provisional_unreconciled_erp_reference';
    complete: true;
    pilot: true;
    limitations: readonly string[];
  };
}

export type TruckFixedCostPilotRefusal =
  | 'PERIOD_NOT_COMPLETE_MONTH'
  | 'PERIOD_NOT_SETTLED'
  | 'PERIOD_NOT_FULLY_LOCKED'
  | 'INCOMPLETE_RESULT'
  | 'NO_DATA_FOR_PERIOD';

/** A deterministic, business-level refusal. Carries no amount, ID or row data. */
export class TruckFixedCostPilotRefused extends Error {
  constructor(readonly code: TruckFixedCostPilotRefusal) {
    super(`Truck fixed-cost pilot refused: ${code}`);
    this.name = 'TruckFixedCostPilotRefused';
  }
}

const lastDayOfMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);

/**
 * Resolves the pilot period without any day-range to cost-month inference.
 *
 * The request must already be one exact calendar month (`dateFrom` is the first
 * day, `dateTo` the actual final day of the same month), so FC-P19 does not have to
 * be answered: no partial month, inclusivity rule or multi-month span is accepted.
 * Settlement reuses the committed Slice 4 six-month rule.
 */
export function resolveTruckFixedCostPilotMonth(request: TruckFixedCostSummaryRequest, now: Date = new Date()): string {
  const match = /^([0-9]{4})-([0-9]{2})-01$/.exec(request.dateFrom);
  if (!match) throw new TruckFixedCostPilotRefused('PERIOD_NOT_COMPLETE_MONTH');
  if (request.dateTo !== lastDayOfMonth(Number(match[1]), Number(match[2]) - 1)) {
    throw new TruckFixedCostPilotRefused('PERIOD_NOT_COMPLETE_MONTH');
  }
  try {
    return parseFixedCostReconciliationMonth(request.dateFrom, now).month;
  } catch {
    // The month is already canonical, so the only remaining refusal is settlement.
    throw new TruckFixedCostPilotRefused('PERIOD_NOT_SETTLED');
  }
}

const incomplete = () => new TruckFixedCostPilotRefused('INCOMPLETE_RESULT');

/**
 * Applies the pilot rules to one locked repository read.
 *
 * Exported for mutation tests; the route always reaches it through
 * `runTruckFixedCostPilotSummary`, which supplies the fixed pilot inputs.
 */
export function projectTruckFixedCostPilotSummary(result: FixedCostMonetaryResult, periodMonth: string, truckId?: number): TruckFixedCostPilotSummaryResponse {
  const { meta } = result;
  if (meta.representation !== 'locked' || meta.periodMonth !== periodMonth || meta.allocationScope !== 'truck'
    || meta.currency !== 'EUR' || meta.dateBasis !== 'kastai_data' || meta.authoritativeSource !== fixedCostAuthoritativeSource
    || meta.truckFilterApplied !== (truckId !== undefined)) {
    throw new InvalidFixedCostMonetaryResult('Repository result does not match the pilot read');
  }
  if (meta.complete !== true || meta.truncated !== false) throw incomplete();

  // Only declared states are accepted. An undeclared `deleted` value is neither the
  // included nor the excluded population, so the included set cannot be proven.
  if (result.groups.some(group => group.deletedState === 'other' && group.authoritativeRecords > 0)) throw incomplete();
  const included = result.groups.filter(group => group.deletedState === 'zero');
  if (included.length > 1) throw incomplete();
  const [group] = included;

  if (group === undefined || group.authoritativeRecords === 0) {
    // No included record is not evidence of a zero cost. The absence of ERP rows,
    // or rows only in deleted = 1, is refused rather than reported as "0.00".
    throw new TruckFixedCostPilotRefused('NO_DATA_FOR_PERIOD');
  }
  // A null stored locked total would silently drop out of SUM, so the total would
  // cover fewer tasks than it claims. Refuse rather than under-report.
  if (group.missingTotalRecords !== 0 || group.authoritativeTotal === null) throw incomplete();
  if (group.lockedRecords !== group.authoritativeRecords || group.unlockedRecords !== 0 || group.unknownLockRecords !== 0) {
    throw new TruckFixedCostPilotRefused('PERIOD_NOT_FULLY_LOCKED');
  }
  // The stored locked total, copied as decimal text. No JavaScript arithmetic. A
  // stored total of "0.00" over real, fully locked records is a legitimate zero.
  return response(periodMonth, assertDecimalString(group.authoritativeTotal, 'amount'), group.authoritativeRecords, group.lockedRecords, truckId);
}

function response(periodMonth: string, amount: DecimalString, totalTaskCount: number, lockedTaskCount: number, truckId?: number): TruckFixedCostPilotSummaryResponse {
  return {
    data: {
      allocationScope: 'truck',
      ...(truckId === undefined ? {} : { truckId }),
      periodMonth,
      amount,
      currency: 'EUR',
      representation: 'locked',
      totalTaskCount,
      lockedTaskCount,
    },
    meta: {
      sourceFamily: 'truck_fixed_costs',
      amountSemantics: 'authoritative_locked_task_total_excluding_deleted',
      dateBasis: 'kastai_data',
      semanticsVersion: truckFixedCostPilotSemanticsVersion,
      reconciliationStatus: 'provisional_unreconciled_erp_reference',
      complete: true,
      pilot: true,
      limitations: truckId === undefined ? truckFixedCostPilotLimitations : truckFixedCostPilotSingleTruckLimitations,
    },
  };
}

/**
 * The only pilot entry point. One locked read through the existing gated
 * repository: static unqualified SQL, bound values, AnalyticsGate, the pool's
 * configured query timeout, the hard record bound and truncation detection.
 * Nothing is logged here; the route emits duration telemetry without values.
 */
export async function runTruckFixedCostPilotSummary(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  request: TruckFixedCostSummaryRequest,
  now: Date = new Date(),
): Promise<TruckFixedCostPilotSummaryResponse> {
  // Period rules run before any gate or replica access.
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  // A single truck reuses the repository's bound truck allowlist (`t.uzdavinio_masina IN (?)`).
  const result = await queryFixedCostMonetaryTotals(pool, gate, {
    allocationScope: 'truck', representation: 'locked', periodMonth, limit: fixedCostMonetaryMaxRecords,
    ...(request.truckId === undefined ? {} : { truckIds: [request.truckId] }),
  }, truckFixedCostPilotDeletedRowPolicy, now);
  return projectTruckFixedCostPilotSummary(result, periodMonth, request.truckId);
}
