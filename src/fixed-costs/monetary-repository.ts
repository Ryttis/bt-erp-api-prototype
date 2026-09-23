import type { AnalyticsGate } from '../analytics-gate.js';
import { queryReadOnly, ReplicaDiagnosticError, type ReplicaPool } from '../db/replica.js';
import { isQueryTimeout } from '../errors.js';
import {
  assertApprovedDeletedRowPolicy, assertDecimalString, emptyFixedCostBucketCounts,
  fixedCostAuthoritativeSource, fixedCostBreakdownSources, fixedCostDeletedStates,
  fixedCostMonetaryLimitations, fixedCostMonetaryMaxRecords, fixedCostMonetaryPendingApprovals,
  InvalidFixedCostMonetaryResult, parseFixedCostMonetaryQuery, unapprovedFixedCostDeletedRowPolicy,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostDeletedState,
  type FixedCostMonetaryGroup, type FixedCostMonetaryQuery, type FixedCostMonetaryResult,
  type FixedCostRepresentation,
} from './monetary-contract.js';
import { fixedCostDifferenceBuckets, fixedCostDifferenceLadder } from './reconciliation-contract.js';

/**
 * Internal truck fixed-cost monetary repository.
 *
 * Two statement shapes exist, one per representation, both fully static once this
 * module loads. The representation is chosen by a validated enum, never by caller
 * text, so a current query can never read a locked table and vice versa.
 *
 * All monetary arithmetic — subtraction, absolute value and summation — happens in
 * SQL `DECIMAL`. Every monetary column is cast to CHAR before it crosses the driver
 * boundary and is validated as canonical decimal text, so no value is ever parsed
 * into a JavaScript `number`.
 */

// Verified ERP component field identifiers, identical in both detail tables
// (schema API, 2026-09-23). These are source column names, not business categories.
export const fixedCostComponentFields = [
  'amortizacija', 'remontas', 'padangos', 'draudimai', 'lizingas', 'vairuotojuDU', 'administracijaDU',
  'kitiMokesciai', 'vairuotojoTelefonas', 'CMRdraudimas', 'papildomosIslaidos', 'vairuotojuDUPL',
  'ruosimasGrazinimui', 'draudiminiuRemontuDedamoji', 'general_administrative_expenses',
] as const;

const componentSum = (alias: string) => fixedCostComponentFields.map(column => `${alias}.${column}`).join(' + ');

// The authoritative amount column per representation. Read, never recomputed.
const authoritativeColumn = { current: 'kastaiVilkiko', locked: 'locked_kastaiVilkiko' } as const;

const decimalText = (expression: string, alias: string) => `CAST(${expression} AS CHAR) AS ${alias}`;

/**
 * Sums a value over comparable records only, yielding SQL NULL — never zero — when
 * the group has no comparable record. `ELSE NULL` is deliberate: `ELSE 0` would make
 * an empty comparable population look like an exact reconciliation.
 */
const comparableSum = (expression: string, alias: string) =>
  decimalText(`SUM(CASE WHEN r.comparable = 1 THEN ${expression} ELSE NULL END)`, alias);

// Reuses the committed Slice 4 ladder; no second bucket definition exists.
const bucketCounters = (difference: string) => fixedCostDifferenceLadder.map(({ bucket, maxEur }, index) => {
  const previous = fixedCostDifferenceLadder[index - 1]?.maxEur;
  const lower = previous === undefined ? null : `${difference} > ${previous}`;
  const upper = maxEur === null ? null : `${difference} <= ${maxEur}`;
  const bounds = [lower, upper].filter(Boolean).join(' AND ');
  return `SUM(CASE WHEN r.comparable = 1${bounds ? ` AND ${bounds}` : ''} THEN 1 ELSE 0 END) AS bucket_${bucket}`;
});

