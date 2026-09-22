import { queryReadOnly, ReplicaDiagnosticError, type ReplicaPool } from '../db/replica.js';
import { isQueryTimeout } from '../errors.js';
import {
  fixedCostDiagnosticCategories, fixedCostDiagnosticDetailLimit, parseFixedCostDiagnosticInput,
  type FixedCostDiagnosticCategories, type FixedCostDiagnosticResult,
} from './diagnostic-contract.js';

// Two fixed query shapes, each with one bound ID. No caller-selected SQL parts.
// These equalities test structural hypotheses, not approved financial semantics.
const taskSummarySql = `SELECT
    CASE WHEN t.id IS NULL THEN 'missing' ELSE 'present' END AS task,
    CASE WHEN s.uzdavinys IS NULL THEN 'missing' ELSE 'present' END AS summary,
    CASE WHEN s.uzdavinys IS NULL THEN 'zero' ELSE 'one' END AS summaryCardinality,
    CASE WHEN t.kastaiVilkiko IS NULL AND s.kastaiVilkiko IS NULL THEN 'both_missing'
      WHEN t.kastaiVilkiko IS NULL THEN 'left_missing'
      WHEN s.kastaiVilkiko IS NULL THEN 'right_missing'
      WHEN t.kastaiVilkiko = s.kastaiVilkiko THEN 'equal' ELSE 'different' END AS truckTotals,
    CASE WHEN s.kastaiVilkiko IS NULL AND s.locked_kastaiVilkiko IS NULL THEN 'both_missing'
      WHEN s.kastaiVilkiko IS NULL THEN 'left_missing'
      WHEN s.locked_kastaiVilkiko IS NULL THEN 'right_missing'
      WHEN s.kastaiVilkiko = s.locked_kastaiVilkiko THEN 'equal' ELSE 'different' END AS currentLocked,
    CASE WHEN t.id IS NULL THEN 'missing'
      WHEN t.uzdavinio_masina = 0 THEN 'zero'
      WHEN m.id IS NULL THEN 'populated_without_master' ELSE 'populated_with_master' END AS assignedTruck
  FROM (SELECT ? AS task_id) requested
  LEFT JOIN uzdaviniai t ON t.id = requested.task_id
  LEFT JOIN kastai_fiksuoti_ataskaita s ON s.uzdavinys = requested.task_id
  LEFT JOIN masinos m ON m.id = NULLIF(t.uzdavinio_masina, 0)`;

// The task-date PK allows unbounded per-task fan-out. Count only LIMIT + 1
// covering-index entries; never read component amounts or return raw rows.
const detailSql = `SELECT CASE WHEN COUNT(*) = 0 THEN 'missing' ELSE 'present' END AS details,
    CASE WHEN COUNT(*) = 0 THEN 'zero' WHEN COUNT(*) = 1 THEN 'one'
      WHEN COUNT(*) > ${fixedCostDiagnosticDetailLimit} THEN 'over_limit' ELSE 'multiple' END AS detailCardinality
  FROM (SELECT 1 FROM kastai_fiksuoti_vilkikai_det
    WHERE uzdavinys = ? LIMIT ${fixedCostDiagnosticDetailLimit + 1}) bounded_details`;

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
      const detail = onlyRow(await queryReadOnly<Record<string, unknown>[]>(pool, detailSql, [taskId]));
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
      });
    }
    return { data, meta: { sampleSize: taskIds.length, complete: data.every(row => row.detailCardinality !== 'over_limit') } };
  } catch (error) {
    throw new FixedCostDiagnosticError(error);
  }
}
