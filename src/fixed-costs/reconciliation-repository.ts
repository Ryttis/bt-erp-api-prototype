import type { AnalyticsGate } from '../analytics-gate.js';
import { queryReadOnly, ReplicaDiagnosticError, type ReplicaPool } from '../db/replica.js';
import { isQueryTimeout } from '../errors.js';
import {
  describeFixedCostDifferences, emptyFixedCostDifferenceCounts, fixedCostDifferenceBuckets,
  fixedCostDifferenceLadder, fixedCostDifferenceNonComparable, fixedCostReconciliationCategories,
  fixedCostReconciliationSettlementMonths, fixedCostReconciliationTaskLimit,
  fixedCostReconciliationToleranceEur, parseFixedCostReconciliationMonth,
  type FixedCostDifferenceCounts, type FixedCostReconciliationCategories, type FixedCostReconciliationResult,
} from './reconciliation-contract.js';

/**
 * One fixed statement shape plus its EXPLAIN. The month bounds are the only bound
 * parameters; every table, column, bound and tolerance below is a module constant,
 * so the statement text is fully static once this module loads.
 *
 * Current and locked calculations stay separate end to end: the current summary total
 * is only ever compared with the current component sum, and the locked summary total
 * only with the locked component sum. The two representations are never added.
 */

// Confirmed identical 15-component decimal(13,2) layout in both truck detail tables
// (schema API, 2026-09-23). All are NOT NULL, so the row sum needs no NULL coalescing.
const componentColumns = [
  'amortizacija', 'remontas', 'padangos', 'draudimai', 'lizingas', 'vairuotojuDU', 'administracijaDU',
  'kitiMokesciai', 'vairuotojoTelefonas', 'CMRdraudimas', 'papildomosIslaidos', 'vairuotojuDUPL',
  'ruosimasGrazinimui', 'draudiminiuRemontuDedamoji', 'general_administrative_expenses',
] as const;

const componentSum = (alias: string) => componentColumns.map(column => `${alias}.${column}`).join(' + ');

// Correlated PK-prefix lookups: each reads only the requested task's detail rows.
const detailAggregate = (table: string, alias: string, expression: string) =>
  `(SELECT ${expression} FROM ${table} ${alias} WHERE ${alias}.uzdavinys = s.uzdavinys)`;

// Exact decimal comparison in the database; the tolerance is an implementation safety
// value pending Finance approval, never a silent rounding of a reported amount.
const componentComparison = (total: string, sum: string) => `CASE WHEN ${sum} IS NULL THEN 'no_details'
      WHEN ${total} = ${sum} THEN 'exact'
      WHEN ABS(${total} - ${sum}) <= ${fixedCostReconciliationToleranceEur} THEN 'within_tolerance'
      ELSE 'outside_tolerance' END`;

const cardinality = (rows: string) => `CASE WHEN ${rows} = 0 THEN 'none' WHEN ${rows} = 1 THEN 'one' ELSE 'multiple' END`;

// Strict calendar-date text; zero and partial-zero dates never classify as valid.
const validDate = (date: string) => `(CAST(${date} AS CHAR) REGEXP '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      AND CAST(RIGHT(CAST(${date} AS CHAR), 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(CAST(${date} AS CHAR), 7), '-01'))))`;

/**
 * Absolute-difference classification, entirely in SQL decimal arithmetic.
 *
 * Structurally non-comparable rows are separated first, so a missing total, an
 * absent detail row or a multi-row grain can never land in a monetary bucket.
 * `ABS` is applied to every comparison, so a negative raw difference classifies by
 * magnitude. Ordering matters: exact equality is tested before the rounding bound,
 * and each later bound is reached only when the previous one did not match.
 */
const differenceClass = (total: string, sum: string, rows: string) => {
  const absolute = `ABS(${total} - ${sum})`;
  // Generated from the shared ladder, so a boundary cannot change in one place only.
  const ladder = fixedCostDifferenceLadder.map(({ bucket, maxEur }) => maxEur === null
    ? `      ELSE '${bucket}' END`
    : `      WHEN ${absolute} <= ${maxEur} THEN '${bucket}'`);
  return `CASE WHEN ${total} IS NULL THEN 'missing_total'
      WHEN ${rows} = 0 THEN 'no_details'
      WHEN ${rows} > 1 THEN 'multiple_details'
      WHEN ${sum} IS NULL THEN 'other'
${ladder.join('\n')}`;
};

const categoryKeys = Object.keys(fixedCostReconciliationCategories) as (keyof typeof fixedCostReconciliationCategories)[];
const differenceKeys = ['currentDifference', 'lockedDifference'] as const;
const differenceClasses = [...fixedCostDifferenceBuckets, ...fixedCostDifferenceNonComparable];

