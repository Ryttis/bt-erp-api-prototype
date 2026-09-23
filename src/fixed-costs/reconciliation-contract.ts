/** Bounded closed-period truck reconciliation input and output vocabulary.
 *
 * Separate from both the public monetary request contract and the Slice 2/3A
 * per-task diagnostic contract. Nothing here approves a business rule: the
 * categories below describe exact database comparisons over a bounded sample.
 */

/** Tasks read per reconciliation month. A sentinel row above the bound detects truncation. */
export const fixedCostReconciliationTaskLimit = 5000;

/**
 * Implementation safety value, not an approved Finance tolerance (FC-14/FC-P04).
 * Expressed in the stored `decimal(13,2)` scale of the compared columns and applied
 * as exact decimal arithmetic in SQL, never as JavaScript floating point.
 */
export const fixedCostReconciliationToleranceEur = '0.01';

/**
 * Conservative settlement bound. ERP confirmed on 2026-09-23 that recent values can
 * continue recalculating for approximately three months; this doubles that window
 * before a month may be reconciled. It is a safety margin, not an ERP-approved
 * close-of-period rule.
 */
export const fixedCostReconciliationSettlementMonths = 6;

export interface FixedCostReconciliationInput {
  /** Canonical first day of the reconciled month, `YYYY-MM-01`. */
  month: string;
  /** Exclusive first day of the following month, bound as the upper month limit. */
  monthEnd: string;
}

export class InvalidFixedCostReconciliationMonth extends Error {
  constructor() {
    super(`Expected a settled calendar month as YYYY-MM-01, at least ${fixedCostReconciliationSettlementMonths} months before the current month`);
    this.name = 'InvalidFixedCostReconciliationMonth';
  }
}

const monthPattern = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-01$/;

const firstOfMonthUtc = (year: number, month: number) => Date.UTC(year, month, 1);
const isoDay = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

/**
 * Strict canonical month text only; no coercion, offsets, timezones or partial dates.
 * `now` is injectable so the settlement bound is testable without clock manipulation.
 */
export function parseFixedCostReconciliationMonth(value: unknown, now: Date = new Date()): FixedCostReconciliationInput {
  if (typeof value !== 'string') throw new InvalidFixedCostReconciliationMonth();
  const match = monthPattern.exec(value);
  if (!match) throw new InvalidFixedCostReconciliationMonth();
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = firstOfMonthUtc(year, monthIndex);
  if (!Number.isFinite(start) || isoDay(start) !== value) throw new InvalidFixedCostReconciliationMonth();

  // Reject any month that is not strictly older than the settlement window.
  const reference = now.getTime();
  if (!Number.isFinite(reference)) throw new InvalidFixedCostReconciliationMonth();
  const current = new Date(reference);
  const latestAllowed = firstOfMonthUtc(current.getUTCFullYear(), current.getUTCMonth() - fixedCostReconciliationSettlementMonths);
  if (start > latestAllowed) throw new InvalidFixedCostReconciliationMonth();

  return { month: value, monthEnd: isoDay(firstOfMonthUtc(year, monthIndex + 1)) };
}

// Exact database comparisons only. No category asserts reportability, authority or
// correctness; `exact` means binary decimal equality, not Finance acceptance.
const detailCardinality = ['none', 'one', 'multiple'] as const;
const componentComparison = ['no_details', 'exact', 'within_tolerance', 'outside_tolerance'] as const;

export const fixedCostReconciliationCategories = {
  task: ['present', 'missing'],
  assignedTruck: ['missing', 'zero', 'populated_with_master', 'populated_without_master'],
  // Raw tinyint(1) state; the meaning of `deleted` remains unapproved (FC-03).
  deletedFlag: ['zero', 'one', 'other'],
  // ERP confirmed `0000-00-00` marks an unlocked truck result (2026-09-23).
  lockState: ['zero_date', 'valid_date', 'other'],
  currentDetail: detailCardinality,
  lockedDetail: detailCardinality,
  // Current summary total versus the current component sum, and locked versus locked.
  currentComponents: componentComparison,
  lockedComponents: componentComparison,
} as const;

export type FixedCostReconciliationCategories = {
  [K in keyof typeof fixedCostReconciliationCategories]: Record<typeof fixedCostReconciliationCategories[K][number], number>;
};

/**
 * Absolute-difference buckets over `ABS(stored_total - component_sum)`.
 *
 * Every boundary below is an inclusive upper bound in EUR at the stored
 * `decimal(13,2)` scale, and every classification happens in SQL decimal
 * arithmetic. No monetary value is converted to a JavaScript number at any point;
 * only the resulting integer counts cross the boundary.
 *
 * `exact` is binary decimal equality. The remaining names describe magnitude only
 * and carry no Finance judgement about acceptability.
 */
