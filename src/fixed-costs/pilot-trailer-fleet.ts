import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import { InvalidFixedCostQuery, parseFixedCostRequest } from './contracts.js';
import {
  fixedCostAuthoritativeSource, InvalidFixedCostMonetaryResult,
  type DecimalString, type FixedCostDeletedRowPolicy,
} from './monetary-contract.js';
import { resolveTruckFixedCostPilotMonth, TruckFixedCostPilotRefused } from './pilot-summary.js';
import { trailerFixedCostPilotDeletedRowPolicy } from './pilot-trailer.js';
import { orderFixedCostLimitations } from './summary-contract.js';
import {
  queryTrailerFleetGroups, queryTrailerFleetTotals, trailerFleetMaxGroups,
  type TrailerFleetBucket, type TrailerFleetStateTotals, type TrailerFleetTotalsResult,
} from './trailer-fleet-repository.js';

/**
 * Fleet-wide trailer fixed-cost pilot (MP-8), behind the trailer pilot flag
 * `ERP_FIXED_COST_TRAILER_PILOT_ENABLED`. A trailer request without `trailerId`.
 *
 * TEMPORARY PILOT POLICY, NOT A PERMANENT FINANCE APPROVAL. The single-trailer
 * pilot rules apply unchanged: one settled complete calendar month, `deleted = 0`
 * only, every included task locked, the stored `locked_kastaiPriekabos` total never
 * recomputed from components.
 *
 * Attribution is `uzdaviniai.uzdavinio_priekaba` only. Included rows that cannot be
 * attributed are reported as an explicit unattributed bucket with no identifier, so
 *
 *   amount = attributedAmount + unattributedAmount
 *
 * always holds. The database evaluates that equality in DECIMAL and the request is
 * refused when it does not hold; no amount is ever added or compared in JavaScript.
 */

export const trailerFleetFixedCostPilotSemanticsVersion = 'trailer-fleet-fixed-cost-pilot-v1' as const;

export const trailerFleetAttributionInvariant = 'amount = attributedAmount + unattributedAmount' as const;

/** Database order of `data.groups`. Fixed; there is no request-selected sorting. */
export const trailerFleetBreakdownSorting = Object.freeze({
  sortBy: 'lockedAmount', sortDirection: 'desc', tieBreaker: Object.freeze({ field: 'trailerId', direction: 'asc' }),
} as const);

const sharedLimitations = [
  'Provisional internal pilot result for BT Finance Analyst; it is not an officially reconciled Finance report.',
  'Not reconciled against an accepted official ERP report (FC-11); reconciliationStatus stays provisional_unreconciled_erp_reference.',
  'Rows with deleted = 1 are excluded under a temporary MP-8 pilot policy; the deleted-row rule is not permanently approved by Finance (FC-03).',
  'Supports exactly one settled complete calendar month that starts at least six months before the current month.',
  'Zero and negative stored amounts are passed through unchanged; their treatment is unapproved (FC-13).',
  'Month filtering on kastai_data has no supporting index and scans the summary table; this is internal low-volume pilot behaviour and is not production-ready (FC-P17).',
  'The amount is the stored locked_kastaiPriekabos total from kastai_fiksuoti_ataskaita; it is never recomputed from component fields and no current value is reported.',
  'Trailer attribution uses only the assigned task trailer uzdaviniai.uzdavinio_priekaba (business-confirmed for locked historical costs); uzd_pr_vaziavo and registration text are never read.',
  'Included rows without an attributable trailer are reported as the unattributed bucket: no trailer identifier is inferred and the amount is not redistributed across trailers.',
  'Unattributed categories: missingTask (no uzdaviniai row), missingAssignment (uzdavinio_priekaba is zero or absent), invalidMasterId (uzdavinio_priekaba has no priekabos row).',
  'Lock state uses the 0000-00-00 sentinel on locked_kastaiPriekabos_data by analogy with the ERP-confirmed truck rule (FCB-05); ERP has not confirmed it for trailers.',
];

export const trailerFleetFixedCostPilotSummaryLimitations = orderFixedCostLimitations(sharedLimitations);

export const trailerFleetFixedCostPilotBreakdownLimitations = orderFixedCostLimitations([
  ...sharedLimitations,
  'Groups are the attributed trailers only, ordered by the database by locked amount descending and then trailerId ascending; trailers with no included task in the month are absent.',
  'Only the locked representation is reported; current amounts and component fields are available per trailer through trailerId.',
]);

export interface TrailerFleetFixedCostRequest {
  allocationScope: 'trailer';
  dateFrom: string;
  dateTo: string;
}

/** Exactly `allocationScope=trailer` and a paired date range: no selector, grouping, sorting or paging input. */
export function parseTrailerFleetFixedCostRequest(input: Record<string, unknown>): TrailerFleetFixedCostRequest {
  const parsed = parseFixedCostRequest(input);
  if (parsed.allocationScope !== 'trailer' || parsed.dateFrom === undefined || parsed.dateTo === undefined) throw new InvalidFixedCostQuery();
  return { allocationScope: 'trailer', dateFrom: parsed.dateFrom, dateTo: parsed.dateTo };
}

