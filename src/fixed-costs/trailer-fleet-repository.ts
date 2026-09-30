import type { AnalyticsGate } from '../analytics-gate.js';
import { queryReadOnly, type ReplicaPool } from '../db/replica.js';
import { ApiError } from '../errors.js';
import {
  assertApprovedDeletedRowPolicy, assertDecimalString, fixedCostDeletedStates, fixedCostMonetaryMaxRecords,
  FixedCostDeletedPolicyUnapproved, InvalidFixedCostMonetaryQuery, InvalidFixedCostMonetaryResult,
  unapprovedFixedCostDeletedRowPolicy,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostDeletedState,
} from './monetary-contract.js';
import { counter, FixedCostMonetaryError, FixedCostMonetaryTruncated, validLockDate } from './monetary-repository.js';
import { parseFixedCostReconciliationMonth } from './reconciliation-contract.js';

/**
 * Internal fleet-wide trailer fixed-cost repository (MP-8).
 *
 * Two statements, both module constants: no caller text, identifier or option ever
 * reaches the SQL, and the only bound values are the two period bounds. The truck
 * statements and the single-trailer statement are not touched.
 *
 * - Population: every `kastai_fiksuoti_ataskaita` row of the cost month. Both joins
 *   are LEFT JOINs on a primary key, so no summary row is dropped or duplicated.
 * - Amount: the stored `locked_kastaiPriekabos`, read and never recomputed from the
 *   detail tables, which these statements do not read at all.
 * - Attribution: only the numeric task trailer `uzdaviniai.uzdavinio_priekaba`. A row
 *   that cannot be attributed stays in the population under exactly one unattributed
 *   category. It is never given an identifier, never redistributed, and neither
 *   `uzd_pr_vaziavo` nor any registration text is read.
 *
 * All monetary arithmetic, comparison and ordering happens in SQL `DECIMAL`; amounts
 * cross the driver boundary as canonical decimal text only.
 */

/** Why a summary row has no attributable trailer. Mutually exclusive, in this precedence. */
export const trailerFleetUnattributedCategories = ['missing_task', 'missing_assignment', 'invalid_master_id'] as const;
export type TrailerFleetUnattributedCategory = typeof trailerFleetUnattributedCategories[number];

/** Hard ceiling on distinct trailer groups; more than this fails closed, never a partial list. */
export const trailerFleetMaxGroups = 20000;

/**
 * One classified row per summary record of the month. The record bound and the
 * truncation probe (`LIMIT bound + 1`) are the truck repository's, unchanged.
 */
const classifiedPopulation = `SELECT
      CASE WHEN s.deleted = 0 THEN 'zero' WHEN s.deleted = 1 THEN 'one' ELSE 'other' END AS deletedState,
      s.authoritative,
      -- The '0000-00-00' unlocked sentinel is ERP-confirmed for the truck lock date
      -- (FCB-05) and applied to the trailer lock date by structural analogy. Any
      -- other unusable date stays 'unknown' rather than being guessed.
      CASE WHEN s.lockDate IS NULL THEN 'unknown'
        WHEN CAST(s.lockDate AS CHAR) = '0000-00-00' THEN 'unlocked'
        WHEN ${validLockDate('s.lockDate')} THEN 'locked' ELSE 'unknown' END AS lockState,
      CASE WHEN s.taskId IS NULL THEN 'missing_task'
        WHEN s.assignedTrailer IS NULL OR s.assignedTrailer <= 0 THEN 'missing_assignment'
        WHEN s.masterTrailer IS NULL THEN 'invalid_master_id'
        ELSE 'attributed' END AS attribution,
      s.assignedTrailer
    FROM (
      SELECT a.deleted, a.locked_kastaiPriekabos AS authoritative, a.locked_kastaiPriekabos_data AS lockDate,
        t.id AS taskId, t.uzdavinio_priekaba AS assignedTrailer, p.id AS masterTrailer
      FROM kastai_fiksuoti_ataskaita a
      LEFT JOIN uzdaviniai t ON t.id = a.uzdavinys
      LEFT JOIN priekabos p ON p.id = t.uzdavinio_priekaba
      WHERE a.kastai_data >= ? AND a.kastai_data < ?
      ORDER BY a.uzdavinys
      LIMIT ${fixedCostMonetaryMaxRecords + 1}
    ) s`;