export const fixedCostDifferenceBuckets = ['exact', 'rounding', 'small', 'moderate', 'material', 'large'] as const;

/**
 * The single ordered source for both the SQL ladder and the verification classifier
 * below, so the two can never drift. `maxEur` is the inclusive upper bound of the
 * bucket; `large` is unbounded above.
 */
export const fixedCostDifferenceLadder = [
  { bucket: 'exact', maxEur: '0.00' },
  { bucket: 'rounding', maxEur: '0.01' },
  { bucket: 'small', maxEur: '1.00' },
  { bucket: 'moderate', maxEur: '10.00' },
  { bucket: 'material', maxEur: '100.00' },
  { bucket: 'large', maxEur: null },
] as const satisfies readonly { bucket: typeof fixedCostDifferenceBuckets[number]; maxEur: string | null }[];

/** Exact `decimal(13,2)` text to integer cents. No float is ever produced. */
export function eurStringToCents(value: string): number {
  const match = /^(0|[1-9][0-9]{0,11})\.([0-9]{2})$/.exec(value);
  if (!match) throw new Error('Expected a canonical decimal(13,2) EUR string');
  return Number(match[1]) * 100 + Number(match[2]);
}

/**
 * Verification classifier mirroring the SQL ladder over integer cents.
 *
 * Production classification happens in SQL decimal arithmetic; this exists so the
 * boundaries are testable and auditable offline. It applies the same absolute value
 * as SQL `ABS`, so a negative raw difference classifies by magnitude.
 */
export function classifyFixedCostDifferenceCents(cents: number): typeof fixedCostDifferenceBuckets[number] {
  if (!Number.isSafeInteger(cents)) throw new Error('Difference classification requires integer cents');
  const absolute = Math.abs(cents);
  for (const { bucket, maxEur } of fixedCostDifferenceLadder) {
    if (maxEur === null || absolute <= eurStringToCents(maxEur)) return bucket;
  }
  throw new Error('Unreachable difference bucket');
}

/**
 * Structurally non-comparable rows. These are counted and reported separately and
 * are never placed in a monetary bucket, so they cannot dilute a difference
 * distribution. `missing_total` is unreachable while the summary columns remain
 * NOT NULL, but the vocabulary stays explicit rather than assuming the schema.
 */
export const fixedCostDifferenceNonComparable = ['no_details', 'multiple_details', 'missing_total', 'other'] as const;

export type FixedCostDifferenceBucket = typeof fixedCostDifferenceBuckets[number];
export type FixedCostDifferenceNonComparableClass = typeof fixedCostDifferenceNonComparable[number];
export type FixedCostDifferenceClass = FixedCostDifferenceBucket | FixedCostDifferenceNonComparableClass;

/** Integer counts only; the unit that quarterly and yearly aggregation combines. */
export type FixedCostDifferenceCounts = Record<FixedCostDifferenceClass, number>;

export interface FixedCostBucketShare {
  count: number;
  /** Share of rows with exactly one usable detail row. `null` when none exist. */
  percentageOfComparable: number | null;
  /** Share of the bounded sample after the truncation sentinel is removed. `null` when empty. */
  percentageOfAllSampled: number | null;
  /** Share relative to the exact-match count; `exact` is 100. `null` when no exact match exists. */
  relativeToExactPercentage: number | null;
}

export interface FixedCostDifferenceDistribution {
  buckets: Record<FixedCostDifferenceBucket, FixedCostBucketShare>;
  nonComparable: Record<FixedCostDifferenceNonComparableClass, number>;
  comparableCount: number;
  sampledCount: number;
}

export const emptyFixedCostDifferenceCounts = (): FixedCostDifferenceCounts => Object.fromEntries(
  [...fixedCostDifferenceBuckets, ...fixedCostDifferenceNonComparable].map(name => [name, 0]),
) as FixedCostDifferenceCounts;

/**
 * Deterministic percentage from two integer counts, half-up to two decimals.
 *
 * A zero denominator returns `null` rather than dividing by zero, `Infinity` or a
 * silent zero. The multiplication stays in integers, so no count is ever rounded
 * through an intermediate float.
 */
export function percentageOf(count: number, denominator: number): number | null {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(denominator) || count < 0 || denominator < 0) {
    throw new Error('Fixed-cost percentages require non-negative integer counts');
  }
  if (denominator === 0) return null;
  return Math.round((count * 10000) / denominator) / 100;
}

