import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool, queryReadOnly } from '../../src/db/replica.js';
import { fixedCostMonetaryMaxRecords, parseFixedCostMonetaryQuery } from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostMonetaryStatement } from '../../src/fixed-costs/monetary-repository.js';
import { truckFixedCostPilotSemanticsVersion } from '../../src/fixed-costs/pilot-summary.js';

/**
 * Opt-in only. `FIXED_COST_PILOT_TEST_MONTH` names one settled `YYYY-MM-01` month.
 *
 * Exercises the real Slice 6P route against the configured replica with the pilot
 * flag forced on for this process only. Output is status, counters, duration and
 * EXPLAIN access metadata. **No monetary amount, task ID, truck ID or row is
 * printed**, and assertion failures are rethrown without their actual values.
 */
const requested = process.env.FIXED_COST_PILOT_TEST_MONTH;

test('opt-in live truck fixed-cost summary pilot', { skip: requested === undefined }, async () => {
  const query = parseFixedCostMonetaryQuery({
    allocationScope: 'truck', representation: 'locked', periodMonth: requested, limit: fixedCostMonetaryMaxRecords,
  });
  const [year, monthNumber] = query.periodMonth.split('-').map(Number);
  const dateTo = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const config = loadConfig({ ...process.env, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'true' });
  const app = buildApp(config);
  const headers = { authorization: `Bearer ${config.auth.serviceToken}` };
  const url = `/expense-analytics/fixed-costs/summary?allocationScope=truck&dateFrom=${query.periodMonth}&dateTo=${dateTo}`;
  try {
    assert.equal((await app.inject(url)).statusCode, 401, 'Authentication still required');

    const started = performance.now();
    const response = await app.inject({ url, headers });
    const durationMs = Math.round(performance.now() - started);
    const body = response.json();
    if (response.statusCode !== 200) {
      console.log('Fixed-cost pilot', JSON.stringify({ status: response.statusCode, code: body.error?.code, durationMs }));
    }
    assert.equal(response.statusCode, 200, 'Settled month succeeds');
    const { data, meta } = body;
    assert.deepEqual(Object.keys(data), ['allocationScope', 'periodMonth', 'amount', 'currency', 'representation', 'totalTaskCount', 'lockedTaskCount']);
    assert.ok(typeof data.amount === 'string' && /^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(data.amount), 'Amount is canonical two-scale decimal text');
    assert.ok(data.allocationScope === 'truck' && data.periodMonth === query.periodMonth && data.currency === 'EUR' && data.representation === 'locked');
    assert.ok(Number.isSafeInteger(data.totalTaskCount) && data.totalTaskCount > 0, 'Non-empty settled month');
    assert.equal(data.lockedTaskCount, data.totalTaskCount, 'Fully locked included population');
    assert.equal(meta.semanticsVersion, truckFixedCostPilotSemanticsVersion);
    assert.ok(meta.complete === true && meta.pilot === true && meta.reconciliationStatus === 'provisional_unreconciled_erp_reference');
    assert.ok(meta.limitations.length >= 4);

    // Disabled capabilities stay disabled against the live configuration.
    for (const endpoint of ['breakdown', 'dimensions']) {
      assert.equal((await app.inject({ url: url.replace('summary', endpoint), headers })).statusCode, 422, endpoint);
    }

    // EXPLAIN for the exact statement the pilot executes. Access metadata only.
    const plan = await queryReadOnly<Record<string, unknown>[]>(
      app.replica, `EXPLAIN ${fixedCostMonetaryStatement(query)}`, [query.periodMonth, query.periodEnd],
    );
    const access = plan.map(row => ({
      id: row.id, selectType: row.select_type, table: row.table, type: row.type,
      key: row.key, rows: row.rows === null || row.rows === undefined ? null : Number(row.rows), extra: row.Extra,
    }));
    console.log('Fixed-cost pilot', JSON.stringify({
      status: response.statusCode, durationMs, totalTaskCount: data.totalTaskCount, lockedTaskCount: data.lockedTaskCount,
      complete: meta.complete, recordLimit: fixedCostMonetaryMaxRecords,
    }));
    console.log('Fixed-cost pilot EXPLAIN', JSON.stringify(access));
    const summaryAccess = access.find(row => row.table === 'a');
    assert.ok(summaryAccess, 'Summary table access is reported');
  } catch (error) {
    if (error instanceof assert.AssertionError) throw new Error(`Fixed-cost pilot assertion failed: ${error.message}`);
    throw new Error('Fixed-cost pilot integration failed');
  } finally {
    try { await app.close(); } catch { throw new Error('Fixed-cost pilot app close failed'); }
  }
});
