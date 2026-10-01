import type { AnalyticsGate } from '../analytics-gate.js';
import { queryReadOnly, ReplicaDiagnosticError, type ReplicaPool } from '../db/replica.js';
import { ApiError, isQueryTimeout } from '../errors.js';
import {
  assertApprovedDeletedRowPolicy, assertDecimalString, emptyFixedCostBucketCounts,
  fixedCostAuthoritativeSource, fixedCostBreakdownSources, fixedCostDeletedStates,
  fixedCostMonetaryLimitations, fixedCostMonetaryMaxRecords, fixedCostMonetaryPendingApprovals,
  fixedCostTrailerBreakdownSources, fixedCostTrailerFleetMonetaryLimitations, fixedCostTrailerMonetaryLimitations,
  InvalidFixedCostMonetaryQuery, InvalidFixedCostMonetaryResult, parseFixedCostMonetaryQuery, unapprovedFixedCostDeletedRowPolicy,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostDeletedState,
  type FixedCostMonetaryGroup, type FixedCostMonetaryQuery, type FixedCostMonetaryResult,
  type FixedCostMonetaryScope, type FixedCostRepresentation,
} from './monetary-contract.js';
import { fixedCostDifferenceBuckets, fixedCostDifferenceLadder, parseFixedCostReconciliationMonth } from './reconciliation-contract.js';

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

export type FixedCostComponentField = typeof fixedCostComponentFields[number];
/** Per-component comparable sums as decimal text, keyed by the exact ERP column name. */
export type FixedCostComponentAmounts = Readonly<Record<FixedCostComponentField, DecimalString>>;

// Verified trailer component field identifiers, identical in both trailer detail
// tables (schema API, 2026-09-30). Source column names, not business categories.
export const fixedCostTrailerComponentFields = [
  'amortizacija', 'remontas', 'padangos', 'draudimai', 'lizingas', 'user_fee', 'preparation', 'insurance_repair',
] as const;

export type FixedCostTrailerComponentField = typeof fixedCostTrailerComponentFields[number];
export type FixedCostTrailerComponentAmounts = Readonly<Record<FixedCostTrailerComponentField, DecimalString>>;

/**
 * Everything that differs between the truck and trailer statements. Static module
 * constants selected by the validated scope enum; no entry is ever caller text.
 */
export const scopeSources = {
  truck: {
    // The authoritative amount column per representation. Read, never recomputed.
    authoritativeColumn: { current: 'kastaiVilkiko', locked: 'locked_kastaiVilkiko' },
    lockDateColumn: 'locked_kastaiVilkiko_data',
    detailTables: fixedCostBreakdownSources,
    componentFields: fixedCostComponentFields as readonly string[],
    taskVehicleColumn: 'uzdavinio_masina',
    masterFilter: '',
    lockComment: `-- ERP confirmed on 2026-09-23 (FCB-05) that '0000-00-00' marks an unlocked
      -- truck result. Any other unusable date stays 'unknown' rather than being
      -- guessed in either direction.`,
  },
  trailer: {
    authoritativeColumn: { current: 'kastaiPriekabos', locked: 'locked_kastaiPriekabos' },
    lockDateColumn: 'locked_kastaiPriekabos_data',
    detailTables: fixedCostTrailerBreakdownSources,
    componentFields: fixedCostTrailerComponentFields as readonly string[],
    taskVehicleColumn: 'uzdavinio_priekaba',
    // A trailer identifier is valid only when the trailer master has it. Without a
    // priekabos row no summary row matches, so the read is empty and refuses as
    // NO_DATA_FOR_PERIOD instead of presenting an unknown number as a trailer.
    masterFilter: '\n        AND EXISTS (SELECT 1 FROM priekabos p WHERE p.id = t.uzdavinio_priekaba)',
    lockComment: `-- The '0000-00-00' unlocked sentinel is ERP-confirmed for the truck lock date
      -- (FCB-05) and applied to the trailer lock date by structural analogy. Any
      -- other unusable date stays 'unknown' rather than being guessed.`,
  },
} as const;

export const fixedCostComponentFieldsByScope = {
  truck: fixedCostComponentFields, trailer: fixedCostTrailerComponentFields,
} as const;

const decimalText = (expression: string, alias: string) => `CAST(${expression} AS CHAR) AS ${alias}`;

