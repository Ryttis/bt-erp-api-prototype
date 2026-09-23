import { queryReadOnly, ReplicaDiagnosticError, type ReplicaPool } from '../db/replica.js';
import { isQueryTimeout } from '../errors.js';
import {
  fixedCostDiagnosticCategories, fixedCostDiagnosticDetailLimit, parseFixedCostDiagnosticInput,
  type FixedCostDiagnosticCategories, type FixedCostDiagnosticResult,
} from './diagnostic-contract.js';

// Two fixed query shapes. Task IDs are only bound parameters; no caller-selected SQL parts.
// These equalities and classes test structural hypotheses, not approved financial semantics.
// The helpers below receive only the fixed column expressions in this file, never input,
// so each statement is fully static once the module loads.
const comparisonSql = (left: string, right: string) => `CASE WHEN ${left} IS NULL AND ${right} IS NULL THEN 'both_missing'
      WHEN ${left} IS NULL THEN 'left_missing'
      WHEN ${right} IS NULL THEN 'right_missing'
      WHEN ${left} = ${right} THEN 'equal' ELSE 'different' END`;
const valueClassSql = (value: string) => `CASE WHEN ${value} IS NULL THEN 'missing'
      WHEN ${value} < 0 THEN 'negative' WHEN ${value} = 0 THEN 'zero' ELSE 'positive' END`;
// Strict calendar date text; zero and partial-zero dates never classify as valid.
const validDateSql = (date: string) => `(CAST(${date} AS CHAR) REGEXP '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      AND CAST(RIGHT(CAST(${date} AS CHAR), 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(CAST(${date} AS CHAR), 7), '-01'))))`;
const dateStateSql = (date: string) => `CASE WHEN ${date} IS NULL THEN 'missing'
      WHEN CAST(${date} AS CHAR) = '0000-00-00' THEN 'zero_date'
      WHEN ${validDateSql(date)} THEN 'valid_date' ELSE 'other' END`;
// Aggregates over at most the bounded detail entries; the summary side is one PK row.
const detailDateSql = (summaryDate: string) => `CASE WHEN COUNT(*) = 0 THEN 'no_details'
      WHEN COUNT(*) > ${fixedCostDiagnosticDetailLimit} THEN 'unclassified'
      WHEN MIN(CASE WHEN ${validDateSql(summaryDate)} THEN 1 ELSE 0 END) = 0 THEN 'summary_date_unusable'
      WHEN MIN(CASE WHEN ${validDateSql('d.kastai_data')} THEN 1 ELSE 0 END) = 0 THEN 'detail_date_unusable'
      WHEN SUM(CASE WHEN d.kastai_data = ${summaryDate} THEN 1 ELSE 0 END) = COUNT(*) THEN 'all_equal'
      WHEN SUM(CASE WHEN d.kastai_data = ${summaryDate} THEN 1 ELSE 0 END) = 0 THEN 'none_equal'
      ELSE 'mixed' END`;

const taskSummarySql = `SELECT
    CASE WHEN t.id IS NULL THEN 'missing' ELSE 'present' END AS task,
    CASE WHEN s.uzdavinys IS NULL THEN 'missing' ELSE 'present' END AS summary,
    CASE WHEN s.uzdavinys IS NULL THEN 'zero' ELSE 'one' END AS summaryCardinality,
    ${comparisonSql('t.kastaiVilkiko', 's.kastaiVilkiko')} AS truckTotals,
    ${comparisonSql('s.kastaiVilkiko', 's.locked_kastaiVilkiko')} AS currentLocked,
    CASE WHEN t.id IS NULL THEN 'missing'
      WHEN t.uzdavinio_masina = 0 THEN 'zero'
      WHEN m.id IS NULL THEN 'populated_without_master' ELSE 'populated_with_master' END AS assignedTruck,
    ${comparisonSql('t.kastaiVilkiko', 's.locked_kastaiVilkiko')} AS taskLockedTotals,
    ${valueClassSql('t.kastaiVilkiko')} AS taskTruckValue,
    ${valueClassSql('s.kastaiVilkiko')} AS summaryCurrentValue,
    ${valueClassSql('s.locked_kastaiVilkiko')} AS summaryLockedValue,
    CASE WHEN s.uzdavinys IS NULL THEN 'missing'
      WHEN s.deleted = 0 THEN 'zero' WHEN s.deleted = 1 THEN 'one' ELSE 'other' END AS summaryDeletedFlag,
    ${dateStateSql('s.kastai_data')} AS summaryCurrentDate,
    ${dateStateSql('s.locked_kastaiVilkiko_data')} AS summaryLockedDate,
    CASE WHEN s.kastai_data IS NULL AND s.locked_kastaiVilkiko_data IS NULL THEN 'both_missing'
      WHEN s.kastai_data IS NULL THEN 'left_missing'
      WHEN s.locked_kastaiVilkiko_data IS NULL THEN 'right_missing'
      WHEN NOT (${validDateSql('s.kastai_data')} AND ${validDateSql('s.locked_kastaiVilkiko_data')}) THEN 'unclassified'
      WHEN s.kastai_data = s.locked_kastaiVilkiko_data THEN 'equal'
      WHEN s.kastai_data < s.locked_kastaiVilkiko_data THEN 'current_before_locked'
      ELSE 'current_after_locked' END AS currentLockedDate
  FROM (SELECT ? AS task_id) requested
  LEFT JOIN uzdaviniai t ON t.id = requested.task_id
  LEFT JOIN kastai_fiksuoti_ataskaita s ON s.uzdavinys = requested.task_id
  LEFT JOIN masinos m ON m.id = NULLIF(t.uzdavinio_masina, 0)`;