export interface TrailerFleetUnattributedCategory {
  amount: DecimalString;
  taskCount: number;
  nonZeroTaskCount: number;
}

/** Why included rows carry no attributable trailer. Counts and signed stored amounts only. */
export interface TrailerFleetUnattributedCategories {
  /** The task exists and `uzdavinio_priekaba` is zero or absent. */
  missingAssignment: TrailerFleetUnattributedCategory;
  /** The summary row's task is absent from `uzdaviniai`. */
  missingTask: TrailerFleetUnattributedCategory;
  /** `uzdavinio_priekaba` is set but has no `priekabos` row. */
  invalidMasterId: TrailerFleetUnattributedCategory;
}

/** The attribution split shared by the fleet summary and the fleet breakdown. */
export interface TrailerFleetAttribution {
  /** Stored locked trailer total of the whole included population. */
  amount: DecimalString;
  attributedAmount: DecimalString;
  attributedTaskCount: number;
  attributedTrailerCount: number;
  unattributedAmount: DecimalString;
  unattributedTaskCount: number;
  unattributedNonZeroTaskCount: number;
  unattributedCategories: TrailerFleetUnattributedCategories;
}

interface TrailerFleetMeta {
  sourceFamily: 'trailer_fixed_costs';
  amountSemantics: 'authoritative_locked_task_total_excluding_deleted';
  dateBasis: 'kastai_data';
  semanticsVersion: typeof trailerFleetFixedCostPilotSemanticsVersion;
  reconciliationStatus: 'provisional_unreconciled_erp_reference';
  attribution: {
    basis: 'uzdaviniai.uzdavinio_priekaba';
    invariant: typeof trailerFleetAttributionInvariant;
    /** Evaluated by the database in DECIMAL; a read where it does not hold is refused. */
    invariantVerified: true;
  };
  complete: true;
  pilot: true;
  limitations: readonly string[];
}

export interface TrailerFleetFixedCostPilotSummaryResponse {
  data: {
    allocationScope: 'trailer';
    periodMonth: string;
    currency: 'EUR';
    representation: 'locked';
    totalTaskCount: number;
    lockedTaskCount: number;
  } & TrailerFleetAttribution;
  meta: TrailerFleetMeta;
}

export interface TrailerFleetFixedCostPilotBreakdownResponse {
  data: {
    allocationScope: 'trailer';
    dateFrom: string;
    dateTo: string;
    currency: 'EUR';
    representation: 'locked';
    totalTaskCount: number;
    lockedTaskCount: number;
  } & TrailerFleetAttribution & {
    /** Attributed trailers only, in database order. */
    groups: readonly { trailerId: number; lockedAmount: DecimalString; taskCount: number }[];
    /** The unattributed rows as one bucket with no identifier; null when there are none. */
    unattributed: {
      reason: 'trailer_unattributed';
      lockedAmount: DecimalString;
      taskCount: number;
      nonZeroTaskCount: number;
      categories: TrailerFleetUnattributedCategories;
    } | null;
  };
  meta: TrailerFleetMeta & {
    authoritativeSource: typeof fixedCostAuthoritativeSource;
    sorting: typeof trailerFleetBreakdownSorting;
    groupCount: number;
    maxGroups: number;
    periodMonths: readonly string[];
    deletedRowPolicy: FixedCostDeletedRowPolicy;
  };
}

const incomplete = () => new TruckFixedCostPilotRefused('INCOMPLETE_RESULT');

/**
 * The single-trailer population rules (`pilotIncludedPopulation`) against the fleet
 * read: complete, only declared row states, a non-empty `deleted = 0` population
 * with stored totals, and fully locked. Unknown lock state is never treated as locked.
 */
export function trailerFleetIncludedTotals(result: TrailerFleetTotalsResult, periodMonth: string): TrailerFleetStateTotals {
  if (result.periodMonth !== periodMonth) throw new InvalidFixedCostMonetaryResult('Repository result does not match the trailer fleet read');
  if (result.complete !== true || result.truncated !== false) throw incomplete();
  if (result.states.some(state => state.deletedState === 'other' && state.authoritativeRecords > 0)) throw incomplete();
  const included = result.states.filter(state => state.deletedState === 'zero');
  if (included.length > 1) throw incomplete();
  const [state] = included;
  // No included record is not evidence of a zero cost.
  if (state === undefined || state.authoritativeRecords === 0) throw new TruckFixedCostPilotRefused('NO_DATA_FOR_PERIOD');
  if (state.missingTotalRecords !== 0 || state.authoritativeTotal === null) throw incomplete();
  if (state.lockedRecords !== state.authoritativeRecords || state.unlockedRecords !== 0 || state.unknownLockRecords !== 0) {
    throw new TruckFixedCostPilotRefused('PERIOD_NOT_FULLY_LOCKED');
  }
  // An amount that does not split exactly into attributed and unattributed is never reported.
  if (!state.reconciles) throw incomplete();
  return state;
}