/** Strict calendar-date text; zero and partial-zero dates never classify as valid. */
export const validLockDate = (date: string) => `(CAST(${date} AS CHAR) REGEXP '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      AND CAST(RIGHT(CAST(${date} AS CHAR), 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(CAST(${date} AS CHAR), 7), '-01'))))`;

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
function buildStatement(
  scope: FixedCostMonetaryScope, representation: FixedCostRepresentation, truckPlaceholders: number, limit: number,
  includeComponents: boolean,
): string {
  const source = scopeSources[scope];
  const authoritativeColumn = source.authoritativeColumn[representation];
  const authoritative = `s.${authoritativeColumn}`;
  const detailTable = source.detailTables[representation];
  const componentSum = (alias: string) => source.componentFields.map(column => `${alias}.${column}`).join(' + ');
  const difference = 'ABS(r.authoritative - r.componentSum)';
  const truckFilter = truckPlaceholders > 0
    ? `\n        AND t.${source.taskVehicleColumn} IN (${Array.from({ length: truckPlaceholders }, () => '?').join(', ')})${source.masterFilter}`
    : '';
  // Optional per-component reads. Column names come only from the static verified
  // list, and each sum covers the same comparable records as componentTotal.
  const components = includeComponents ? source.componentFields : [];
  const componentOutputs = components.map(column => `,\n    ${comparableSum(`r.c_${column}`, `component_${column}`)}`).join('');
  const componentPassThrough = components.map(column => `,\n      j.c_${column}`).join('');
  const componentReads = components
    .map(column => `,\n        (SELECT SUM(d.${column}) FROM ${detailTable} d WHERE d.uzdavinys = s.uzdavinys) AS c_${column}`).join('');
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
    SUM(CASE WHEN r.taskId IS NULL THEN 1 ELSE 0 END) AS missingTaskCount,
    SUM(CASE WHEN r.lockState = 'unlocked' THEN 1 ELSE 0 END) AS unlockedRecords,
    SUM(CASE WHEN r.lockState = 'locked' THEN 1 ELSE 0 END) AS lockedRecords,
    SUM(CASE WHEN r.lockState = 'unknown' THEN 1 ELSE 0 END) AS unknownLockRecords${componentOutputs}
  FROM (
    SELECT
      CASE WHEN j.deleted = 0 THEN 'zero' WHEN j.deleted = 1 THEN 'one' ELSE 'other' END AS deletedState,
      j.authoritative,
      j.componentSum,
      j.detailRows,
      j.taskId${componentPassThrough},
      ${source.lockComment}
      CASE WHEN j.lockDate IS NULL THEN 'unknown'
        WHEN CAST(j.lockDate AS CHAR) = '0000-00-00' THEN 'unlocked'
        WHEN ${validLockDate('j.lockDate')} THEN 'locked' ELSE 'unknown' END AS lockState,
      CASE WHEN j.authoritative IS NOT NULL AND j.detailRows = 1 AND j.componentSum IS NOT NULL THEN 1 ELSE 0 END AS comparable
    FROM (
      SELECT s.deleted, s.taskId, s.${source.lockDateColumn} AS lockDate,
        ${authoritative} AS authoritative,
        (SELECT COUNT(*) FROM ${detailTable} d WHERE d.uzdavinys = s.uzdavinys) AS detailRows,
        (SELECT SUM(${componentSum('d')}) FROM ${detailTable} d WHERE d.uzdavinys = s.uzdavinys) AS componentSum${componentReads}
      FROM (
        SELECT a.uzdavinys, a.deleted, a.${authoritativeColumn}, a.${source.lockDateColumn}, t.id AS taskId
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
  // A parsed trailer query always binds exactly one identifier; only the internal
  // fleet-wide trailer component read (`trailerFleetComponentsQuery`) binds none.
  // The truck scope binds its optional allowlist.
  const placeholders = query.trailerId !== undefined ? 1 : query.truckIds?.length ?? 0;
  return buildStatement(query.allocationScope, query.representation, placeholders, query.limit, query.includeComponents === true);
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

export function counter(row: Record<string, unknown>, column: string): number {
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

/**
 * Per-component comparable sums, with the same null rule as componentTotal: every
 * component is null exactly when there is no comparable record. A partial set is
 * malformed output, never a component quietly reported as zero.
 */
function projectComponents(
  row: Record<string, unknown>, comparableRecords: number, fields: readonly string[],
): FixedCostComponentAmounts | FixedCostTrailerComponentAmounts | null {
  const values = fields.map(column => [column, decimalOrNull(row, `component_${column}`)] as const);
  if (comparableRecords === 0) {
    if (values.some(([, value]) => value !== null)) throw new InvalidFixedCostMonetaryResult('components must be null without comparable records');
    return null;
  }
  if (values.some(([, value]) => value === null)) throw new InvalidFixedCostMonetaryResult('components must be decimal text with comparable records');
  return Object.freeze(Object.fromEntries(values)) as FixedCostComponentAmounts | FixedCostTrailerComponentAmounts;
}

function projectGroup(row: Record<string, unknown>, componentFields: readonly string[] | null): FixedCostMonetaryGroup {
  // A null or non-object driver row is malformed output, never an empty group.
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new InvalidFixedCostMonetaryResult('Unexpected driver row');
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
  const lockedRecords = counter(row, 'lockedRecords');
  const unlockedRecords = counter(row, 'unlockedRecords');
  const unknownLockRecords = counter(row, 'unknownLockRecords');

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
  if (lockedRecords + unlockedRecords + unknownLockRecords !== authoritativeRecords) {
    throw new InvalidFixedCostMonetaryResult('Lock states do not cover the authoritative population');
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
    lockedRecords,
    unlockedRecords,
    unknownLockRecords,
    ...(componentFields === null ? {} : { components: projectComponents(row, comparableRecords, componentFields) }),
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

  const rows = await executeMonetaryStatement(pool, gate, fixedCostMonetaryStatement(query), query);
  const source = scopeSources[query.allocationScope];
  return monetaryResult(query, policy, rows.map(row => projectGroup(row, query.includeComponents === true ? source.componentFields : null)));
}

async function executeMonetaryStatement(
  pool: ReplicaPool, gate: AnalyticsGate, statement: string, query: FixedCostMonetaryQuery,
): Promise<Record<string, unknown>[]> {
  // Identifiers are only ever bound values, never statement text.
  const values: (string | number)[] = [
    query.periodMonth, query.periodEnd, ...(query.trailerId !== undefined ? [query.trailerId] : query.truckIds ?? []),
  ];
  let rows: Record<string, unknown>[];
  try {
    rows = await gate.run(() => queryReadOnly<Record<string, unknown>[]>(pool, statement, values));
  } catch (error) {
    // Analytics-gate saturation is already a deterministic, sanitized ApiError.
    // Wrapping it would flatten SERVICE_BUSY into REPLICA_UNAVAILABLE.
    if (error instanceof ApiError) throw error;
    throw new FixedCostMonetaryError(error);
  }
  if (!Array.isArray(rows)) throw new InvalidFixedCostMonetaryResult('Unexpected driver result');
  return rows;
}

function monetaryResult(query: FixedCostMonetaryQuery, policy: FixedCostDeletedRowPolicy, groups: FixedCostMonetaryGroup[]): FixedCostMonetaryResult {
  const trailer = query.allocationScope === 'trailer';
  const source = scopeSources[query.allocationScope];
  const recordsRead = groups.reduce((total, group) => total + group.authoritativeRecords, 0);
  if (new Set(groups.map(group => group.deletedState)).size !== groups.length) {
    throw new InvalidFixedCostMonetaryResult('Duplicate declared row state group');
  }
  // The statement reads one record beyond the bound purely to detect truncation.
  if (recordsRead > query.limit) throw new FixedCostMonetaryTruncated(query.limit);

  return {
    groups,
    meta: {
      allocationScope: query.allocationScope,
      representation: query.representation,
      periodMonth: query.periodMonth,
      dateBasis: 'kastai_data',
      currency: 'EUR',
      authoritativeSource: fixedCostAuthoritativeSource,
      breakdownSource: source.detailTables[query.representation],
      componentFields: source.componentFields,
      classificationApplied: false,
      classificationVersion: null,
      semanticsVersion: null,
      recordLimit: query.limit,
      recordsRead,
      missingTaskCount: groups.reduce((total, group) => total + group.missingTaskCount, 0),
      truckFilterApplied: query.truckIds !== undefined,
      ...(trailer ? { trailerFilterApplied: query.trailerId !== undefined } : {}),
      truncated: false,
      complete: true,
      deletedRowPolicy: policy,
      reconciliationStatus: 'unreconciled',
      pendingApprovals: fixedCostMonetaryPendingApprovals,
      limitations: !trailer ? fixedCostMonetaryLimitations
        : query.trailerId !== undefined ? fixedCostTrailerMonetaryLimitations : fixedCostTrailerFleetMonetaryLimitations,
    },
  };
}

// Exact for every canonical decimal the statements emit (at most six fraction digits).
const exactDecimal = (expression: string) => `CAST(${expression} AS DECIMAL(65,6))`;

/**
 * The component ranking statement: the unchanged monetary statement, with its
 * per-component reads, as a derived table, crossed with the static component list
 * so each declared-state group yields one row per component field.
 *
 * The month is scanned once. The database orders each state's rows in `DECIMAL` —
 * amount descending, then the component key ascending in binary order — and also
 * evaluates `componentsReconcile`: whether the per-component sums add up exactly to
 * `componentTotal`. Component keys are module constants from the verified field
 * list; the bound values are exactly those of the inner statement.
 */
export function fixedCostRankedComponentStatement(query: FixedCostMonetaryQuery): string {
  const fields = scopeSources[query.allocationScope].componentFields;
  const keys = fields.map((field, index) => index === 0 ? `SELECT '${field}' AS component` : `SELECT '${field}'`).join(' UNION ALL ');
  const amount = `CASE k.component ${fields.map(field => `WHEN '${field}' THEN g.component_${field}`).join(' ')} END`;
  return `SELECT g.*, k.component, ${amount} AS componentAmount,
    CASE WHEN g.comparableRecords = 0 THEN NULL
      WHEN ${exactDecimal('g.componentTotal')} = ${fields.map(field => exactDecimal(`g.component_${field}`)).join(' + ')} THEN 1
      ELSE 0 END AS componentsReconcile
  FROM (
  ${fixedCostMonetaryStatement({ ...query, includeComponents: true })}
  ) g
  CROSS JOIN (${keys}) k
  ORDER BY g.deletedState, ${exactDecimal(amount)} DESC, CAST(k.component AS BINARY) ASC`;
}

export interface FixedCostRankedComponent {
  /** The exact ERP column name; no business label is applied. */
  component: string;
  amount: DecimalString;
}

export interface FixedCostRankedComponentGroup {
  deletedState: FixedCostDeletedState;
  /** Database order. Null exactly when the state has no comparable record. */
  components: readonly FixedCostRankedComponent[] | null;
  /** Database-evaluated: the per-component sums equal `componentTotal`. Null without comparable records. */
  componentsReconcile: boolean | null;
}

export interface FixedCostRankedComponentResult {
  totals: FixedCostMonetaryResult;
  ranking: FixedCostRankedComponentGroup[];
}

/**
 * Internal only. The monetary read plus a database-ordered component ranking per
 * declared row state, from one statement. The same validation, policy gate, record
 * bound and truncation rules as `queryFixedCostMonetaryTotals` apply, and `totals`
 * has exactly its shape. Component amounts are compared only as text equality,
 * never parsed, added or sorted in JavaScript.
 */
export async function queryFixedCostRankedComponents(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  input: unknown,
  policy: FixedCostDeletedRowPolicy = unapprovedFixedCostDeletedRowPolicy,
  now?: Date,
): Promise<FixedCostRankedComponentResult> {
  const query = parseFixedCostMonetaryQuery(input, now);
  assertApprovedDeletedRowPolicy(policy);
  if (query.includeComponents !== true) throw new InvalidFixedCostMonetaryQuery('The component ranking requires component reads');
  return rankedComponentRead(pool, gate, query, policy);
}

/**
 * The only fleet-wide trailer form of the monetary query: locked, every summary row
 * of the month, component reads on, no trailer predicate and no master check. It is
 * built here, never parsed, so `parseFixedCostMonetaryQuery` keeps requiring exactly
 * one trailer identifier and no caller can reach a trailer read without one.
 *
 * The population is the fleet-wide trailer summary's (`trailer-fleet-repository.ts`):
 * every `kastai_fiksuoti_ataskaita` row of the month, `uzdaviniai` LEFT JOINed on its
 * primary key, ordered by task and bounded identically, so rows without an
 * attributable trailer stay in it exactly as they stay in the fleet summary amount.
 */
export function trailerFleetComponentsQuery(periodMonth: unknown, now?: Date): FixedCostMonetaryQuery {
  let period;
  try {
    period = parseFixedCostReconciliationMonth(periodMonth, now);
  } catch {
    throw new InvalidFixedCostMonetaryQuery('A canonical settled YYYY-MM-01 period is required');
  }
  return {
    allocationScope: 'trailer', representation: 'locked', periodMonth: period.month, periodEnd: period.monthEnd,
    limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  };
}

/**
 * Internal only. The fleet-wide trailer component ranking for one settled month,
 * through exactly the same statement builder, ranking wrapper, projection, record
 * bound and truncation rules as `queryFixedCostRankedComponents`. The only bound
 * values are the two period bounds.
 */
export async function queryTrailerFleetRankedComponents(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  periodMonth: unknown,
  policy: FixedCostDeletedRowPolicy = unapprovedFixedCostDeletedRowPolicy,
  now?: Date,
): Promise<FixedCostRankedComponentResult> {
  const query = trailerFleetComponentsQuery(periodMonth, now);
  assertApprovedDeletedRowPolicy(policy);
  return rankedComponentRead(pool, gate, query, policy);
}

async function rankedComponentRead(
  pool: ReplicaPool, gate: AnalyticsGate, query: FixedCostMonetaryQuery, policy: FixedCostDeletedRowPolicy,
): Promise<FixedCostRankedComponentResult> {
  const fields = scopeSources[query.allocationScope].componentFields;

  const rows = await executeMonetaryStatement(pool, gate, fixedCostRankedComponentStatement(query), query);
  const byState = new Map<unknown, Record<string, unknown>[]>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new InvalidFixedCostMonetaryResult('Unexpected driver row');
    byState.set(row.deletedState, [...byState.get(row.deletedState) ?? [], row]);
  }

  const groups: FixedCostMonetaryGroup[] = [];
  const ranking: FixedCostRankedComponentGroup[] = [];
  for (const stateRows of byState.values()) {
    if (stateRows.length !== fields.length) throw new InvalidFixedCostMonetaryResult('Component ranking does not cover every component field');
    // Every row repeats its state's single aggregate; each must project identically.
    const projected = stateRows.map(row => projectGroup(row, fields));
    const [group] = projected;
    const signature = JSON.stringify(group);
    if (projected.some(entry => JSON.stringify(entry) !== signature)) {
      throw new InvalidFixedCostMonetaryResult('Component ranking rows disagree on their group aggregate');
    }

    const seen = new Set<string>();
    const ranked = stateRows.map(row => {
      const component = row.component;
      if (typeof component !== 'string' || !fields.includes(component) || seen.has(component)) {
        throw new InvalidFixedCostMonetaryResult('Component ranking returned an unknown or duplicate component');
      }
      seen.add(component);
      const amount = decimalOrNull(row, 'componentAmount');
      const expected = group.components === null || group.components === undefined
        ? null : (group.components as Record<string, DecimalString>)[component];
      // The ranked amount must be the very same decimal text as the group's own component sum.
      if (amount !== expected) throw new InvalidFixedCostMonetaryResult('Ranked component amount disagrees with its component sum');
      return { component, amount };
    });

    const comparable = group.comparableRecords > 0;
    const flags = stateRows.map(row => row.componentsReconcile === null || row.componentsReconcile === undefined
      ? null : counter(row, 'componentsReconcile'));
    if (flags.some(flag => flag !== flags[0]) || (comparable ? flags[0] !== 0 && flags[0] !== 1 : flags[0] !== null)) {
      throw new InvalidFixedCostMonetaryResult('Invalid component reconciliation flag');
    }
    groups.push(group);
    ranking.push({
      deletedState: group.deletedState,
      components: comparable ? Object.freeze(ranked as FixedCostRankedComponent[]) : null,
      componentsReconcile: comparable ? flags[0] === 1 : null,
    });
  }
  return { totals: monetaryResult(query, policy, groups), ranking };
}

export { fixedCostMonetaryMaxRecords };