// The sentinel row exists only to prove truncation. Every counter below is gated on
// the sampled window, so no counter or percentage ever describes more than the bound.
const sampled = `c.rowNumber <= ${fixedCostReconciliationTaskLimit}`;

// One counter column per allowlisted category value; nothing row-level is projected.
const counters = [
  ...categoryKeys.flatMap(key => fixedCostReconciliationCategories[key]
    .map(value => `SUM(CASE WHEN ${sampled} AND c.${key} = '${value}' THEN 1 ELSE 0 END) AS ${key}__${value}`)),
  ...differenceKeys.flatMap(key => differenceClasses
    .map(value => `SUM(CASE WHEN ${sampled} AND c.${key} = '${value}' THEN 1 ELSE 0 END) AS ${key}__${value}`)),
];

const reconciliationSql = `SELECT COUNT(*) AS fetchedTaskCount,
    SUM(CASE WHEN ${sampled} THEN 1 ELSE 0 END) AS sampledTaskCount,
    ${counters.join(',\n    ')}
  FROM (
    SELECT
      ROW_NUMBER() OVER (ORDER BY j.uzdavinys) AS rowNumber,
      CASE WHEN j.taskId IS NULL THEN 'missing' ELSE 'present' END AS task,
      CASE WHEN j.taskId IS NULL THEN 'missing'
        WHEN j.uzdavinio_masina = 0 THEN 'zero'
        WHEN j.truckId IS NULL THEN 'populated_without_master' ELSE 'populated_with_master' END AS assignedTruck,
      CASE WHEN j.deleted = 0 THEN 'zero' WHEN j.deleted = 1 THEN 'one' ELSE 'other' END AS deletedFlag,
      CASE WHEN CAST(j.locked_kastaiVilkiko_data AS CHAR) = '0000-00-00' THEN 'zero_date'
        WHEN ${validDate('j.locked_kastaiVilkiko_data')} THEN 'valid_date' ELSE 'other' END AS lockState,
      ${cardinality('j.currentDetailRows')} AS currentDetail,
      ${cardinality('j.lockedDetailRows')} AS lockedDetail,
      ${componentComparison('j.kastaiVilkiko', 'j.currentComponentSum')} AS currentComponents,
      ${componentComparison('j.locked_kastaiVilkiko', 'j.lockedComponentSum')} AS lockedComponents,
      ${differenceClass('j.kastaiVilkiko', 'j.currentComponentSum', 'j.currentDetailRows')} AS currentDifference,
      ${differenceClass('j.locked_kastaiVilkiko', 'j.lockedComponentSum', 'j.lockedDetailRows')} AS lockedDifference
    FROM (
      SELECT s.uzdavinys, s.kastaiVilkiko, s.locked_kastaiVilkiko, s.locked_kastaiVilkiko_data, s.deleted,
        t.id AS taskId, t.uzdavinio_masina, m.id AS truckId,
        ${detailAggregate('kastai_fiksuoti_vilkikai_det', 'd', 'COUNT(*)')} AS currentDetailRows,
        ${detailAggregate('kastai_fiksuoti_vilkikai_det', 'd', `SUM(${componentSum('d')})`)} AS currentComponentSum,
        ${detailAggregate('kastai_fiksuoti_vilkikai_det_locked', 'l', 'COUNT(*)')} AS lockedDetailRows,
        ${detailAggregate('kastai_fiksuoti_vilkikai_det_locked', 'l', `SUM(${componentSum('l')})`)} AS lockedComponentSum
      FROM (
        SELECT uzdavinys, kastaiVilkiko, locked_kastaiVilkiko, locked_kastaiVilkiko_data, deleted
        FROM kastai_fiksuoti_ataskaita
        WHERE kastai_data >= ? AND kastai_data < ?
        ORDER BY uzdavinys
        LIMIT ${fixedCostReconciliationTaskLimit + 1}
      ) s
      LEFT JOIN uzdaviniai t ON t.id = s.uzdavinys
      LEFT JOIN masinos m ON m.id = NULLIF(t.uzdavinio_masina, 0)
    ) j
  ) c`;

/** The production-shaped statement, exposed for query-plan evidence only. */
export const fixedCostReconciliationStatement = reconciliationSql;
export const fixedCostReconciliationExplainStatement = `EXPLAIN ${reconciliationSql}`;

export class FixedCostReconciliationError extends ReplicaDiagnosticError {
  readonly code: 'QUERY_TIMEOUT' | 'REPLICA_UNAVAILABLE';
  readonly statusCode: 504 | 503;

  constructor(error: unknown) {
    const timeout = isQueryTimeout(error);
    super(timeout ? 'Fixed-cost reconciliation query timed out' : 'Fixed-cost reconciliation unavailable', error);
    this.name = 'FixedCostReconciliationError';
    this.code = timeout ? 'QUERY_TIMEOUT' : 'REPLICA_UNAVAILABLE';
    this.statusCode = timeout ? 504 : 503;
  }
}