/** Sums monthly counts before any percentage exists. Percentages are never averaged. */
export function combineFixedCostDifferenceCounts(entries: readonly FixedCostDifferenceCounts[]): FixedCostDifferenceCounts {
  const combined = emptyFixedCostDifferenceCounts();
  for (const entry of entries) {
    for (const name of [...fixedCostDifferenceBuckets, ...fixedCostDifferenceNonComparable]) {
      const value = entry[name];
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Fixed-cost difference counts must be non-negative integers');
      combined[name] += value;
    }
  }
  return combined;
}

/** Derives every share from summed counts, so aggregation order cannot change a result. */
export function describeFixedCostDifferences(counts: FixedCostDifferenceCounts): FixedCostDifferenceDistribution {
  const comparableCount = fixedCostDifferenceBuckets.reduce((total, name) => total + counts[name], 0);
  const sampledCount = comparableCount + fixedCostDifferenceNonComparable.reduce((total, name) => total + counts[name], 0);
  const exact = counts.exact;
  return {
    buckets: Object.fromEntries(fixedCostDifferenceBuckets.map(name => [name, {
      count: counts[name],
      percentageOfComparable: percentageOf(counts[name], comparableCount),
      percentageOfAllSampled: percentageOf(counts[name], sampledCount),
      relativeToExactPercentage: percentageOf(counts[name], exact),
    }])) as Record<FixedCostDifferenceBucket, FixedCostBucketShare>,
    nonComparable: Object.fromEntries(
      fixedCostDifferenceNonComparable.map(name => [name, counts[name]]),
    ) as Record<FixedCostDifferenceNonComparableClass, number>,
    comparableCount,
    sampledCount,
  };
}

export type FixedCostPeriodGranularity = 'month' | 'quarter' | 'year' | 'total';

export interface FixedCostPeriodCounts {
  month: string;
  counts: FixedCostDifferenceCounts;
}

export interface FixedCostPeriodDistribution {
  period: string;
  months: number;
  counts: FixedCostDifferenceCounts;
  distribution: FixedCostDifferenceDistribution;
}

/** `2025-03-01` becomes `2025-03`, `2025-Q1`, `2025` or `total`. */
export function fixedCostPeriodKey(month: string, granularity: FixedCostPeriodGranularity): string {
  if (!/^[1-9][0-9]{3}-(0[1-9]|1[0-2])-01$/.test(month)) throw new Error('Fixed-cost period keys require a canonical YYYY-MM-01 month');
  if (granularity === 'total') return 'total';
  const [year, monthText] = month.split('-');
  if (granularity === 'year') return year;
  if (granularity === 'month') return `${year}-${monthText}`;
  return `${year}-Q${Math.floor((Number(monthText) - 1) / 3) + 1}`;
}

/**
 * Groups monthly counts into the requested granularity, summing counts first and
 * computing every percentage afterwards from the combined totals. Monthly
 * percentages are never averaged, so a small month cannot outweigh a large one.
 */
export function aggregateFixedCostDifferences(
  entries: readonly FixedCostPeriodCounts[],
  granularity: FixedCostPeriodGranularity,
): FixedCostPeriodDistribution[] {
  const grouped = new Map<string, FixedCostDifferenceCounts[]>();
  for (const entry of entries) {
    const key = fixedCostPeriodKey(entry.month, granularity);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry.counts); else grouped.set(key, [entry.counts]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([period, list]) => {
      const counts = combineFixedCostDifferenceCounts(list);
      return { period, months: list.length, counts, distribution: describeFixedCostDifferences(counts) };
    });
}

export interface FixedCostReconciliationResult {
  /** Counters only. No task ID, truck identifier, date or monetary amount is carried. */
  data: FixedCostReconciliationCategories;
  /** Raw per-class counts, kept so quarterly and yearly aggregation combines counts. */
  counts: { current: FixedCostDifferenceCounts; locked: FixedCostDifferenceCounts };
  /** Current is derived only from current detail, locked only from locked detail. */
  differences: { current: FixedCostDifferenceDistribution; locked: FixedCostDifferenceDistribution };
  meta: {
    month: string;
    /** Hard per-month task bound. */
    taskLimit: number;
    /** Rows actually counted: at most `taskLimit`, with the truncation sentinel excluded. */
    sampledTaskCount: number;
    /** Rows the bounded query returned, including the sentinel when the month overflows. */
    fetchedTaskCount: number;
    /** True when the month holds more tasks than `taskLimit`. */
    truncated: boolean;
    complete: boolean;
    toleranceEur: string;
    settlementMonths: number;
    /** Reconciliation is structural evidence; Finance acceptance is recorded separately. */
    reconciliationStatus: 'unreconciled_pending_erp_reference';
  };
}