// The task-date PK allows unbounded per-task fan-out. Read only LIMIT + 1
// covering-index entries (task, date); never read component amounts or return raw rows.
// The same task ID is bound twice: once for the bounded detail prefix, once for
// the single summary PK row whose dates are compared categorically.
const detailSql = `SELECT CASE WHEN COUNT(*) = 0 THEN 'missing' ELSE 'present' END AS details,
    CASE WHEN COUNT(*) = 0 THEN 'zero' WHEN COUNT(*) = 1 THEN 'one'
      WHEN COUNT(*) > ${fixedCostDiagnosticDetailLimit} THEN 'over_limit' ELSE 'multiple' END AS detailCardinality,
    ${detailDateSql('s.kastai_data')} AS detailCurrentDate,
    ${detailDateSql('s.locked_kastaiVilkiko_data')} AS detailLockedDate
  FROM (SELECT kastai_data FROM kastai_fiksuoti_vilkikai_det
    WHERE uzdavinys = ? LIMIT ${fixedCostDiagnosticDetailLimit + 1}) d
  LEFT JOIN kastai_fiksuoti_ataskaita s ON s.uzdavinys = ?`;

export class FixedCostDiagnosticError extends ReplicaDiagnosticError {
  readonly code: 'QUERY_TIMEOUT' | 'REPLICA_UNAVAILABLE';
  readonly statusCode: 504 | 503;

  constructor(error: unknown) {
    const timeout = isQueryTimeout(error);
    super(timeout ? 'Fixed-cost diagnostic query timed out' : 'Fixed-cost diagnostic unavailable', error);
    this.name = 'FixedCostDiagnosticError';
    this.code = timeout ? 'QUERY_TIMEOUT' : 'REPLICA_UNAVAILABLE';
    this.statusCode = timeout ? 504 : 503;
  }
}

function onlyRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (rows.length !== 1) throw new Error('Incomplete fixed-cost diagnostic');
  return rows[0];
}

function category<K extends keyof FixedCostDiagnosticCategories>(row: Record<string, unknown>, key: K): FixedCostDiagnosticCategories[K] {
  const value = row[key];
  if (typeof value !== 'string' || !(fixedCostDiagnosticCategories[key] as readonly string[]).includes(value)) {
    throw new Error('Invalid fixed-cost diagnostic category');
  }
  return value as FixedCostDiagnosticCategories[K];
}

/** Internal only. Supply a ReplicaPool created with the configured query timeout.
 * At most 40 sequential statements; no app route or separate concurrency gate.
 * Completeness describes the supplied sample and detail bound, not reconciliation
 * or a cross-statement snapshot of the live replica.
 */
export async function diagnoseFixedCosts(pool: ReplicaPool, input: unknown): Promise<FixedCostDiagnosticResult> {
  const { taskIds } = parseFixedCostDiagnosticInput(input);
  const data: FixedCostDiagnosticResult['data'] = [];
  try {
    for (const [inputPosition, taskId] of taskIds.entries()) {
      const summary = onlyRow(await queryReadOnly<Record<string, unknown>[]>(pool, taskSummarySql, [taskId]));
      const detail = onlyRow(await queryReadOnly<Record<string, unknown>[]>(pool, detailSql, [taskId, taskId]));
      data.push({
        inputPosition,
        task: category(summary, 'task'),
        summary: category(summary, 'summary'),
        summaryCardinality: category(summary, 'summaryCardinality'),
        truckTotals: category(summary, 'truckTotals'),
        currentLocked: category(summary, 'currentLocked'),
        assignedTruck: category(summary, 'assignedTruck'),
        details: category(detail, 'details'),
        detailCardinality: category(detail, 'detailCardinality'),
        taskLockedTotals: category(summary, 'taskLockedTotals'),
        taskTruckValue: category(summary, 'taskTruckValue'),
        summaryCurrentValue: category(summary, 'summaryCurrentValue'),
        summaryLockedValue: category(summary, 'summaryLockedValue'),
        summaryDeletedFlag: category(summary, 'summaryDeletedFlag'),
        summaryCurrentDate: category(summary, 'summaryCurrentDate'),
        summaryLockedDate: category(summary, 'summaryLockedDate'),
        currentLockedDate: category(summary, 'currentLockedDate'),
        detailCurrentDate: category(detail, 'detailCurrentDate'),
        detailLockedDate: category(detail, 'detailLockedDate'),
      });
    }
    return { data, meta: { sampleSize: taskIds.length, complete: data.every(row => row.detailCardinality !== 'over_limit') } };
  } catch (error) {
    throw new FixedCostDiagnosticError(error);
  }
}
