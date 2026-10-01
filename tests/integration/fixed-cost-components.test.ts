import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { queryReadOnly, safeDriverDiagnostics } from '../../src/db/replica.js';
import { fixedCostBreakdownSources, fixedCostMonetaryMaxRecords, parseFixedCostMonetaryQuery } from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostComponentFields, fixedCostRankedComponentStatement } from '../../src/fixed-costs/monetary-repository.js';
import { truckFixedCostComponentsSemanticsVersion } from '../../src/fixed-costs/pilot-components.js';

/**
 * Opt-in only. `FIXED_COST_PILOT_TEST_MONTH` names one or more settled `YYYY-MM-01`
 * months, comma-separated.
 *
 * Exercises the real components route against the configured replica with the truck
 * pilot flag forced on for this process only, and reconciles it against the summary
 * endpoint and independent direct reads. Output is status, counters, booleans,
 * duration and EXPLAIN access metadata. **No monetary amount, task ID, truck ID or
 * row is printed**; assertion messages never carry values.
 */

const planNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

function safeFailure(stage: string, error: unknown): Error {
  if (error instanceof assert.AssertionError) return new Error(`Fixed-cost components ${stage} assertion failed: ${error.message}`);
  const source = error as Record<string, unknown> | null;
  if (source && typeof source === 'object' && ('sqlState' in source || 'errno' in source || 'cause' in source)) {
    return new Error(`Fixed-cost components ${stage} failed: ${JSON.stringify(safeDriverDiagnostics(error))}`);
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : '';
  return new Error(`Fixed-cost components ${stage} failed: ${name}: ${message}`);
}

const requested = process.env.FIXED_COST_PILOT_TEST_MONTH;
const months = requested?.split(',') ?? [];
const detail = fixedCostBreakdownSources.locked;

for (const requestedMonth of months) {
  test(`opt-in live truck fixed-cost components pilot ${requestedMonth}`, async () => {
    const query = parseFixedCostMonetaryQuery({
      allocationScope: 'truck', representation: 'locked', periodMonth: requestedMonth, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
    });
    const [year, monthNumber] = query.periodMonth.split('-').map(Number);
    const dateTo = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    const config = loadConfig({ ...process.env, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'true' });
    const app = buildApp(config);
    const disabledApp = buildApp(loadConfig({ ...process.env, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'false' }));
    const headers = { authorization: `Bearer ${config.auth.serviceToken}` };
    const period = `allocationScope=truck&dateFrom=${query.periodMonth}&dateTo=${dateTo}`;
    const url = `/expense-analytics/fixed-costs/components?${period}`;
    let stage = 'setup';
    try {
      stage = 'authentication';
      assert.equal((await app.inject(url)).statusCode, 401, 'Authentication still required');

      stage = 'flag-off';
      const disabled = await disabledApp.inject({ url, headers });
      assert.equal(disabled.statusCode, 422, 'Flag off refuses');
      assert.equal(disabled.json().error.code, 'SEMANTICS_UNVERIFIED', 'Flag off keeps the pre-pilot error');

      stage = 'components request';
      const started = performance.now();
      const response = await app.inject({ url, headers });
      const durationMs = Math.round(performance.now() - started);
      const body = response.json();
      if (response.statusCode !== 200) {
        console.log('Fixed-cost components', JSON.stringify({ status: response.statusCode, code: body.error?.code, durationMs }));
      }
      assert.equal(response.statusCode, 200, 'Settled month succeeds');
      const { data, meta } = body;
      assert.equal(data.components.length, fixedCostComponentFields.length, 'Every component is listed');
      assert.deepEqual([...data.components.map((entry: { component: string }) => entry.component)].sort(), [...fixedCostComponentFields].sort(), 'Exactly the verified keys');
      for (const entry of data.components) assert.ok(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(entry.amount), 'Component amount is two-scale decimal text');
      assert.ok(meta.semanticsVersion === truckFixedCostComponentsSemanticsVersion && meta.complete === true && meta.pilot === true);
      assert.equal(data.reconciliation.componentsSumToComponentTotal, true);

      stage = 'summary reconciliation';
      const summary = (await app.inject({ url: `/expense-analytics/fixed-costs/summary?${period}`, headers })).json();
      assert.ok(data.authoritativeAmount === summary.data.amount, 'authoritativeAmount equals the summary amount');
      assert.ok(data.totalTaskCount === summary.data.totalTaskCount, 'Task count equals the summary');
      assert.ok(data.reconciliation.comparableTaskCount + data.reconciliation.noDetailTaskCount
        + data.reconciliation.multipleDetailTaskCount === data.totalTaskCount, 'Structural classes cover the included tasks');

      // Independent read: the same comparable population, summed directly per column.
      stage = 'direct component read';
      const [direct] = await queryReadOnly<Record<string, string | null>[]>(app.replica, `SELECT
        ${fixedCostComponentFields.map(field => `CAST(SUM(d.${field}) AS CHAR) AS ${field}`).join(',\n        ')}
        FROM kastai_fiksuoti_ataskaita a
        JOIN ${detail} d ON d.uzdavinys = a.uzdavinys
        WHERE a.kastai_data >= ? AND a.kastai_data < ? AND a.deleted = 0 AND a.locked_kastaiVilkiko IS NOT NULL
          AND (SELECT COUNT(*) FROM ${detail} d2 WHERE d2.uzdavinys = a.uzdavinys) = 1`, [query.periodMonth, query.periodEnd]);
      const directMatches = data.components.filter((entry: { component: string; amount: string }) => direct[entry.component] === entry.amount).length;
      assert.equal(directMatches, fixedCostComponentFields.length, 'Every component equals the direct comparable sum');

      // Independent ordering and additivity checks, both evaluated by the database.
      stage = 'database ordering check';
      const values = data.components.flatMap((entry: { component: string; amount: string }) => [entry.component, entry.amount]);
      const ordered = await queryReadOnly<{ component: string }[]>(app.replica, `SELECT x.component FROM (
        ${data.components.map(() => 'SELECT CAST(? AS CHAR) AS component, CAST(? AS DECIMAL(65,6)) AS amount').join(' UNION ALL ')}
      ) x ORDER BY x.amount DESC, CAST(x.component AS BINARY) ASC`, values);
      assert.deepEqual(ordered.map(row => row.component), data.components.map((entry: { component: string }) => entry.component), 'Response order is amount DESC, component ASC');
      const [sum] = await queryReadOnly<{ equal: unknown }[]>(app.replica, `SELECT CASE WHEN
        ${data.components.map(() => 'CAST(? AS DECIMAL(65,6))').join(' + ')} = CAST(? AS DECIMAL(65,6)) THEN 1 ELSE 0 END AS equal`,
      [...data.components.map((entry: { amount: string }) => entry.amount), data.reconciliation.componentTotal]);
      assert.equal(Number(sum.equal), 1, 'Listed components add up to componentTotal');
      const [gap] = await queryReadOnly<{ equal: unknown }[]>(app.replica, `SELECT CASE WHEN
        CAST(? AS DECIMAL(65,6)) - CAST(? AS DECIMAL(65,6)) = CAST(? AS DECIMAL(65,6)) THEN 1 ELSE 0 END AS equal`,
      [data.reconciliation.comparableAuthoritativeAmount, data.reconciliation.componentTotal, data.reconciliation.netDifference]);
      assert.equal(Number(gap.equal), 1, 'netDifference = comparableAuthoritativeAmount - componentTotal');

      stage = 'single component';
      for (const entry of [data.components[0], data.components[data.components.length - 1]]) {
        const single = await app.inject({ url: `${url}&component=${entry.component}`, headers });
        assert.equal(single.statusCode, 200, 'Single component succeeds');
        assert.equal(single.json().data.components.length, 1, 'Exactly one component');
        assert.ok(single.json().data.components[0].amount === entry.amount, 'Single amount equals the listed amount');
        assert.ok(single.json().data.authoritativeAmount === data.authoritativeAmount, 'Same authoritative total');
      }

      stage = 'refusals';
      assert.equal((await app.inject({ url: `${url}&component=tires`, headers })).statusCode, 400, 'Unknown component');
      assert.equal((await app.inject({ url: `${url}&component=PADANGOS`, headers })).statusCode, 400, 'Case-variant component');
      assert.equal((await app.inject({ url: `${url}&truckId=1`, headers })).statusCode, 400, 'No truck selector');
      assert.equal((await app.inject({ url: `${url}&sortBy=amount`, headers })).statusCode, 400, 'No sorting input');
      const trailer = await app.inject({ url: url.replace('allocationScope=truck', 'allocationScope=trailer'), headers });
      assert.equal(trailer.statusCode, 422, 'Trailer scope is not enabled here');
      const partial = await app.inject({ url: url.replace(`dateTo=${dateTo}`, `dateTo=${query.periodMonth.slice(0, 8)}15`), headers });
      assert.equal(partial.json().error?.code, 'PERIOD_NOT_COMPLETE_MONTH', 'Partial month refused');

      stage = 'EXPLAIN';
      const plan = (await queryReadOnly<Record<string, unknown>[]>(
        app.replica, `EXPLAIN ${fixedCostRankedComponentStatement(query)}`, [query.periodMonth, query.periodEnd],
      )).map(row => ({ id: planNumber(row.id), selectType: row.select_type, table: row.table, type: row.type, key: row.key, rows: planNumber(row.rows) }));

      const nonZero = data.components.filter((entry: { amount: string }) => !/^-?0\.0+$/.test(entry.amount)).length;
      const negative = data.components.filter((entry: { amount: string }) => entry.amount.startsWith('-')).length;
      console.log('Fixed-cost components', JSON.stringify({
        month: query.periodMonth, status: response.statusCode, durationMs, totalTaskCount: data.totalTaskCount,
        comparableTaskCount: data.reconciliation.comparableTaskCount, noDetailTaskCount: data.reconciliation.noDetailTaskCount,
        multipleDetailTaskCount: data.reconciliation.multipleDetailTaskCount, affectedTaskCount: data.reconciliation.affectedTaskCount,
        authoritativeEqualsSummary: true, componentsEqualDirect: true, orderVerified: true,
        nonZeroComponents: nonZero, negativeComponents: negative,
        authoritativeEqualsComponentTotal: data.authoritativeAmount === data.reconciliation.componentTotal,
      }));
      console.log('Fixed-cost components EXPLAIN', JSON.stringify(plan));
    } catch (error) {
      throw safeFailure(stage, error);
    } finally {
      try { await Promise.all([app.close(), disabledApp.close()]); } catch { throw new Error('Fixed-cost components app close failed'); }
    }
  });
}

if (requested === undefined) test('opt-in live truck fixed-cost components pilot', { skip: true }, () => {});
