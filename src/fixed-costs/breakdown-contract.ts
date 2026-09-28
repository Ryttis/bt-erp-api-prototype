import { fixedCostMaximumDateRangeDays, InvalidFixedCostQuery } from './contracts.js';
import {
  fixedCostAuthoritativeSource, fixedCostBreakdownSources,
  type DecimalString, type FixedCostDeletedRowPolicy,
} from './monetary-contract.js';
import { fixedCostComponentFields, type FixedCostComponentAmounts } from './monetary-repository.js';
import type { FixedCostDifferenceBucket } from './reconciliation-contract.js';
import { orderFixedCostLimitations } from './summary-contract.js';

/**
 * Slice 7A — truck fixed-cost breakdown contract.
 *
 * Request and response shapes for a future grouped result. Nothing here activates
 * a capability: all five allocation scopes stay disabled and every public
 * fixed-cost endpoint still answers `SEMANTICS_UNVERIFIED`.
 *
 * Parameter names follow the fixed-cost domain's own camelCase surface
 * (`allocationScope`, `dateFrom`, `dateTo`), not the snake_case used by the older
 * `/vehicles` and `/invoices` domains. The two conventions already coexist; a
 * breakdown request shares a query string with `allocationScope`, so matching the
 * fixed-cost surface keeps one request internally consistent.
 */

export const fixedCostBreakdownScope = 'truck' as const;

/** Recognised grouping values. Recognised is not the same as available. */
export const fixedCostGroupings = ['truck', 'month', 'costComponent'] as const;
export type FixedCostGrouping = typeof fixedCostGroupings[number];

export type FixedCostGroupingAvailability =
  | { status: 'structurally_supported_not_activated'; basis: string; blockers: readonly string[] }
  | { status: 'blocked'; reason: string; blockers: readonly string[] };

/**
 * Explicit availability per grouping. A blocked grouping is never silently treated
 * as supported: the parser recognises it, this registry refuses it, and the
 * orchestration fails closed with the recorded blocker.
 */
export const fixedCostGroupingAvailability: Record<FixedCostGrouping, FixedCostGroupingAvailability> = Object.freeze({
  truck: Object.freeze({
    status: 'structurally_supported_not_activated',
    basis: 'uzdaviniai.uzdavinio_masina, confirmed as the truck field under FC-08 (FCB-08)',
    blockers: Object.freeze(['FC-11', 'FC-14', 'FC-03', 'FC-02', 'FC-P17']),
  }),
  month: Object.freeze({
    status: 'blocked',
    reason: 'The date-range to cost-month mapping is unapproved, so a month grouping cannot define its own buckets.',
    blockers: Object.freeze(['FC-P19']),
  }),
  costComponent: Object.freeze({
    status: 'blocked',
    reason: 'Independent additivity of the component fields is unapproved, so component groups cannot carry monetary measures.',
    blockers: Object.freeze(['FC-06', 'FC-07']),
  }),
}) as Record<FixedCostGrouping, FixedCostGroupingAvailability>;

export const isGroupingAvailable = (grouping: FixedCostGrouping): boolean =>
  fixedCostGroupingAvailability[grouping].status === 'structurally_supported_not_activated';

/**
 * Allowlisted sort fields.
 *
 * `truckId` is an immutable integer and is safe to order deterministically.
 * Monetary ordering is deliberately absent from the available set: sorting money
 * would mean comparing decimal strings in JavaScript, so an amount sort must be
 * performed by SQL and belongs to Slice 7B.
 */
export const fixedCostBreakdownSortFields = ['truckId', 'currentAmount', 'lockedAmount'] as const;
export type FixedCostBreakdownSortField = typeof fixedCostBreakdownSortFields[number];

export const fixedCostBreakdownSortAvailability: Record<FixedCostBreakdownSortField, boolean> = Object.freeze({
  truckId: true,
  currentAmount: false,
  lockedAmount: false,
});

/** The immutable tie-breaker appended to every ordering, so pages never overlap or gap. */
export const fixedCostBreakdownTieBreaker = { field: 'truckId', direction: 'asc' } as const;

export const fixedCostBreakdownMaxPageSize = 200;
export const fixedCostBreakdownDefaultPageSize = 50;
/** Hard ceiling on distinct groups before pagination; more than this fails closed. */
export const fixedCostBreakdownMaxGroups = 1000;

export interface TruckFixedCostBreakdownRequest {
  allocationScope: typeof fixedCostBreakdownScope;
  dateFrom: string;
  dateTo: string;
  groupBy: FixedCostGrouping;
  page: number;
  perPage: number;
  sortBy: FixedCostBreakdownSortField;
  sortDirection: 'asc' | 'desc';
  /** Optional bounded allowlist of verified numeric truck identifiers. */
  truckIds?: number[];
}

export const fixedCostBreakdownMaxTruckIds = 50;

const isoDate = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-3][0-9])$/;

