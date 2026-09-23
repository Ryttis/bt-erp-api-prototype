import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool } from '../../src/db/replica.js';
import { fixedCostDiagnosticCategories, parseFixedCostDiagnosticTaskIds } from '../../src/fixed-costs/diagnostic-contract.js';
import { diagnoseFixedCosts, FixedCostDiagnosticError } from '../../src/fixed-costs/diagnostic-repository.js';

test('opt-in bounded truck fixed-cost diagnostics', {
  skip: process.env.FIXED_COST_DIAGNOSTIC_TASK_IDS === undefined,
}, async () => {
  // Validate before even creating the pool. Invalid input errors contain no input.
  const input = parseFixedCostDiagnosticTaskIds(process.env.FIXED_COST_DIAGNOSTIC_TASK_IDS);
  const config = loadConfig();
  const pool = createReplicaPool(config.replica, config.safety.queryTimeoutMs);
  try {
    const result = await diagnoseFixedCosts(pool, input);
    assert.ok(result.meta.sampleSize === input.taskIds.length, 'Diagnostic sample size');
    assert.ok(result.data.length === result.meta.sampleSize, 'Diagnostic result count');
    const counts: Record<string, Record<string, number>> = {};
    for (const key of Object.keys(fixedCostDiagnosticCategories) as (keyof typeof fixedCostDiagnosticCategories)[]) {
      counts[key] = Object.fromEntries(fixedCostDiagnosticCategories[key].map(value => [value, 0]));
      for (const row of result.data) {
        assert.ok(Object.hasOwn(counts[key], row[key]), 'Allowlisted category');
        counts[key][row[key]]++;
      }
    }
    assert.ok(result.meta.complete === (counts.detailCardinality.over_limit === 0), 'Diagnostic completeness');
    // Co-occurrence of allowlisted categories: counts per combined pattern, with no input position.
    const patterns: Record<string, number> = {};
    for (const row of result.data) {
      const pattern = (Object.keys(fixedCostDiagnosticCategories) as (keyof typeof fixedCostDiagnosticCategories)[]).map(key => `${key}=${row[key]}`).join(';');
      patterns[pattern] = (patterns[pattern] ?? 0) + 1;
    }
    console.log('Fixed-cost diagnostic category counts', JSON.stringify({ sampleSize: result.meta.sampleSize, complete: result.meta.complete, counts }));
    console.log('Fixed-cost diagnostic category patterns', JSON.stringify(patterns));
  } catch (error) {
    // Never let the test runner render a driver error, assertion payload or cause.
    throw new Error(error instanceof FixedCostDiagnosticError && error.code === 'QUERY_TIMEOUT'
      ? 'Fixed-cost diagnostic integration timed out' : 'Fixed-cost diagnostic integration failed');
  } finally {
    try { await pool.end(); } catch { throw new Error('Fixed-cost diagnostic pool close failed'); }
  }
});