/**
 * Builds the statement for one representation.
 *
 * `truckPlaceholders` is a count, never caller text: the IN list is rendered as
 * bound `?` markers only, so no identifier is ever interpolated into SQL.
 *
 * `kastai_fiksuoti_ataskaita` is the base authoritative population and the join to
 * `uzdaviniai` is always a LEFT JOIN, so a summary row whose task is missing stays
 * in the population, keeps its declared row state, and is counted by
 * `missingTaskCount`. It is never assigned truck `0`, `unknown` or any invented
 * identifier. When a truck allowlist is supplied, `t.uzdavinio_masina` is NULL for
 * such a row, `NULL IN (...)` is not TRUE, and the row is excluded deterministically
 * because an orphan cannot be mapped to a requested truck.
 *
 * `LIMIT` is applied after the period predicate and the optional truck predicate,
 * inside the same SELECT, so the bound always applies to the filtered population.
 */
function buildStatement(representation: FixedCostRepresentation, truckPlaceholders: number, limit: number): string {
  const authoritative = `s.${authoritativeColumn[representation]}`;
  const detailTable = fixedCostBreakdownSources[representation];
  const difference = 'ABS(r.authoritative - r.componentSum)';
  const truckFilter = truckPlaceholders > 0
    ? `\n        AND t.uzdavinio_masina IN (${Array.from({ length: truckPlaceholders }, () => '?').join(', ')})`
    : '';
  return `SELECT r.deletedState,
    COUNT(*) AS authoritativeRecords,
    ${decimalText('SUM(r.authoritative)', 'authoritativeTotal')},
    SUM(CASE WHEN r.comparable = 1 THEN 1 ELSE 0 END) AS comparableRecords,
    ${comparableSum('r.authoritative', 'comparableAuthoritativeTotal')},
    ${comparableSum('r.componentSum', 'componentTotal')},
    ${comparableSum('r.authoritative - r.componentSum', 'netDifference')},
    ${comparableSum('ABS(r.authoritative - r.componentSum)', 'grossAbsoluteDifference')},
    SUM(CASE WHEN r.comparable = 1 AND r.authoritative <> r.componentSum THEN 1 ELSE 0 END) AS affectedRecords,
    ${bucketCounters(difference).join(',\n    ')},
    SUM(CASE WHEN r.authoritative IS NOT NULL AND r.detailRows = 0 THEN 1 ELSE 0 END) AS noDetailRecords,
    SUM(CASE WHEN r.authoritative IS NOT NULL AND r.detailRows > 1 THEN 1 ELSE 0 END) AS multipleDetailRecords,
    SUM(CASE WHEN r.authoritative IS NULL THEN 1 ELSE 0 END) AS missingTotalRecords,
    SUM(CASE WHEN r.taskId IS NULL THEN 1 ELSE 0 END) AS missingTaskCount
  FROM (
    SELECT
      CASE WHEN j.deleted = 0 THEN 'zero' WHEN j.deleted = 1 THEN 'one' ELSE 'other' END AS deletedState,
      j.authoritative,
      j.componentSum,
      j.detailRows,
      j.taskId,
      CASE WHEN j.authoritative IS NOT NULL AND j.detailRows = 1 AND j.componentSum IS NOT NULL THEN 1 ELSE 0 END AS comparable
    FROM (
      SELECT s.deleted, s.taskId,
        ${authoritative} AS authoritative,
        (SELECT COUNT(*) FROM ${detailTable} d WHERE d.uzdavinys = s.uzdavinys) AS detailRows,
        (SELECT SUM(${componentSum('d')}) FROM ${detailTable} d WHERE d.uzdavinys = s.uzdavinys) AS componentSum
      FROM (
        SELECT a.uzdavinys, a.deleted, a.${authoritativeColumn[representation]}, t.id AS taskId
        FROM kastai_fiksuoti_ataskaita a
        LEFT JOIN uzdaviniai t ON t.id = a.uzdavinys
        WHERE a.kastai_data >= ? AND a.kastai_data < ?${truckFilter}
        ORDER BY a.uzdavinys
        LIMIT ${limit + 1}
      ) s
    ) j
  ) r
  GROUP BY r.deletedState
  ORDER BY r.deletedState`;
}

export function fixedCostMonetaryStatement(query: FixedCostMonetaryQuery): string {
  return buildStatement(query.representation, query.truckIds?.length ?? 0, query.limit);
}

