import {
  fixedCostDifferenceBuckets, parseFixedCostReconciliationMonth,
  type FixedCostDifferenceBucket,
} from './reconciliation-contract.js';

/**
 * Internal truck fixed-cost monetary contract (Slice 5).
 *
 * Implementation model, recorded as an engineering decision and **not** as a
 * completed reconciliation against an official ERP report:
 *
 * - `kastai_fiksuoti_ataskaita` is the authoritative task-level total.
 * - `kastai_fiksuoti_vilkikai_det` explains the current total as components.
 * - `kastai_fiksuoti_vilkikai_det_locked` explains the locked total.
 *
 * The authoritative total is always read from the summary table. It is never
 * recalculated by summing components, and current and locked are never mixed.
 * Component differences stay explicit and are never folded into an invented
 * category. No public endpoint reaches this module; all five allocation scopes
 * remain behind `SEMANTICS_UNVERIFIED`.
 */

/**
 * Canonical fixed-scale decimal text, exactly as the database rendered it.
 *
 * Monetary values never become a JavaScript `number`. Subtraction, absolute value
 * and summation all happen in SQL `DECIMAL` arithmetic, and the result is cast to
 * CHAR before it crosses the driver boundary.
 */
export type DecimalString = string;

/** Rejects anything that is not plain signed decimal text at a bounded scale. */
const decimalPattern = /^-?(0|[1-9][0-9]{0,24})\.[0-9]{1,6}$/;

export function assertDecimalString(value: unknown, field: string): DecimalString {
  if (typeof value !== 'string' || !decimalPattern.test(value)) {
    throw new InvalidFixedCostMonetaryResult(`Expected canonical decimal text for ${field}`);
  }
  return value;
}

export const fixedCostAuthoritativeSource = 'kastai_fiksuoti_ataskaita' as const;
export const fixedCostBreakdownSources = {
  current: 'kastai_fiksuoti_vilkikai_det',
  locked: 'kastai_fiksuoti_vilkikai_det_locked',
} as const;

export type FixedCostRepresentation = keyof typeof fixedCostBreakdownSources;
export const fixedCostRepresentations = Object.keys(fixedCostBreakdownSources) as FixedCostRepresentation[];

/** Declared `deleted` state, reported separately because its meaning is unapproved (FC-03). */
export const fixedCostDeletedStates = ['zero', 'one', 'other'] as const;
export type FixedCostDeletedState = typeof fixedCostDeletedStates[number];

/** Hard ceilings. The per-query limit is bounded by `fixedCostMonetaryMaxRecords`. */
export const fixedCostMonetaryDefaultRecords = 5000;
export const fixedCostMonetaryMaxRecords = 50000;
export const fixedCostMonetaryMaxTruckIds = 50;

export class InvalidFixedCostMonetaryQuery extends Error {
  constructor(message = 'Invalid internal fixed-cost monetary query') {
    super(message);
    this.name = 'InvalidFixedCostMonetaryQuery';
  }
}

export class InvalidFixedCostMonetaryResult extends Error {
  constructor(message = 'Invalid internal fixed-cost monetary result') {
    super(message);
    this.name = 'InvalidFixedCostMonetaryResult';
  }
}

export interface FixedCostMonetaryQuery {
  allocationScope: 'truck';
  representation: FixedCostRepresentation;
  /** Canonical settled month, validated by the Slice 4 month contract. */
  periodMonth: string;
  /** Exclusive next-month bound, derived, never supplied. */
  periodEnd: string;
  /** Optional bounded allowlist of numeric truck identifiers. */
  truckIds?: number[];
  /** Deterministic record bound; a truncated month never yields a monetary result. */
  limit: number;
}

/**
 * Strict internal query validation.
 *
 * Only the fields below exist. There is no field, filter, grouping, sorting,
 * measure, table, column or expression input of any kind, so no caller and no
 * model can influence the generated SQL beyond bound values.
 */
