import {
  fixedCostMaximumDateRangeDays, InvalidFixedCostQuery, parseFixedCostRequest,
} from './contracts.js';
import {
  fixedCostAuthoritativeSource, fixedCostBreakdownSources,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostRepresentation,
} from './monetary-contract.js';
import type { FixedCostDifferenceBucket } from './reconciliation-contract.js';

/**
 * Slice 6A — public truck fixed-cost summary contract.
 *
 * This is the request and response shape for a future successful summary. Nothing
 * here activates a capability: all five allocation scopes remain disabled and every
 * public fixed-cost endpoint still answers `SEMANTICS_UNVERIFIED`.
 */

/** The only allocation scope with an implemented monetary path. */
export const fixedCostSummaryScope = 'truck' as const;

export interface TruckFixedCostSummaryRequest {
  allocationScope: typeof fixedCostSummaryScope;
  dateFrom: string;
  dateTo: string;
  /** Restricts the population to one canonical ERP truck ID. Absent means fleet-wide. */
  truckId?: number;
}

/**
 * Strict public request validation.
 *
 * Allowed inputs are exactly `allocationScope=truck` plus a paired `dateFrom` and
 * `dateTo`, and optionally one positive integer `truckId`. The shared parser already rejects unknown parameters, repeated query
 * parameters (Fastify yields an array, which is not a string), non-canonical dates,
 * reversed ranges and ranges beyond the documented maximum; summary additionally
 * requires the scope to be `truck` and the date pair to be present.
 *
 * No `representation`, deleted-row policy, tolerance, table, field, grouping,
 * sorting, pagination, SQL fragment or internal query limit is accepted, so nothing
 * a caller or a model supplies can reach the generated SQL beyond bound values.
 */
export function parseTruckFixedCostSummaryRequest(input: Record<string, unknown>): TruckFixedCostSummaryRequest {
  const parsed = parseFixedCostRequest(input, { allowTruckId: true });
  if (parsed.allocationScope !== fixedCostSummaryScope) throw new InvalidFixedCostQuery();
  if (parsed.dateFrom === undefined || parsed.dateTo === undefined) throw new InvalidFixedCostQuery();
  return {
    allocationScope: fixedCostSummaryScope, dateFrom: parsed.dateFrom, dateTo: parsed.dateTo,
    ...(parsed.truckId === undefined ? {} : { truckId: parsed.truckId }),
  };
}

export { fixedCostMaximumDateRangeDays };

/**
 * Day-range to cost-month mapping is **not approved**.
 *
 * The public contract accepts arbitrary calendar days, while the monetary
 * repository is scoped to a whole cost month on `kastai_data`. No ERP or Finance
 * rule defines how a partial month is treated: whether `dateTo` is inclusive,
 * whether a partial month is included, excluded or pro-rated, and whether a range
 * may span months at all. Inventing any of those would fabricate a financial rule,
 * so the resolver below reports the blocker instead of guessing.
 */
export const fixedCostSummaryMonthMappingBlocker = 'FC-P19' as const;

export type TruckFixedCostSummaryPeriodPlan =
  | { resolved: true; months: readonly string[] }
  | { resolved: false; reason: 'month_mapping_unapproved'; blocker: typeof fixedCostSummaryMonthMappingBlocker };

/** Always unresolved today. Kept as a seam so FC-P19 can be answered in one place. */
export function planTruckFixedCostSummaryPeriod(_request: TruckFixedCostSummaryRequest): TruckFixedCostSummaryPeriodPlan {
  return { resolved: false, reason: 'month_mapping_unapproved', blocker: fixedCostSummaryMonthMappingBlocker };
}

/** Per-representation reconciliation evidence, never netted away or summarised out. */
export interface TruckFixedCostSummaryReconciliation {
  status: 'unreconciled' | 'structurally_non_comparable';
  comparableRecords: number;
  affectedRecords: number;
  comparableAuthoritativeTotal: DecimalString | null;
  componentTotal: DecimalString | null;
  /** Signed sum; kept alongside the gross figure, never as a replacement for it. */
  netDifference: DecimalString | null;
  /** Per-record absolute sum, so opposite signs cannot cancel. */
  grossAbsoluteDifference: DecimalString | null;
  buckets: Record<FixedCostDifferenceBucket, number>;
  noDetailRecords: number;
  multipleDetailRecords: number;
  missingTotalRecords: number;
}

export interface TruckFixedCostSummaryData {
  allocationScope: typeof fixedCostSummaryScope;
  dateFrom: string;
  dateTo: string;
  currency: 'EUR';
  /** Stored authoritative totals. Null when the population is non-comparable or absent. */
  currentAmount: DecimalString | null;
  lockedAmount: DecimalString | null;
  totalTaskCount: number;
  lockedTaskCount: number;
  unlockedTaskCount: number;
  /** Records whose lock state could not be read from the confirmed sentinel. */
  unknownLockStateTaskCount: number;
  reconciliation: {
    current: TruckFixedCostSummaryReconciliation;
    locked: TruckFixedCostSummaryReconciliation;
  };
}