export class FixedCostMonetaryError extends ReplicaDiagnosticError {
  readonly code: 'QUERY_TIMEOUT' | 'REPLICA_UNAVAILABLE';
  readonly statusCode: 504 | 503;

  constructor(error: unknown) {
    const timeout = isQueryTimeout(error);
    super(timeout ? 'Fixed-cost monetary query timed out' : 'Fixed-cost monetary query unavailable', error);
    this.name = 'FixedCostMonetaryError';
    this.code = timeout ? 'QUERY_TIMEOUT' : 'REPLICA_UNAVAILABLE';
    this.statusCode = timeout ? 504 : 503;
  }
}

/** A truncated period would yield a partial sum, so it never produces a monetary result. */
export class FixedCostMonetaryTruncated extends Error {
  constructor(readonly recordLimit: number) {
    super('Fixed-cost monetary period exceeds the record bound; no partial monetary result is produced');
    this.name = 'FixedCostMonetaryTruncated';
  }
}

function counter(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'bigint' ? Number(value)
    : typeof value === 'number' ? value
      : typeof value === 'string' && /^[0-9]{1,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new InvalidFixedCostMonetaryResult(`Invalid counter for ${column}`);
  return parsed;
}

/**
 * A monetary aggregate is either canonical decimal text or SQL NULL.
 *
 * NULL is preserved as `null` and never turned into `0.00`: an absent population is
 * not a zero amount, and a fabricated zero would read as an exact reconciliation.
 */
function decimalOrNull(row: Record<string, unknown>, column: string): DecimalString | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return assertDecimalString(value, column);
}

function projectGroup(row: Record<string, unknown>): FixedCostMonetaryGroup {
  const deletedState = row.deletedState;
  if (typeof deletedState !== 'string' || !(fixedCostDeletedStates as readonly string[]).includes(deletedState)) {
    throw new InvalidFixedCostMonetaryResult('Unrecognized declared row state');
  }
  const buckets = emptyFixedCostBucketCounts();
  let bucketed = 0;
  for (const bucket of fixedCostDifferenceBuckets) {
    buckets[bucket] = counter(row, `bucket_${bucket}`);
    bucketed += buckets[bucket];
  }
  const authoritativeRecords = counter(row, 'authoritativeRecords');
  const comparableRecords = counter(row, 'comparableRecords');
  const noDetailRecords = counter(row, 'noDetailRecords');
  const multipleDetailRecords = counter(row, 'multipleDetailRecords');
  const missingTotalRecords = counter(row, 'missingTotalRecords');
  const affectedRecords = counter(row, 'affectedRecords');
  const missingTaskCount = counter(row, 'missingTaskCount');

  // Every comparable record is bucketed exactly once, and the structural classes
  // plus the comparable set must account for the whole authoritative population.
  if (bucketed !== comparableRecords) throw new InvalidFixedCostMonetaryResult('Bucket counts do not cover the comparable records');
  if (comparableRecords + noDetailRecords + multipleDetailRecords + missingTotalRecords !== authoritativeRecords) {
    throw new InvalidFixedCostMonetaryResult('Record classes do not cover the authoritative population');
  }
  if (affectedRecords > comparableRecords) throw new InvalidFixedCostMonetaryResult('Affected records exceed comparable records');
  if (affectedRecords !== comparableRecords - buckets.exact) {
    throw new InvalidFixedCostMonetaryResult('Affected records disagree with the exact bucket');
  }
  if (missingTaskCount > authoritativeRecords) {
    throw new InvalidFixedCostMonetaryResult('Missing-task records exceed the authoritative population');
  }

  const comparison = {
    comparableAuthoritativeTotal: decimalOrNull(row, 'comparableAuthoritativeTotal'),
    componentTotal: decimalOrNull(row, 'componentTotal'),
    netDifference: decimalOrNull(row, 'netDifference'),
    grossAbsoluteDifference: decimalOrNull(row, 'grossAbsoluteDifference'),
  };
  // An empty comparable population must report null everywhere, and a non-empty one
  // must report real decimal text. Either mismatch is a fabricated or lost value.
  for (const [field, value] of Object.entries(comparison)) {
    if (comparableRecords === 0 && value !== null) {
      throw new InvalidFixedCostMonetaryResult(`${field} must be null without comparable records`);
    }
    if (comparableRecords > 0 && value === null) {
      throw new InvalidFixedCostMonetaryResult(`${field} must be decimal text with comparable records`);
    }
  }
  const authoritativeTotal = decimalOrNull(row, 'authoritativeTotal');
  if (authoritativeRecords > missingTotalRecords && authoritativeTotal === null) {
    throw new InvalidFixedCostMonetaryResult('authoritativeTotal must be decimal text when a stored total exists');
  }
  if (authoritativeRecords === missingTotalRecords && authoritativeTotal !== null) {
    throw new InvalidFixedCostMonetaryResult('authoritativeTotal must be null when no stored total exists');
  }

  return {
    deletedState: deletedState as FixedCostDeletedState,
    reconciliationStatus: comparableRecords === 0 ? 'structurally_non_comparable' : 'unreconciled',
    authoritativeRecords,
    authoritativeTotal,
    comparableRecords,
    ...comparison,
    affectedRecords,
    buckets,
    noDetailRecords,
    multipleDetailRecords,
    missingTotalRecords,
    missingTaskCount,
  };
}