const count = (condition: string, alias: string) => `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS ${alias}`;
// ELSE 0.00 keeps the DECIMAL scale and makes an empty bucket a real stored-scale zero.
const amount = (condition: string) => `SUM(CASE WHEN ${condition} THEN r.authoritative ELSE 0.00 END)`;
const bucket = (condition: string, prefix: string) => [
  count(condition, `${prefix}Records`),
  count(`${condition} AND r.authoritative <> 0`, `${prefix}NonZeroRecords`),
  `CAST(${amount(condition)} AS CHAR) AS ${prefix}Total`,
];
const attributed = "r.attribution = 'attributed'";
const unattributed = "r.attribution <> 'attributed'";

/**
 * Totals per declared `deleted` state. `reconciles` is the accounting invariant,
 * evaluated by the database in DECIMAL: the stored total equals attributed plus
 * unattributed, and the unattributed amount equals its three categories.
 */
export const trailerFleetTotalsStatement = `SELECT r.deletedState,
    COUNT(*) AS authoritativeRecords,
    CAST(SUM(r.authoritative) AS CHAR) AS authoritativeTotal,
    ${count('r.authoritative IS NULL', 'missingTotalRecords')},
    ${count("r.lockState = 'unlocked'", 'unlockedRecords')},
    ${count("r.lockState = 'locked'", 'lockedRecords')},
    ${count("r.lockState = 'unknown'", 'unknownLockRecords')},
    ${count(attributed, 'attributedRecords')},
    COUNT(DISTINCT CASE WHEN ${attributed} THEN r.assignedTrailer ELSE NULL END) AS attributedTrailers,
    CAST(${amount(attributed)} AS CHAR) AS attributedTotal,
    ${bucket(unattributed, 'unattributed').join(',\n    ')},
    ${trailerFleetUnattributedCategories.flatMap(category => bucket(`r.attribution = '${category}'`, category)).join(',\n    ')},
    CASE WHEN SUM(r.authoritative) = ${amount(attributed)} + ${amount(unattributed)}
      AND ${amount(unattributed)} = ${trailerFleetUnattributedCategories.map(category => amount(`r.attribution = '${category}'`)).join(' + ')}
      THEN 1 ELSE 0 END AS reconciles
  FROM (
    ${classifiedPopulation}
  ) r
  GROUP BY r.deletedState
  ORDER BY r.deletedState`;

/**
 * One row per attributed trailer of the included (`deleted = 0`) population, ordered
 * by the database: stored amount descending, then the immutable trailer id.
 */
export const trailerFleetGroupsStatement = `SELECT r.assignedTrailer AS trailerId,
    COUNT(*) AS taskCount,
    CAST(SUM(r.authoritative) AS CHAR) AS lockedAmount
  FROM (
    ${classifiedPopulation}
  ) r
  WHERE r.deletedState = 'zero' AND ${attributed}
  GROUP BY r.assignedTrailer
  ORDER BY SUM(r.authoritative) DESC, r.assignedTrailer ASC
  LIMIT ${trailerFleetMaxGroups + 1}`;

export interface TrailerFleetBucket {
  records: number;
  /** Records whose stored amount is not exactly zero, positive or negative. */
  nonZeroRecords: number;
  total: DecimalString;
}

export interface TrailerFleetStateTotals {
  deletedState: FixedCostDeletedState;
  authoritativeRecords: number;
  /** Null only when no record of this state carries a stored total. */
  authoritativeTotal: DecimalString | null;
  missingTotalRecords: number;
  lockedRecords: number;
  unlockedRecords: number;
  unknownLockRecords: number;
  attributedRecords: number;
  attributedTrailers: number;
  attributedTotal: DecimalString;
  unattributed: TrailerFleetBucket;
  categories: Record<TrailerFleetUnattributedCategory, TrailerFleetBucket>;
  /** Database-evaluated: total = attributed + unattributed, and unattributed = its categories. */
  reconciles: boolean;
}

export interface TrailerFleetGroup {
  trailerId: number;
  taskCount: number;
  lockedAmount: DecimalString;
}

