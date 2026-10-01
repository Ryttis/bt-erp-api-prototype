import type { AnalyticsGate } from '../analytics-gate.js';
import { queryReadOnly, type ReplicaPool } from '../db/replica.js';
import { ApiError } from '../errors.js';
import {
  assertApprovedDeletedRowPolicy, assertDecimalString, fixedCostDeletedStates, InvalidFixedCostMonetaryResult,
  type FixedCostDeletedRowPolicy, type FixedCostDeletedState,
} from './monetary-contract.js';
import { counter, FixedCostMonetaryError, scopeSources, validLockDate } from './monetary-repository.js';
import type { FixedCostPilotPopulationCounts } from './pilot-summary.js';

/**
 * Internal single-trailer available-period repository (MP-8).
 *
 * One static statement: the single-trailer locked population of the monthly summary
 * (`fixedCostMonetaryStatement` for `allocationScope=trailer`, locked), counted per
 * `kastai_data` month and declared `deleted` state instead of for one month. Source
 * table, authoritative column, lock-date column, lock classification, task-trailer
 * predicate and trailer-master check are the same, taken from the same constants.
 *
 * The only bound values are the two period bounds and the trailer identifier. Only
 * integer counters and month keys cross the driver boundary as output, plus the
 * stored total as decimal text so its null state is checked exactly as the summary
 * checks it. Detail tables are not read: they never decide summary eligibility.
 */

const source = scopeSources.trailer;

export const trailerAvailablePeriodsStatement = `SELECT r.periodMonth, r.deletedState,
    COUNT(*) AS authoritativeRecords,
    CAST(SUM(r.authoritative) AS CHAR) AS authoritativeTotal,
    SUM(CASE WHEN r.authoritative IS NULL THEN 1 ELSE 0 END) AS missingTotalRecords,
    SUM(CASE WHEN r.lockState = 'unlocked' THEN 1 ELSE 0 END) AS unlockedRecords,
    SUM(CASE WHEN r.lockState = 'locked' THEN 1 ELSE 0 END) AS lockedRecords,
    SUM(CASE WHEN r.lockState = 'unknown' THEN 1 ELSE 0 END) AS unknownLockRecords
  FROM (
    SELECT
      DATE_FORMAT(s.kastai_data, '%Y-%m-01') AS periodMonth,
      CASE WHEN s.deleted = 0 THEN 'zero' WHEN s.deleted = 1 THEN 'one' ELSE 'other' END AS deletedState,
      s.authoritative,
      ${source.lockComment}
      CASE WHEN s.lockDate IS NULL THEN 'unknown'
        WHEN CAST(s.lockDate AS CHAR) = '0000-00-00' THEN 'unlocked'
        WHEN ${validLockDate('s.lockDate')} THEN 'locked' ELSE 'unknown' END AS lockState
    FROM (
      SELECT a.kastai_data, a.deleted, a.${source.authoritativeColumn.locked} AS authoritative,
        a.${source.lockDateColumn} AS lockDate
      FROM kastai_fiksuoti_ataskaita a
      LEFT JOIN uzdaviniai t ON t.id = a.uzdavinys
      WHERE a.kastai_data >= ? AND a.kastai_data < ?
        AND t.${source.taskVehicleColumn} IN (?)${source.masterFilter}
    ) s
  ) r
  GROUP BY r.periodMonth, r.deletedState
  ORDER BY r.periodMonth, r.deletedState`;

export interface TrailerAvailablePeriodsQuery {
  trailerId: number;
  /** Canonical `YYYY-MM-01` months to classify, ascending and contiguous. */
  months: readonly string[];
  /** Exclusive first day after the last month. */
  periodEnd: string;
}

export interface TrailerAvailablePeriodsMonth {
  month: string;
  /** Declared-state groups of the month, as the monthly summary read would return them. */
  groups: readonly FixedCostPilotPopulationCounts[];
  /** Records across every declared state; the monthly read's record bound applies to this. */
  recordsRead: number;
}

function projectRow(row: unknown, months: ReadonlySet<string>) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new InvalidFixedCostMonetaryResult('Unexpected driver row');
  const values = row as Record<string, unknown>;
  const { periodMonth, deletedState } = values;
  if (typeof periodMonth !== 'string' || !months.has(periodMonth)) throw new InvalidFixedCostMonetaryResult('Unexpected period month');
  if (typeof deletedState !== 'string' || !(fixedCostDeletedStates as readonly string[]).includes(deletedState)) {
    throw new InvalidFixedCostMonetaryResult('Unrecognized declared row state');
  }
  const authoritativeRecords = counter(values, 'authoritativeRecords');
  const missingTotalRecords = counter(values, 'missingTotalRecords');
  const lockedRecords = counter(values, 'lockedRecords');
  const unlockedRecords = counter(values, 'unlockedRecords');
  const unknownLockRecords = counter(values, 'unknownLockRecords');
  if (missingTotalRecords > authoritativeRecords) throw new InvalidFixedCostMonetaryResult('Missing totals exceed the population');
  if (lockedRecords + unlockedRecords + unknownLockRecords !== authoritativeRecords) {
    throw new InvalidFixedCostMonetaryResult('Lock states do not cover the authoritative population');
  }
  // Same null rule as the monthly read: null exactly when no record carries a stored total.
  const rawTotal = values.authoritativeTotal;
  const authoritativeTotal = rawTotal === null || rawTotal === undefined ? null : assertDecimalString(rawTotal, 'authoritativeTotal');
  if ((authoritativeTotal === null) !== (authoritativeRecords === missingTotalRecords)) {
    throw new InvalidFixedCostMonetaryResult('authoritativeTotal null state disagrees with the stored totals');
  }
  return {
    month: periodMonth,
    group: {
      deletedState: deletedState as FixedCostDeletedState,
      authoritativeRecords, authoritativeTotal, missingTotalRecords, lockedRecords, unlockedRecords, unknownLockRecords,
    },
  };
}

/**
 * Internal only. Returns every requested month, in request order, with the groups
 * found for it; a month without rows has no groups. Malformed driver output fails
 * the whole read rather than dropping or inventing a month.
 */
export async function queryTrailerAvailablePeriods(
  pool: ReplicaPool, gate: AnalyticsGate, query: TrailerAvailablePeriodsQuery, policy: FixedCostDeletedRowPolicy,
): Promise<TrailerAvailablePeriodsMonth[]> {
  assertApprovedDeletedRowPolicy(policy);
  const values = [query.months[0], query.periodEnd, query.trailerId];
  let rows: unknown;
  try {
    rows = await gate.run(() => queryReadOnly<unknown>(pool, trailerAvailablePeriodsStatement, values));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new FixedCostMonetaryError(error);
  }
  if (!Array.isArray(rows) || rows.length > query.months.length * fixedCostDeletedStates.length) {
    throw new InvalidFixedCostMonetaryResult('Unexpected driver result');
  }
  const requested = new Set(query.months);
  const byMonth = new Map<string, FixedCostPilotPopulationCounts[]>(query.months.map(month => [month, []]));
  for (const row of rows) {
    const { month, group } = projectRow(row, requested);
    const groups = byMonth.get(month)!;
    if (groups.some(existing => existing.deletedState === group.deletedState)) {
      throw new InvalidFixedCostMonetaryResult('Duplicate declared row state group');
    }
    groups.push(group);
  }
  return query.months.map(month => {
    const groups = byMonth.get(month)!;
    return { month, groups, recordsRead: groups.reduce((total, group) => total + group.authoritativeRecords, 0) };
  });
}