function canonicalDate(value: unknown): string {
  if (typeof value !== 'string' || !isoDate.test(value)) throw new InvalidFixedCostQuery();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new InvalidFixedCostQuery();
  return value;
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  // Canonical decimal text only: no signs, whitespace, exponents or coercion.
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) throw new InvalidFixedCostQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new InvalidFixedCostQuery();
  return parsed;
}

/**
 * Strict breakdown request validation.
 *
 * Every accepted parameter is listed here. Unknown parameters, repeated parameters
 * (Fastify yields an array, which is not a string), unsupported groupings or sort
 * fields, unbounded pagination, arbitrary fields, measures, filter expressions,
 * table or column names and SQL-shaped text are all rejected. Nothing internal —
 * deleted-row policy, tolerance, representation, source tables, query limits — is
 * accepted from a request.
 */
export function parseTruckFixedCostBreakdownRequest(input: Record<string, unknown>): TruckFixedCostBreakdownRequest {
  const allowed = new Set(['allocationScope', 'dateFrom', 'dateTo', 'groupBy', 'page', 'perPage', 'sortBy', 'sortDirection', 'truckIds']);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key) || typeof value !== 'string') throw new InvalidFixedCostQuery();
  }

  if (input.allocationScope !== fixedCostBreakdownScope) throw new InvalidFixedCostQuery();

  const dateFrom = canonicalDate(input.dateFrom);
  const dateTo = canonicalDate(input.dateTo);
  if (dateFrom > dateTo) throw new InvalidFixedCostQuery();
  const spanDays = (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000;
  if (spanDays > fixedCostMaximumDateRangeDays) throw new InvalidFixedCostQuery();

  const groupBy = input.groupBy;
  if (typeof groupBy !== 'string' || !(fixedCostGroupings as readonly string[]).includes(groupBy)) {
    throw new InvalidFixedCostQuery();
  }

  const page = boundedInteger(input.page, 1, 100_000);
  const perPage = boundedInteger(input.perPage, fixedCostBreakdownDefaultPageSize, fixedCostBreakdownMaxPageSize);
  if (!Number.isSafeInteger((page - 1) * perPage)) throw new InvalidFixedCostQuery();

  const sortBy = input.sortBy ?? fixedCostBreakdownTieBreaker.field;
  if (typeof sortBy !== 'string' || !(fixedCostBreakdownSortFields as readonly string[]).includes(sortBy)) {
    throw new InvalidFixedCostQuery();
  }
  const sortDirection = input.sortDirection ?? 'asc';
  if (sortDirection !== 'asc' && sortDirection !== 'desc') throw new InvalidFixedCostQuery();

  let truckIds: number[] | undefined;
  if (input.truckIds !== undefined) {
    const raw = input.truckIds;
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}(?:,[1-9][0-9]{0,15})*$/.test(raw)) throw new InvalidFixedCostQuery();
    const parsed = raw.split(',').map(Number);
    if (parsed.length > fixedCostBreakdownMaxTruckIds) throw new InvalidFixedCostQuery();
    truckIds = [];
    for (const value of parsed) {
      if (!Number.isSafeInteger(value) || value <= 0 || truckIds.includes(value)) throw new InvalidFixedCostQuery();
      truckIds.push(value);
    }
  }

  return {
    allocationScope: fixedCostBreakdownScope,
    dateFrom, dateTo,
    groupBy: groupBy as FixedCostGrouping,
    page, perPage,
    sortBy: sortBy as FixedCostBreakdownSortField,
    sortDirection,
    ...(truckIds === undefined ? {} : { truckIds }),
  };
}

/** Per-representation reconciliation evidence for one group. Never netted away. */
export interface TruckFixedCostBreakdownReconciliation {
  status: 'unreconciled' | 'structurally_non_comparable';
  comparableRecords: number;
  affectedRecords: number;
  componentTotal: DecimalString | null;
  netDifference: DecimalString | null;
  grossAbsoluteDifference: DecimalString | null;
  buckets: Record<FixedCostDifferenceBucket, number>;
  noDetailRecords: number;
  multipleDetailRecords: number;
  /**
   * Per-component amounts from this representation's own detail table, keyed by
   * the exact ERP column name. Explanatory only: they sum to `componentTotal` over
   * the same comparable records, not to the authoritative amount. Null without
   * comparable records; absent when the executor did not read components.
   */
  components?: FixedCostComponentAmounts | null;
}

/**
 * One truck group. The identifier is a verified master id, never invented.
 *
 * `taskCount` is the shared population: both representations describe the same
 * tasks, and the orchestration rejects any result where they disagree, so a single
 * count is the honest figure. The lock-state split is nested under `lockStates` to
 * keep it clearly distinct from the *locked representation*, which is a different
 * axis entirely — `lockStates.locked` counts tasks whose lock date is set, while
 * `lockedAmount` is the amount read from the locked source.
 */
export interface TruckFixedCostBreakdownGroup {
  truckId: number;
  /** Stored authoritative totals, read never recomputed. */
  currentAmount: DecimalString | null;
  lockedAmount: DecimalString | null;
  taskCount: number;
  lockStates: { locked: number; unlocked: number; unknown: number };
  reconciliation: { current: TruckFixedCostBreakdownReconciliation; locked: TruckFixedCostBreakdownReconciliation };
}