export interface TrailerFleetTotalsResult {
  periodMonth: string;
  states: TrailerFleetStateTotals[];
  recordLimit: number;
  recordsRead: number;
  complete: true;
  truncated: false;
  deletedRowPolicy: FixedCostDeletedRowPolicy;
}

function projectBucket(row: Record<string, unknown>, prefix: string, records: number): TrailerFleetBucket {
  const bucketRecords = counter(row, `${prefix}Records`);
  const nonZeroRecords = counter(row, `${prefix}NonZeroRecords`);
  if (bucketRecords > records || nonZeroRecords > bucketRecords) {
    throw new InvalidFixedCostMonetaryResult(`Inconsistent ${prefix} record counts`);
  }
  return { records: bucketRecords, nonZeroRecords, total: assertDecimalString(row[`${prefix}Total`], `${prefix}Total`) };
}

function projectState(row: Record<string, unknown>): TrailerFleetStateTotals {
  // A null or non-object driver row is malformed output, never an empty state.
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new InvalidFixedCostMonetaryResult('Unexpected driver row');
  const deletedState = row.deletedState;
  if (typeof deletedState !== 'string' || !(fixedCostDeletedStates as readonly string[]).includes(deletedState)) {
    throw new InvalidFixedCostMonetaryResult('Unrecognized declared row state');
  }
  const authoritativeRecords = counter(row, 'authoritativeRecords');
  const missingTotalRecords = counter(row, 'missingTotalRecords');
  const lockedRecords = counter(row, 'lockedRecords');
  const unlockedRecords = counter(row, 'unlockedRecords');
  const unknownLockRecords = counter(row, 'unknownLockRecords');
  const attributedRecords = counter(row, 'attributedRecords');
  const attributedTrailers = counter(row, 'attributedTrailers');
  const unattributedBucket = projectBucket(row, 'unattributed', authoritativeRecords);
  const categories = Object.fromEntries(trailerFleetUnattributedCategories
    .map(category => [category, projectBucket(row, category, unattributedBucket.records)])) as Record<TrailerFleetUnattributedCategory, TrailerFleetBucket>;
  const categoryList = Object.values(categories);

  if (missingTotalRecords > authoritativeRecords) throw new InvalidFixedCostMonetaryResult('Missing totals exceed the population');
  if (lockedRecords + unlockedRecords + unknownLockRecords !== authoritativeRecords) {
    throw new InvalidFixedCostMonetaryResult('Lock states do not cover the authoritative population');
  }
  // Every record is attributed or unattributed, and every unattributed record has exactly one category.
  if (attributedRecords + unattributedBucket.records !== authoritativeRecords) {
    throw new InvalidFixedCostMonetaryResult('Attribution does not cover the authoritative population');
  }
  if (categoryList.reduce((total, entry) => total + entry.records, 0) !== unattributedBucket.records
    || categoryList.reduce((total, entry) => total + entry.nonZeroRecords, 0) !== unattributedBucket.nonZeroRecords) {
    throw new InvalidFixedCostMonetaryResult('Unattributed categories do not cover the unattributed records');
  }
  if (attributedTrailers > attributedRecords || (attributedRecords > 0) !== (attributedTrailers > 0)) {
    throw new InvalidFixedCostMonetaryResult('Attributed trailer count disagrees with attributed records');
  }
  const rawTotal = row.authoritativeTotal;
  const authoritativeTotal = rawTotal === null || rawTotal === undefined ? null : assertDecimalString(rawTotal, 'authoritativeTotal');
  if ((authoritativeRecords > missingTotalRecords) !== (authoritativeTotal !== null)) {
    throw new InvalidFixedCostMonetaryResult('authoritativeTotal disagrees with the stored-total population');
  }
  return {
    deletedState: deletedState as FixedCostDeletedState,
    authoritativeRecords, authoritativeTotal, missingTotalRecords, lockedRecords, unlockedRecords, unknownLockRecords,
    attributedRecords, attributedTrailers,
    attributedTotal: assertDecimalString(row.attributedTotal, 'attributedTotal'),
    unattributed: unattributedBucket,
    categories,
    // Strictly 1: a missing, null or otherwise-typed flag is not proof of the invariant.
    reconciles: counter(row, 'reconciles') === 1,
  };
}