export interface TruckFixedCostSummaryMetadata {
  sourceFamily: 'fixed_cost_truck_allocation';
  authoritativeSource: typeof fixedCostAuthoritativeSource;
  breakdownSources: typeof fixedCostBreakdownSources;
  amountSemantics: 'stored_task_level_authoritative_total';
  dateBasis: 'kastai_data';
  /** Never invented; no semantic version is approved. */
  semanticsVersion: null;
  classificationApplied: false;
  classificationVersion: null;
  reconciliationStatus: 'unreconciled';
  representation: {
    mode: 'current_and_locked_reported_separately';
    current: typeof fixedCostBreakdownSources['current'];
    locked: typeof fixedCostBreakdownSources['locked'];
  };
  periodMonths: readonly string[];
  complete: boolean;
  /** Summary records whose task is absent from `uzdaviniai`, when applicable. */
  missingTaskCount: number;
  deletedRowPolicy: FixedCostDeletedRowPolicy;
  pendingApprovals: readonly string[];
  /** Deterministically ordered; see `orderFixedCostLimitations`. */
  limitations: readonly string[];
}

export interface TruckFixedCostSummaryResponse {
  data: TruckFixedCostSummaryData;
  meta: TruckFixedCostSummaryMetadata;
}

/** Stable ordering for every emitted collection: sorted, de-duplicated, never insertion-ordered. */
export function orderFixedCostLimitations(entries: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(entries)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Limitations that always apply to a truck summary.
 *
 * The first entry exists because ERP confirmed that recent values keep
 * recalculating for roughly three months (FCB-10): a current figure is a live
 * calculation, never a final result.
 */
export const truckFixedCostSummaryLimitations = orderFixedCostLimitations([
  'Current amounts are live calculations that ERP may recalculate for approximately three months; they are not final results.',
  'Current and locked amounts are separate representations and must never be added together or substituted for one another.',
  'Authoritative totals are read from kastai_fiksuoti_ataskaita and are never recomputed from component fields.',
  'Component sums explain the total but do not define it; per-record differences up to EUR 1 have been measured and remain visible as reconciliation metadata.',
  'Records without exactly one matching detail row are structurally non-comparable, are never bucketed and never receive a fabricated zero component total.',
  'No reconciliation against an official ERP report has been accepted, so reconciliationStatus stays unreconciled.',
  'No cost-group classification is applied and no classificationVersion exists.',
  'kastai_fiksuoti_ataskaita has no production-suitable index on kastai_data; month filtering scans approximately 1.56 million summary rows.',
]);

export const truckFixedCostSummaryPendingApprovals = Object.freeze([
  'FC-03', 'FC-06', 'FC-07', 'FC-11', 'FC-13', 'FC-14', 'FC-P17', 'FC-P19',
] as const);

/** Reasons the summary cannot be produced. Each maps to a recorded blocker. */
export type TruckFixedCostSummaryBlockedReason =
  | 'month_mapping_unapproved'
  | 'multi_month_aggregation_unavailable'
  | 'deleted_state_collapse_unapproved'
  | 'cross_state_addition_unavailable'
  | 'incomplete_population'
  | 'period_month_invalid'
  | 'period_outside_request_range';

export class TruckFixedCostSummaryUnavailable extends Error {
  constructor(readonly reason: TruckFixedCostSummaryBlockedReason, readonly blocker: string) {
    super(`Truck fixed-cost summary unavailable: ${reason} (${blocker})`);
    this.name = 'TruckFixedCostSummaryUnavailable';
  }
}

export type FixedCostSummaryRepresentationSource = Record<FixedCostRepresentation, unknown>;


const canonicalCostMonth = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-01$/;

/**
 * Validates injected cost months against the request without deciding FC-P19.
 *
 * Two checks only, both necessary under *any* eventual mapping rule:
 *
 * 1. Each month is canonical `YYYY-MM-01`, so no unparsed text reaches metadata.
 * 2. Each month overlaps the requested range at all. A month sharing no day with
 *    the request could not be selected by any sane mapping, so rejecting it
 *    invents nothing — it does not decide `dateTo` inclusivity, partial-month
 *    treatment or which of several overlapping months belong in the result.
 *
 * Without this, a response could echo one date range while reporting another
 * period's money.
 */
export function assertSummaryPeriodMonths(
  months: readonly string[],
  request: TruckFixedCostSummaryRequest,
): void {
  for (const month of months) {
    const match = canonicalCostMonth.exec(month);
    if (!match) throw new TruckFixedCostSummaryUnavailable('period_month_invalid', fixedCostSummaryMonthMappingBlocker);
    // First day of the following month; the cost month covers [month, next).
    const next = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1)).toISOString().slice(0, 10);
    if (month > request.dateTo || next <= request.dateFrom) {
      throw new TruckFixedCostSummaryUnavailable('period_outside_request_range', fixedCostSummaryMonthMappingBlocker);
    }
  }
}
