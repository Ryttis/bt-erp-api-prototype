import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { queryReadOnly, safeDriverDiagnostics } from '../../src/db/replica.js';
import { fixedCostMonetaryMaxRecords, parseFixedCostMonetaryQuery } from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostMonetaryStatement } from '../../src/fixed-costs/monetary-repository.js';
import { truckFixedCostPilotSemanticsVersion } from '../../src/fixed-costs/pilot-summary.js';

/**
 * Opt-in only. `FIXED_COST_PILOT_TEST_MONTH` names one settled `YYYY-MM-01` month.
 *
 * Exercises the real Slice 6P route against the configured replica with the pilot
 * flag forced on for this process only. Output is status, counters, duration and
 * EXPLAIN access metadata. **No monetary amount, task ID, truck ID or row is
 * printed**. Failures name the stage that failed and a safe cause: the assertion
 * message (never its actual values), sanitized driver diagnostics, or the error
 * name and message of a non-driver error.
 */

/** EXPLAIN numeric columns arrive as BigInt from the driver; JSON cannot serialize BigInt. */
const planNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

function safeFailure(stage: string, error: unknown): Error {
  if (error instanceof assert.AssertionError) return new Error(`Fixed-cost pilot ${stage} assertion failed: ${error.message}`);
  const source = error as Record<string, unknown> | null;
  if (source && typeof source === 'object' && ('sqlState' in source || 'errno' in source || 'cause' in source)) {
    return new Error(`Fixed-cost pilot ${stage} failed: ${JSON.stringify(safeDriverDiagnostics(error))}`);
  }
  // Non-driver errors raised by this test or the app carry no row data.
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : '';
  return new Error(`Fixed-cost pilot ${stage} failed: ${name}: ${message}`);
}

const requested = process.env.FIXED_COST_PILOT_TEST_MONTH;

test('opt-in live truck fixed-cost summary pilot', { skip: requested === undefined }, async () => {
  const query = parseFixedCostMonetaryQuery({
    allocationScope: 'truck', representation: 'locked', periodMonth: requested, limit: fixedCostMonetaryMaxRecords,
  });
  const [year, monthNumber] = query.periodMonth.split('-').map(Number);
  const dateTo = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const config = loadConfig({ ...process.env, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'true' });
  const app = buildApp(config);
  const disabledApp = buildApp(loadConfig({ ...process.env, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'false' }));
  let stage = 'setup';
  const headers = { authorization: `Bearer ${config.auth.serviceToken}` };
  const url = `/expense-analytics/fixed-costs/summary?allocationScope=truck&dateFrom=${query.periodMonth}&dateTo=${dateTo}`;
  try {
    stage = 'authentication';
    assert.equal((await app.inject(url)).statusCode, 401, 'Authentication still required');

    stage = 'flag-off';
    const disabled = await disabledApp.inject({ url, headers });
    assert.equal(disabled.statusCode, 422, 'Flag off refuses the pilot request');
    assert.equal(disabled.json().error.code, 'SEMANTICS_UNVERIFIED', 'Flag off keeps the pre-pilot error');

    stage = 'pilot request';
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
    stage = 'unsupported requests';
    for (const endpoint of ['breakdown', 'dimensions']) {
      const blocked = await app.inject({ url: url.replace('summary', endpoint), headers });
      assert.equal(blocked.statusCode, 422, endpoint);
      assert.equal(blocked.json().error.code, 'SEMANTICS_UNVERIFIED', endpoint);
    }
    const otherScope = await app.inject({ url: url.replace('allocationScope=truck', 'allocationScope=trailer'), headers });
    assert.equal(otherScope.statusCode, 422, 'Other scopes stay disabled');
    assert.equal((await app.inject({ url: `${url}&representation=current`, headers })).statusCode, 400, 'Request cannot select a representation');

    // EXPLAIN for the exact statement the pilot executes. Access metadata only.
    stage = 'EXPLAIN';
    const plan = await queryReadOnly<Record<string, unknown>[]>(
      app.replica, `EXPLAIN ${fixedCostMonetaryStatement(query)}`, [query.periodMonth, query.periodEnd],
    );
    const access = plan.map(row => ({
      id: planNumber(row.id), selectType: row.select_type, table: row.table, type: row.type,
      possibleKeys: row.possible_keys, key: row.key, keyLength: row.key_len, rows: planNumber(row.rows), extra: row.Extra,
    }));
    console.log('Fixed-cost pilot', JSON.stringify({
      status: response.statusCode, durationMs, totalTaskCount: data.totalTaskCount, lockedTaskCount: data.lockedTaskCount,
      complete: meta.complete, recordLimit: fixedCostMonetaryMaxRecords,
    }));
    console.log('Fixed-cost pilot EXPLAIN', JSON.stringify(access));
    const summaryAccess = access.find(row => row.table === 'a');
    assert.ok(summaryAccess, 'Summary table access is reported');
  } catch (error) {
    throw safeFailure(stage, error);
  } finally {
    try { await Promise.all([app.close(), disabledApp.close()]); } catch { throw new Error('Fixed-cost pilot app close failed'); }
  }
});