interface TrailerFleetPeriod { periodMonth: string; periodEnd: string }

/** The only input is one canonical settled month; nothing else can reach the statements. */
function parsePeriod(periodMonth: unknown, now?: Date): TrailerFleetPeriod {
  try {
    const period = parseFixedCostReconciliationMonth(periodMonth, now);
    return { periodMonth: period.month, periodEnd: period.monthEnd };
  } catch {
    throw new InvalidFixedCostMonetaryQuery('A canonical settled YYYY-MM-01 period is required');
  }
}

async function execute(pool: ReplicaPool, gate: AnalyticsGate, statement: string, period: TrailerFleetPeriod): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await gate.run(() => queryReadOnly<Record<string, unknown>[]>(pool, statement, [period.periodMonth, period.periodEnd]));
  } catch (error) {
    // Analytics-gate saturation is already a deterministic, sanitized ApiError.
    if (error instanceof ApiError) throw error;
    throw new FixedCostMonetaryError(error);
  }
  if (!Array.isArray(rows)) throw new InvalidFixedCostMonetaryResult('Unexpected driver result');
  return rows;
}

/**
 * Internal only. Fails closed before any replica access without an approved
 * deleted-row policy; states are always reported separately. A month exceeding the
 * record bound raises rather than returning a partial sum.
 */
export async function queryTrailerFleetTotals(
  pool: ReplicaPool, gate: AnalyticsGate, periodMonth: unknown,
  policy: FixedCostDeletedRowPolicy = unapprovedFixedCostDeletedRowPolicy, now?: Date,
): Promise<TrailerFleetTotalsResult> {
  const period = parsePeriod(periodMonth, now);
  assertApprovedDeletedRowPolicy(policy);
  const states = (await execute(pool, gate, trailerFleetTotalsStatement, period)).map(projectState);
  if (new Set(states.map(state => state.deletedState)).size !== states.length) {
    throw new InvalidFixedCostMonetaryResult('Duplicate declared row state group');
  }
  const recordsRead = states.reduce((total, state) => total + state.authoritativeRecords, 0);
  // The statement reads one record beyond the bound purely to detect truncation.
  if (recordsRead > fixedCostMonetaryMaxRecords) throw new FixedCostMonetaryTruncated(fixedCostMonetaryMaxRecords);
  return {
    periodMonth: period.periodMonth, states, recordLimit: fixedCostMonetaryMaxRecords, recordsRead,
    complete: true, truncated: false, deletedRowPolicy: policy,
  };
}

/**
 * Attributed trailer groups of the `deleted = 0` population, in database order. The
 * statement hard-codes that population, so only the `exclude_deleted` policy may run it.
 */
export async function queryTrailerFleetGroups(
  pool: ReplicaPool, gate: AnalyticsGate, periodMonth: unknown,
  policy: FixedCostDeletedRowPolicy = unapprovedFixedCostDeletedRowPolicy, now?: Date,
): Promise<TrailerFleetGroup[]> {
  const period = parsePeriod(periodMonth, now);
  assertApprovedDeletedRowPolicy(policy);
  if (policy.treatment !== 'exclude_deleted') throw new FixedCostDeletedPolicyUnapproved();
  const rows = await execute(pool, gate, trailerFleetGroupsStatement, period);
  if (rows.length > trailerFleetMaxGroups) throw new FixedCostMonetaryTruncated(trailerFleetMaxGroups);
  const seen = new Set<number>();
  return rows.map(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new InvalidFixedCostMonetaryResult('Unexpected driver row');
    // Only a positive integer the database returned is a trailer id; nothing is coerced or defaulted.
    const trailerId = counter(row, 'trailerId');
    const taskCount = counter(row, 'taskCount');
    if (trailerId < 1 || taskCount < 1 || seen.has(trailerId)) throw new InvalidFixedCostMonetaryResult('Invalid trailer group');
    seen.add(trailerId);
    return { trailerId, taskCount, lockedAmount: assertDecimalString(row.lockedAmount, 'lockedAmount') };
  });
}