export function parseFixedCostMonetaryQuery(input: unknown, now?: Date): FixedCostMonetaryQuery {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new InvalidFixedCostMonetaryQuery();
  }
  const allowed = new Set(['allocationScope', 'representation', 'periodMonth', 'truckIds', 'limit']);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new InvalidFixedCostMonetaryQuery();
  }
  const source = input as Record<string, unknown>;

  if (source.allocationScope !== 'truck') throw new InvalidFixedCostMonetaryQuery('Only the truck allocation scope is implemented');
  const representation = source.representation;
  if (typeof representation !== 'string' || !(fixedCostRepresentations as string[]).includes(representation)) {
    throw new InvalidFixedCostMonetaryQuery('An explicit current or locked representation is required');
  }

  // Reuses the Slice 4 canonical-month and settlement rules; no second date parser.
  let period;
  try {
    period = parseFixedCostReconciliationMonth(source.periodMonth, now);
  } catch {
    throw new InvalidFixedCostMonetaryQuery('A canonical settled YYYY-MM-01 period is required');
  }

  const limit = source.limit ?? fixedCostMonetaryDefaultRecords;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > fixedCostMonetaryMaxRecords) {
    throw new InvalidFixedCostMonetaryQuery('Limit must be a positive integer within the hard maximum');
  }

  let truckIds: number[] | undefined;
  if (source.truckIds !== undefined) {
    const values = source.truckIds;
    if (!Array.isArray(values) || values.length < 1 || values.length > fixedCostMonetaryMaxTruckIds) {
      throw new InvalidFixedCostMonetaryQuery('Truck identifiers must be a bounded non-empty list');
    }
    truckIds = [];
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || truckIds.includes(value)) {
        throw new InvalidFixedCostMonetaryQuery('Truck identifiers must be distinct positive safe integers');
      }
      truckIds.push(value);
    }
  }

  return {
    allocationScope: 'truck',
    representation: representation as FixedCostRepresentation,
    periodMonth: period.month,
    periodEnd: period.monthEnd,
    ...(truckIds === undefined ? {} : { truckIds }),
    limit,
  };
}

/**
 * Unresolved `deleted` row policy (FC-03).
 *
 * Two independent safeguards, both active:
 *
 * 1. Results are **always** separated by declared `deleted` state, so no policy
 *    choice can silently merge states into one authoritative figure.
 * 2. Aggregation refuses to execute until an approved policy is supplied by an
 *    internal caller. The registration below is unapproved, so the default path
 *    fails closed before any replica access.
 *
 * The policy is a module-level registration injected by internal callers. It is
 * not a request field, is absent from every public contract, and cannot be chosen
 * by a model or an API consumer.
 */
export type FixedCostDeletedRowTreatment = 'separate_by_state' | 'exclude_deleted' | 'include_all';

export interface FixedCostDeletedRowPolicy {
  treatment: FixedCostDeletedRowTreatment;
  approved: boolean;
  approvedBy: string | null;
  /** Open question this policy is blocked on. */
  reference: string;
}

export const unapprovedFixedCostDeletedRowPolicy: FixedCostDeletedRowPolicy = Object.freeze({
  treatment: 'separate_by_state',
  approved: false,
  approvedBy: null,
  reference: 'FC-03',
});

export class FixedCostDeletedPolicyUnapproved extends Error {
  constructor() {
    super('Fixed-cost monetary aggregation requires an approved deleted-row policy (FC-03)');
    this.name = 'FixedCostDeletedPolicyUnapproved';
  }
}

export function assertApprovedDeletedRowPolicy(policy: FixedCostDeletedRowPolicy): void {
  if (policy === null || typeof policy !== 'object') throw new FixedCostDeletedPolicyUnapproved();
  if (policy.approved !== true || typeof policy.approvedBy !== 'string' || policy.approvedBy.trim() === '') {
    throw new FixedCostDeletedPolicyUnapproved();
  }
  if (!(['separate_by_state', 'exclude_deleted', 'include_all'] as string[]).includes(policy.treatment)) {
    throw new FixedCostDeletedPolicyUnapproved();
  }
}

/**
 * One declared-row-state group.
 *
 * `authoritativeTotal` covers every in-scope record of this state, including
 * structurally non-comparable ones, so no record is silently dropped from the
 * authoritative population. `componentTotal` covers only comparable records, so
 * `comparableAuthoritativeTotal` is the correct counterpart for any comparison.
 * Comparing `authoritativeTotal` with `componentTotal` directly compares two
 * different populations and is never valid.
 *
 * When a group has no comparable record, every comparison field is `null` rather
 * than `0.00`. A fabricated zero would read as "the components reconcile exactly",
 * which is the opposite of "there is nothing to compare". The SQL uses
 * `SUM(CASE WHEN comparable = 1 THEN value ELSE NULL END)`, so an empty comparable
 * population yields SQL NULL instead of an additive-identity zero.
 */
export type FixedCostGroupReconciliation = 'unreconciled' | 'structurally_non_comparable';