/**
 * Records whose truck could not be resolved.
 *
 * Kept as a separate structural bucket with no identifier at all. They are never
 * given a placeholder id such as `0`, `-1` or `"unknown"`, and never folded into a
 * real truck's group.
 */
export interface TruckFixedCostBreakdownUnresolved {
  reason: 'truck_unresolved';
  taskCount: number;
  missingTaskCount: number;
  zeroTruckCount: number;
  currentAmount: DecimalString | null;
  lockedAmount: DecimalString | null;
}

export interface FixedCostBreakdownPagination {
  page: number;
  perPage: number;
  groupCount: number;
  pageCount: number;
  maxGroups: number;
}

export interface FixedCostBreakdownSorting {
  sortBy: FixedCostBreakdownSortField;
  sortDirection: 'asc' | 'desc';
  tieBreaker: typeof fixedCostBreakdownTieBreaker;
}

/**
 * Static technical component inventory.
 *
 * Source column names exactly as the schema exposes them. **Explanatory only and
 * semantics-unverified**: no business category is mapped, no component is asserted
 * independently additive, no component total may stand in for an authoritative
 * total, and there is deliberately no synthetic `other` bucket to force a
 * reconciliation to balance.
 */
export const fixedCostComponentInventory = Object.freeze({
  status: 'explanatory_semantics_unverified' as const,
  source: fixedCostBreakdownSources,
  fields: Object.freeze([...fixedCostComponentFields].sort()),
  independentlyAdditive: false as const,
  syntheticResidualBucket: false as const,
  blockers: Object.freeze(['FC-06', 'FC-07']),
});

export interface TruckFixedCostBreakdownMetadata {
  sourceFamily: 'fixed_cost_truck_allocation';
  authoritativeSource: typeof fixedCostAuthoritativeSource;
  breakdownSources: typeof fixedCostBreakdownSources;
  amountSemantics: 'stored_task_level_authoritative_total';
  dateBasis: 'kastai_data';
  semanticsVersion: null;
  classificationVersion: null;
  classificationApplied: false;
  reconciliationStatus: 'unreconciled';
  groupBy: FixedCostGrouping;
  groupingAvailability: typeof fixedCostGroupingAvailability;
  componentInventory: typeof fixedCostComponentInventory;
  pagination: FixedCostBreakdownPagination;
  sorting: FixedCostBreakdownSorting;
  periodMonths: readonly string[];
  complete: boolean;
  deletedRowPolicy: FixedCostDeletedRowPolicy;
  pendingApprovals: readonly string[];
  limitations: readonly string[];
}

export interface TruckFixedCostBreakdownResponse {
  data: {
    allocationScope: typeof fixedCostBreakdownScope;
    dateFrom: string;
    dateTo: string;
    currency: 'EUR';
    groups: readonly TruckFixedCostBreakdownGroup[];
    /** Present only when unresolved-truck records exist; never a fake group. */
    unresolved: TruckFixedCostBreakdownUnresolved | null;
  };
  meta: TruckFixedCostBreakdownMetadata;
}

export const truckFixedCostBreakdownLimitations = orderFixedCostLimitations([
  'Current amounts are live calculations that ERP may recalculate for approximately three months; they are not final results.',
  'Current and locked amounts are separate representations and must never be added together or substituted for one another.',
  'Authoritative totals are read from kastai_fiksuoti_ataskaita and are never recomputed from component fields.',
  'Component fields are explanatory only; their independent additivity is unapproved and no component total may stand in for an authoritative total.',
  'Records whose truck cannot be resolved are reported as a separate unresolved bucket and are never given an invented truck identifier.',
  'No reconciliation against an official ERP report has been accepted, so reconciliationStatus stays unreconciled.',
  'Ordering by a monetary measure requires SQL-side ordering and is not available; money is never sorted in JavaScript.',
  'kastai_fiksuoti_ataskaita has no production-suitable index on kastai_data; month filtering scans approximately 1.56 million summary rows.',
]);

export const truckFixedCostBreakdownPendingApprovals = Object.freeze([
  'FC-02', 'FC-03', 'FC-06', 'FC-07', 'FC-11', 'FC-14', 'FC-P17', 'FC-P19',
] as const);

export type TruckFixedCostBreakdownBlockedReason =
  | 'grouping_blocked'
  | 'grouping_not_activated'
  | 'sort_field_unavailable'
  | 'group_count_exceeded'
  | 'incomplete_grouping'
  | 'page_out_of_range';

export class TruckFixedCostBreakdownUnavailable extends Error {
  constructor(readonly reason: TruckFixedCostBreakdownBlockedReason, readonly blockers: readonly string[]) {
    super(`Truck fixed-cost breakdown unavailable: ${reason} (${blockers.join(', ')})`);
    this.name = 'TruckFixedCostBreakdownUnavailable';
  }
}