/**
 * Internal only. No HTTP or CLI surface and no caller-selected SQL.
 *
 * Fails closed before any replica access unless an internal caller supplies an
 * approved deleted-row policy. Results are always separated by declared row state,
 * so even an approved policy cannot silently merge states. A period exceeding the
 * record bound raises rather than returning a partial sum.
 */
export async function queryFixedCostMonetaryTotals(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  input: unknown,
  policy: FixedCostDeletedRowPolicy = unapprovedFixedCostDeletedRowPolicy,
  now?: Date,
): Promise<FixedCostMonetaryResult> {
  // Validation and the policy gate both run before a connection is touched.
  const query = parseFixedCostMonetaryQuery(input, now);
  assertApprovedDeletedRowPolicy(policy);

  const statement = fixedCostMonetaryStatement(query);
  const values: (string | number)[] = [query.periodMonth, query.periodEnd, ...(query.truckIds ?? [])];
  let rows: Record<string, unknown>[];
  try {
    rows = await gate.run(() => queryReadOnly<Record<string, unknown>[]>(pool, statement, values));
  } catch (error) {
    throw new FixedCostMonetaryError(error);
  }

  if (!Array.isArray(rows)) throw new InvalidFixedCostMonetaryResult('Unexpected driver result');
  const groups = rows.map(projectGroup);
  const recordsRead = groups.reduce((total, group) => total + group.authoritativeRecords, 0);
  if (new Set(groups.map(group => group.deletedState)).size !== groups.length) {
    throw new InvalidFixedCostMonetaryResult('Duplicate declared row state group');
  }
  // The statement reads one record beyond the bound purely to detect truncation.
  if (recordsRead > query.limit) throw new FixedCostMonetaryTruncated(query.limit);

  return {
    groups,
    meta: {
      allocationScope: 'truck',
      representation: query.representation,
      periodMonth: query.periodMonth,
      dateBasis: 'kastai_data',
      currency: 'EUR',
      authoritativeSource: fixedCostAuthoritativeSource,
      breakdownSource: fixedCostBreakdownSources[query.representation],
      componentFields: fixedCostComponentFields,
      classificationApplied: false,
      classificationVersion: null,
      semanticsVersion: null,
      recordLimit: query.limit,
      recordsRead,
      missingTaskCount: groups.reduce((total, group) => total + group.missingTaskCount, 0),
      truckFilterApplied: query.truckIds !== undefined,
      truncated: false,
      complete: true,
      deletedRowPolicy: policy,
      reconciliationStatus: 'unreconciled',
      pendingApprovals: fixedCostMonetaryPendingApprovals,
      limitations: fixedCostMonetaryLimitations,
    },
  };
}

export { fixedCostMonetaryMaxRecords };