export interface FixedCostMonetaryGroup {
  deletedState: FixedCostDeletedState;
  /** `structurally_non_comparable` whenever `comparableRecords` is zero. */
  reconciliationStatus: FixedCostGroupReconciliation;
  authoritativeRecords: number;
  /** Null only when no record of this state carries a stored total at all. */
  authoritativeTotal: DecimalString | null;
  comparableRecords: number;
  comparableAuthoritativeTotal: DecimalString | null;
  componentTotal: DecimalString | null;
  /** Signed sum of (authoritative - component) over comparable records. */
  netDifference: DecimalString | null;
  /** Sum of absolute per-record differences, so opposite signs cannot cancel. */
  grossAbsoluteDifference: DecimalString | null;
  /** Comparable records whose difference is not exactly zero. */
  affectedRecords: number;
  buckets: Record<FixedCostDifferenceBucket, number>;
  noDetailRecords: number;
  multipleDetailRecords: number;
  missingTotalRecords: number;
  /** Records of this state whose task is absent from `uzdaviniai`. */
  missingTaskCount: number;
  /**
   * Declared lock state, from the ERP-confirmed sentinel (FCB-05): a
   * `locked_kastaiVilkiko_data` of `0000-00-00` means the truck result is not
   * locked. Any other unusable date is counted as `unknownLockRecords` rather than
   * guessed in either direction. The three always cover `authoritativeRecords`.
   */
  lockedRecords: number;
  unlockedRecords: number;
  unknownLockRecords: number;
}

export interface FixedCostMonetaryResult {
  groups: FixedCostMonetaryGroup[];
  meta: {
    allocationScope: 'truck';
    representation: FixedCostRepresentation;
    periodMonth: string;
    /**
     * The reporting period is always filtered on the cost month, for both the
     * current and the locked representation (FCB-06). `locked_kastaiVilkiko_data`
     * is lock-event metadata and is never used as the reporting-period filter.
     */
    dateBasis: 'kastai_data';
    currency: 'EUR';
    authoritativeSource: typeof fixedCostAuthoritativeSource;
    breakdownSource: typeof fixedCostBreakdownSources[FixedCostRepresentation];
    /** Verified ERP component field identifiers; no business grouping is applied. */
    componentFields: readonly string[];
    classificationApplied: false;
    /** Never invented; cost-group classification does not exist yet (FC-P10). */
    classificationVersion: null;
    /** Never invented; no semantic version is approved. */
    semanticsVersion: null;
    recordLimit: number;
    recordsRead: number;
    /** Summary records across all states whose task is absent from `uzdaviniai`. */
    missingTaskCount: number;
    /** True when a bounded truck allowlist was applied, which excludes orphan rows. */
    truckFilterApplied: boolean;
    truncated: false;
    complete: boolean;
    deletedRowPolicy: FixedCostDeletedRowPolicy;
    reconciliationStatus: 'unreconciled';
    pendingApprovals: readonly string[];
    limitations: readonly string[];
  };
}

/** Open questions that must close before any of this can become a public result. */
export const fixedCostMonetaryPendingApprovals = [
  'FC-03', 'FC-06', 'FC-07', 'FC-11', 'FC-13', 'FC-14', 'FC-15', 'FC-P17',
] as const;

export const fixedCostMonetaryLimitations = [
  'Authoritative totals are read from the summary table and are never recomputed from components.',
  'authoritativeTotal spans every in-scope record; componentTotal spans comparable records only. Compare componentTotal with comparableAuthoritativeTotal.',
  'Records without exactly one matching detail row are counted but never bucketed and never given a fabricated zero component total.',
  'A group with no comparable record reports null comparison fields, never 0.00, and is marked structurally_non_comparable.',
  'The reporting period is filtered on kastai_data for both representations; locked_kastaiVilkiko_data is lock-event metadata, never the period filter.',
  'Summary rows whose task is absent from uzdaviniai stay in the authoritative population and are counted by missingTaskCount. A truck filter cannot map them, so it excludes them deterministically.',
  'No reconciliation against an official ERP report has been performed (FC-11).',
  'No cost-group classification is applied and no classificationVersion exists.',
  'kastai_fiksuoti_ataskaita has no index on kastai_data, so month-scoped access is not production-ready (FC-P17).',
] as const;

export const emptyFixedCostBucketCounts = (): Record<FixedCostDifferenceBucket, number> =>
  Object.fromEntries(fixedCostDifferenceBuckets.map(name => [name, 0])) as Record<FixedCostDifferenceBucket, number>;