const category = (bucket: TrailerFleetBucket): TrailerFleetUnattributedCategory =>
  ({ amount: bucket.total, taskCount: bucket.records, nonZeroTaskCount: bucket.nonZeroRecords });

const categories = (state: TrailerFleetStateTotals): TrailerFleetUnattributedCategories => ({
  missingAssignment: category(state.categories.missing_assignment),
  missingTask: category(state.categories.missing_task),
  invalidMasterId: category(state.categories.invalid_master_id),
});

// Stored decimal text copied field by field. No JavaScript arithmetic on any amount.
const attribution = (state: TrailerFleetStateTotals): TrailerFleetAttribution => ({
  amount: state.authoritativeTotal!,
  attributedAmount: state.attributedTotal,
  attributedTaskCount: state.attributedRecords,
  attributedTrailerCount: state.attributedTrailers,
  unattributedAmount: state.unattributed.total,
  unattributedTaskCount: state.unattributed.records,
  unattributedNonZeroTaskCount: state.unattributed.nonZeroRecords,
  unattributedCategories: categories(state),
});

const meta = (limitations: readonly string[]): TrailerFleetMeta => ({
  sourceFamily: 'trailer_fixed_costs',
  amountSemantics: 'authoritative_locked_task_total_excluding_deleted',
  dateBasis: 'kastai_data',
  semanticsVersion: trailerFleetFixedCostPilotSemanticsVersion,
  reconciliationStatus: 'provisional_unreconciled_erp_reference',
  attribution: { basis: 'uzdaviniai.uzdavinio_priekaba', invariant: trailerFleetAttributionInvariant, invariantVerified: true },
  complete: true,
  pilot: true,
  limitations,
});

/** One locked fleet read. Period rules run before any gate or replica access. */
export async function runTrailerFleetFixedCostPilotSummary(
  pool: ReplicaPool, gate: AnalyticsGate, request: TrailerFleetFixedCostRequest, now: Date = new Date(),
): Promise<TrailerFleetFixedCostPilotSummaryResponse> {
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const state = trailerFleetIncludedTotals(await queryTrailerFleetTotals(pool, gate, periodMonth, trailerFixedCostPilotDeletedRowPolicy, now), periodMonth);
  return {
    data: {
      allocationScope: 'trailer',
      periodMonth,
      currency: 'EUR',
      representation: 'locked',
      totalTaskCount: state.authoritativeRecords,
      lockedTaskCount: state.lockedRecords,
      ...attribution(state),
    },
    meta: meta(trailerFleetFixedCostPilotSummaryLimitations),
  };
}

/**
 * The summary's totals plus one group per attributed trailer. The totals read is
 * validated first, so the groups are only read for a complete, fully locked month.
 * Both reads cover the same bounded population; the groups must account for exactly
 * the attributed trailers and tasks of the totals read, or the request is refused.
 */
export async function runTrailerFleetFixedCostPilotBreakdown(
  pool: ReplicaPool, gate: AnalyticsGate, request: TrailerFleetFixedCostRequest, now: Date = new Date(),
): Promise<TrailerFleetFixedCostPilotBreakdownResponse> {
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const state = trailerFleetIncludedTotals(await queryTrailerFleetTotals(pool, gate, periodMonth, trailerFixedCostPilotDeletedRowPolicy, now), periodMonth);
  const groups = await queryTrailerFleetGroups(pool, gate, periodMonth, trailerFixedCostPilotDeletedRowPolicy, now);
  if (groups.length !== state.attributedTrailers
    || groups.reduce((total, group) => total + group.taskCount, 0) !== state.attributedRecords) {
    throw new InvalidFixedCostMonetaryResult('Trailer groups do not cover the attributed population');
  }
  return {
    data: {
      allocationScope: 'trailer',
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      currency: 'EUR',
      representation: 'locked',
      totalTaskCount: state.authoritativeRecords,
      lockedTaskCount: state.lockedRecords,
      ...attribution(state),
      // Database order is kept as returned; nothing is sorted here.
      groups: groups.map(group => ({ trailerId: group.trailerId, lockedAmount: group.lockedAmount, taskCount: group.taskCount })),
      unattributed: state.unattributed.records === 0 ? null : {
        reason: 'trailer_unattributed',
        lockedAmount: state.unattributed.total,
        taskCount: state.unattributed.records,
        nonZeroTaskCount: state.unattributed.nonZeroRecords,
        categories: categories(state),
      },
    },
    meta: {
      ...meta(trailerFleetFixedCostPilotBreakdownLimitations),
      authoritativeSource: fixedCostAuthoritativeSource,
      sorting: trailerFleetBreakdownSorting,
      groupCount: groups.length,
      maxGroups: trailerFleetMaxGroups,
      periodMonths: Object.freeze([periodMonth]),
      deletedRowPolicy: trailerFixedCostPilotDeletedRowPolicy,
    },
  };
}