/** Driver counters arrive as number, string or BigInt depending on column and size. */
function counter(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'bigint' ? Number(value)
    : typeof value === 'number' ? value
      : typeof value === 'string' && /^[0-9]{1,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid fixed-cost reconciliation counter');
  return parsed;
}

function projectCategories(row: Record<string, unknown>, sampledCount: number): FixedCostReconciliationCategories {
  const data = {} as FixedCostReconciliationCategories;
  let total = 0;
  for (const key of categoryKeys) {
    const values = {} as Record<string, number>;
    for (const value of fixedCostReconciliationCategories[key]) {
      values[value] = counter(row, `${key}__${value}`);
    }
    // Every sampled task must land in exactly one bucket of every category.
    const sum = Object.values(values).reduce((left, right) => left + right, 0);
    if (sum !== sampledCount) throw new Error('Incomplete fixed-cost reconciliation category');
    total += sum;
    (data as Record<string, unknown>)[key] = values;
  }
  if (total !== sampledCount * categoryKeys.length) throw new Error('Incomplete fixed-cost reconciliation coverage');
  return data;
}

/** Counts must cover the sampled window exactly once, buckets and non-comparable alike. */
function projectDifferenceCounts(row: Record<string, unknown>, key: string, sampledCount: number): FixedCostDifferenceCounts {
  const counts = emptyFixedCostDifferenceCounts();
  let total = 0;
  for (const name of differenceClasses) {
    const value = counter(row, `${key}__${name}`);
    counts[name] = value;
    total += value;
  }
  if (total !== sampledCount) throw new Error('Incomplete fixed-cost difference distribution');
  return counts;
}

/**
 * Internal only. No HTTP or CLI surface, and no caller-selected SQL.
 *
 * Runs one bounded statement through the shared analytics gate and the pool's
 * configured query timeout. Completeness describes the task bound for the month,
 * not Finance reconciliation: a passing comparison is database evidence that the
 * component sums reproduce the stored totals, and nothing more.
 */
export async function reconcileFixedCostMonth(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  month: unknown,
  now?: Date,
): Promise<FixedCostReconciliationResult> {
  const { month: validated, monthEnd } = parseFixedCostReconciliationMonth(month, now);
  try {
    const rows = await gate.run(() => queryReadOnly<Record<string, unknown>[]>(pool, reconciliationSql, [validated, monthEnd]));
    if (rows.length !== 1) throw new Error('Incomplete fixed-cost reconciliation');
    const fetchedTaskCount = counter(rows[0], 'fetchedTaskCount');
    const sampledTaskCount = counter(rows[0], 'sampledTaskCount');
    // The query fetches one row beyond the bound purely to prove truncation.
    if (fetchedTaskCount > fixedCostReconciliationTaskLimit + 1) throw new Error('Fixed-cost reconciliation exceeded its bound');
    if (sampledTaskCount > fixedCostReconciliationTaskLimit) throw new Error('Fixed-cost reconciliation sampled beyond its bound');
    if (sampledTaskCount !== Math.min(fetchedTaskCount, fixedCostReconciliationTaskLimit)) {
      throw new Error('Fixed-cost reconciliation sentinel accounting is inconsistent');
    }
    const counts = {
      current: projectDifferenceCounts(rows[0], 'currentDifference', sampledTaskCount),
      locked: projectDifferenceCounts(rows[0], 'lockedDifference', sampledTaskCount),
    };
    return {
      data: projectCategories(rows[0], sampledTaskCount),
      counts,
      differences: {
        current: describeFixedCostDifferences(counts.current),
        locked: describeFixedCostDifferences(counts.locked),
      },
      meta: {
        month: validated,
        taskLimit: fixedCostReconciliationTaskLimit,
        sampledTaskCount,
        fetchedTaskCount,
        truncated: fetchedTaskCount > fixedCostReconciliationTaskLimit,
        complete: fetchedTaskCount <= fixedCostReconciliationTaskLimit,
        toleranceEur: fixedCostReconciliationToleranceEur,
        settlementMonths: fixedCostReconciliationSettlementMonths,
        reconciliationStatus: 'unreconciled_pending_erp_reference',
      },
    };
  } catch (error) {
    throw new FixedCostReconciliationError(error);
  }
}

/** Query-plan evidence for the production-shaped statement. Returns driver rows for
 * local inspection only; callers must not log raw plan output containing literals. */
export async function explainFixedCostReconciliation(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  month: unknown,
  now?: Date,
): Promise<Record<string, unknown>[]> {
  const { month: validated, monthEnd } = parseFixedCostReconciliationMonth(month, now);
  try {
    return await gate.run(() => queryReadOnly<Record<string, unknown>[]>(pool, fixedCostReconciliationExplainStatement, [validated, monthEnd]));
  } catch (error) {
    throw new FixedCostReconciliationError(error);
  }
}
