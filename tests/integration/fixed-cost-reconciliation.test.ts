import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool } from '../../src/db/replica.js';
import {
  aggregateFixedCostDifferences, fixedCostReconciliationCategories, parseFixedCostReconciliationMonth,
  type FixedCostPeriodCounts,
} from '../../src/fixed-costs/reconciliation-contract.js';
import { explainFixedCostReconciliation, FixedCostReconciliationError, reconcileFixedCostMonth } from '../../src/fixed-costs/reconciliation-repository.js';

/**
 * Opt-in only. `FIXED_COST_RECONCILIATION_MONTHS` takes one or more settled months as
 * a comma-separated `YYYY-MM-01` list; `FIXED_COST_RECONCILIATION_MONTH` remains valid
 * for a single month. Months run sequentially through the shared analytics gate.
 *
 * Output is aggregate counters, derived percentages and plan metadata. No task ID,
 * truck identifier, date, monetary total or individual difference is printed.
 */
const requested = process.env.FIXED_COST_RECONCILIATION_MONTHS ?? process.env.FIXED_COST_RECONCILIATION_MONTH;

test('opt-in bounded closed-period truck fixed-cost reconciliation', { skip: requested === undefined }, async () => {
  // Validate every month before creating a pool. Invalid input errors carry no input.
  const months = requested!.split(',').map(value => parseFixedCostReconciliationMonth(value).month);
  assert.ok(months.length > 0 && new Set(months).size === months.length, 'Distinct months');
  const config = loadConfig();
  const pool = createReplicaPool(config.replica, config.safety.queryTimeoutMs);
  const gate = new AnalyticsGate(config.safety.analyticsConcurrency, config.safety.analyticsQueueLimit, config.safety.analyticsQueueTimeoutMs);
  try {
    const plan = await explainFixedCostReconciliation(pool, gate, months[0]);
    const compact = plan.map(row => ({
      id: row.id, select_type: row.select_type, table: row.table, type: row.type,
      key: row.key, rows: row.rows, Extra: row.Extra,
    }));
    console.log('Fixed-cost reconciliation EXPLAIN', JSON.stringify(compact, (_key, value) => typeof value === 'bigint' ? Number(value) : value));

    const current: FixedCostPeriodCounts[] = [];
    const locked: FixedCostPeriodCounts[] = [];
    for (const month of months) {
      const started = performance.now();
      const result = await reconcileFixedCostMonth(pool, gate, month);
      const durationMs = Math.round(performance.now() - started);

      assert.equal(result.meta.month, month, 'Reconciled month');
      assert.ok(result.meta.sampledTaskCount <= result.meta.taskLimit, 'Sample respects the bound');
      assert.ok(result.meta.fetchedTaskCount <= result.meta.taskLimit + 1, 'Fetch respects the hard bound');
      assert.equal(result.meta.truncated, result.meta.fetchedTaskCount > result.meta.taskLimit, 'Truncation flag');
      assert.equal(result.meta.complete, !result.meta.truncated, 'Completeness mirrors truncation');
      assert.equal(result.meta.reconciliationStatus, 'unreconciled_pending_erp_reference', 'Status stays unreconciled');

      for (const key of Object.keys(fixedCostReconciliationCategories) as (keyof typeof fixedCostReconciliationCategories)[]) {
        const values = result.data[key];
        assert.deepEqual(Object.keys(values).sort(), [...fixedCostReconciliationCategories[key]].sort(), `${key} allowlist`);
        const covered = Object.values(values).reduce((left, right) => left + right, 0);
        assert.equal(covered, result.meta.sampledTaskCount, `${key} covers the sample exactly once`);
      }
      for (const side of ['current', 'locked'] as const) {
        assert.equal(result.differences[side].sampledCount, result.meta.sampledTaskCount, `${side} distribution covers the sample`);
        assert.ok(result.differences[side].comparableCount <= result.meta.sampledTaskCount, `${side} comparable subset`);
      }
      // Counters only: no monetary value may appear among the counts or the categories.
      assert.doesNotMatch(JSON.stringify(result.counts), /\d+\.\d/, 'No monetary values among counts');
      assert.doesNotMatch(JSON.stringify(result.data), /\d+\.\d/, 'No monetary values among categories');

      current.push({ month, counts: result.counts.current });
      locked.push({ month, counts: result.counts.locked });
      console.log('Fixed-cost month', JSON.stringify({
        month, durationMs, meta: result.meta,
        current: result.differences.current, locked: result.differences.locked,
      }));
    }

    for (const granularity of ['quarter', 'year', 'total'] as const) {
      console.log(`Fixed-cost ${granularity} current`, JSON.stringify(aggregateFixedCostDifferences(current, granularity)));
      console.log(`Fixed-cost ${granularity} locked`, JSON.stringify(aggregateFixedCostDifferences(locked, granularity)));
    }
    // Aggregation must preserve counts exactly.
    const [combined] = aggregateFixedCostDifferences(current, 'total');
    assert.equal(combined.months, months.length, 'Every month aggregated');
    assert.equal(
      combined.distribution.sampledCount,
      current.reduce((sum, entry) => sum + Object.values(entry.counts).reduce((left, right) => left + right, 0), 0),
      'Aggregated sample equals the sum of monthly samples',
    );
  } catch (error) {
    // Never let the runner render a driver error, assertion payload or cause.
    if (error instanceof assert.AssertionError) throw new Error(`Fixed-cost reconciliation assertion failed: ${error.message}`);
    throw new Error(error instanceof FixedCostReconciliationError && error.code === 'QUERY_TIMEOUT'
      ? 'Fixed-cost reconciliation integration timed out' : 'Fixed-cost reconciliation integration failed');
  } finally {
    try { await pool.end(); } catch { throw new Error('Fixed-cost reconciliation pool close failed'); }
  }
});
