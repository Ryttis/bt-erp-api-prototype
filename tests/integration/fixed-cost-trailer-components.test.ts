import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { queryReadOnly, safeDriverDiagnostics } from '../../src/db/replica.js';
import { fixedCostTrailerBreakdownSources } from '../../src/fixed-costs/monetary-contract.js';
import {
  fixedCostComponentFields, fixedCostRankedComponentStatement, fixedCostTrailerComponentFields, trailerFleetComponentsQuery,
} from '../../src/fixed-costs/monetary-repository.js';
import { trailerFleetFixedCostComponentsSemanticsVersion } from '../../src/fixed-costs/pilot-trailer-components.js';

/**
 * Opt-in only. `FIXED_COST_TRAILER_COMPONENTS_TEST_MONTHS` names one or more settled
 * `YYYY-MM-01` months, comma-separated.
 *
 * Exercises the real components route for the trailer scope against the configured
 * replica with the trailer pilot flag forced on for this process only, and reconciles
 * it against the fleet trailer summary and independent direct reads. Output is
 * status, counters, booleans, duration and EXPLAIN access metadata. **No monetary
 * amount, task ID, trailer ID or row is printed**; assertion messages never carry values.
 */

const planNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

function safeFailure(stage: string, error: unknown): Error {
  if (error instanceof assert.AssertionError) return new Error(`Trailer components ${stage} assertion failed: ${error.message}`);
  const source = error as Record<string, unknown> | null;
  if (source && typeof source === 'object' && ('sqlState' in source || 'errno' in source || 'cause' in source)) {
    return new Error(`Trailer components ${stage} failed: ${JSON.stringify(safeDriverDiagnostics(error))}`);
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : '';
  return new Error(`Trailer components ${stage} failed: ${name}: ${message}`);
}

const requested = process.env.FIXED_COST_TRAILER_COMPONENTS_TEST_MONTHS;
const months = requested?.split(',').map(month => month.trim()) ?? [];
const detail = fixedCostTrailerBreakdownSources.locked;
const fields = fixedCostTrailerComponentFields;
type Entry = { component: string; amount: string };

for (const requestedMonth of months) {
  test(`opt-in live fleet trailer fixed-cost components pilot ${requestedMonth}`, async () => {
    const query = trailerFleetComponentsQuery(requestedMonth);
    const [year, monthNumber] = query.periodMonth.split('-').map(Number);
    const dateTo = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    const config = loadConfig({ ...process.env, ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'true' });
    const app = buildApp(config);
    const disabledApp = buildApp(loadConfig({ ...process.env, ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'false' }));
    const headers = { authorization: `Bearer ${config.auth.serviceToken}` };
    const period = `allocationScope=trailer&dateFrom=${query.periodMonth}&dateTo=${dateTo}`;
    const url = `/expense-analytics/fixed-costs/components?${period}`;
    const bounds = [query.periodMonth, query.periodEnd];
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
        console.log('Trailer components', JSON.stringify({ status: response.statusCode, code: body.error?.code, durationMs }));
      }
      assert.equal(response.statusCode, 200, 'Settled month succeeds');
      const { data, meta } = body;
      assert.equal(data.components.length, fields.length, 'Every trailer component is listed');
      assert.deepEqual(data.components.map((entry: Entry) => entry.component).sort(), [...fields].sort(), 'Exactly the trailer keys');
      for (const entry of data.components) assert.ok(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(entry.amount), 'Component amount is two-scale decimal text');
      assert.ok(meta.semanticsVersion === trailerFleetFixedCostComponentsSemanticsVersion && meta.complete === true && meta.pilot === true);
      assert.equal(meta.componentSource, detail, 'Locked trailer detail source');
      assert.equal(data.reconciliation.componentsSumToComponentTotal, true);

      stage = 'fleet summary reconciliation';
      const summary = (await app.inject({ url: `/expense-analytics/fixed-costs/summary?${period}`, headers })).json();
      assert.ok(data.authoritativeAmount === summary.data.amount, 'authoritativeAmount equals the fleet trailer summary amount');
      assert.ok(data.totalTaskCount === summary.data.totalTaskCount, 'Task count equals the fleet summary');
      assert.ok(data.lockedTaskCount === summary.data.lockedTaskCount, 'Locked count equals the fleet summary');
      assert.ok(data.reconciliation.comparableTaskCount + data.reconciliation.noDetailTaskCount
        + data.reconciliation.multipleDetailTaskCount === data.totalTaskCount, 'Structural classes cover the included tasks');

      // Independent reads: the stored total, and the same comparable population summed directly per column.
      stage = 'direct authoritative read';
      const [stored] = await queryReadOnly<{ total: string | null; records: unknown }[]>(app.replica, `SELECT
        CAST(SUM(a.locked_kastaiPriekabos) AS CHAR) AS total, COUNT(*) AS records
        FROM kastai_fiksuoti_ataskaita a
        WHERE a.kastai_data >= ? AND a.kastai_data < ? AND a.deleted = 0`, bounds);
      assert.ok(stored.total === data.authoritativeAmount, 'authoritativeAmount equals the direct stored sum');
      assert.equal(Number(stored.records), data.totalTaskCount, 'Task count equals the direct count');

      stage = 'direct component read';
      const [direct] = await queryReadOnly<Record<string, string | null>[]>(app.replica, `SELECT
        COUNT(*) AS comparable,
        ${fields.map(field => `CAST(SUM(d.${field}) AS CHAR) AS ${field}`).join(',\n        ')}
        FROM kastai_fiksuoti_ataskaita a
        JOIN ${detail} d ON d.uzdavinys = a.uzdavinys
        WHERE a.kastai_data >= ? AND a.kastai_data < ? AND a.deleted = 0 AND a.locked_kastaiPriekabos IS NOT NULL
          AND (${fields.map(field => `d.${field}`).join(' + ')}) IS NOT NULL
          AND (SELECT COUNT(*) FROM ${detail} d2 WHERE d2.uzdavinys = a.uzdavinys) = 1`, bounds);
      assert.equal(Number(direct.comparable), data.reconciliation.comparableTaskCount, 'Comparable count equals the direct count');
      const directMatches = data.components.filter((entry: Entry) => direct[entry.component] === entry.amount).length;
      assert.equal(directMatches, fields.length, 'Every component equals the direct comparable sum');

      // Independent ordering, additivity and gap checks, all evaluated by the database.
      stage = 'database ordering check';
      const values = data.components.flatMap((entry: Entry) => [entry.component, entry.amount]);
      const ordered = await queryReadOnly<{ component: string }[]>(app.replica, `SELECT x.component FROM (
        ${data.components.map(() => 'SELECT CAST(? AS CHAR) AS component, CAST(? AS DECIMAL(65,6)) AS amount').join(' UNION ALL ')}
      ) x ORDER BY x.amount DESC, CAST(x.component AS BINARY) ASC`, values);
      assert.deepEqual(ordered.map(row => row.component), data.components.map((entry: Entry) => entry.component), 'Response order is amount DESC, component ASC');
      const [sum] = await queryReadOnly<{ equal: unknown }[]>(app.replica, `SELECT CASE WHEN
        ${data.components.map(() => 'CAST(? AS DECIMAL(65,6))').join(' + ')} = CAST(? AS DECIMAL(65,6)) THEN 1 ELSE 0 END AS equal`,
      [...data.components.map((entry: Entry) => entry.amount), data.reconciliation.componentTotal]);
      assert.equal(Number(sum.equal), 1, 'Listed components add up to componentTotal');
      const [gap] = await queryReadOnly<{ equal: unknown }[]>(app.replica, `SELECT CASE WHEN
        CAST(? AS DECIMAL(65,6)) - CAST(? AS DECIMAL(65,6)) = CAST(? AS DECIMAL(65,6)) THEN 1 ELSE 0 END AS equal`,
      [data.reconciliation.comparableAuthoritativeAmount, data.reconciliation.componentTotal, data.reconciliation.netDifference]);
      assert.equal(Number(gap.equal), 1, 'netDifference = comparableAuthoritativeAmount - componentTotal');

      stage = 'single component padangos';
      const tyres = await app.inject({ url: `${url}&component=padangos`, headers });
      assert.equal(tyres.statusCode, 200, 'padangos succeeds');
      assert.deepEqual(tyres.json().data.components.map((entry: Entry) => entry.component), ['padangos'], 'Exactly padangos');
      assert.ok(tyres.json().data.components[0].amount === direct.padangos, 'padangos equals the direct comparable sum');
      assert.ok(tyres.json().data.authoritativeAmount === data.authoritativeAmount, 'Same authoritative total');

      stage = 'refusals';
      for (const key of ['tires', 'PADANGOS', ...fixedCostComponentFields.filter(field => !(fields as readonly string[]).includes(field)).slice(0, 2)]) {
        assert.equal((await app.inject({ url: `${url}&component=${key}`, headers })).statusCode, 400, 'Unknown, case-variant or truck-only key');
      }
      assert.equal((await app.inject({ url: `${url}&trailerId=1`, headers })).statusCode, 400, 'No trailer selector');
      assert.equal((await app.inject({ url: `${url}&sortBy=amount`, headers })).statusCode, 400, 'No sorting input');
      const truck = await app.inject({ url: url.replace('allocationScope=trailer', 'allocationScope=truck'), headers });
      assert.equal(truck.statusCode, 422, 'Truck scope is not enabled by the trailer flag');
      const partial = await app.inject({ url: url.replace(`dateTo=${dateTo}`, `dateTo=${query.periodMonth.slice(0, 8)}15`), headers });
      assert.equal(partial.json().error?.code, 'PERIOD_NOT_COMPLETE_MONTH', 'Partial month refused');

      stage = 'EXPLAIN';
      const plan = (await queryReadOnly<Record<string, unknown>[]>(app.replica, `EXPLAIN ${fixedCostRankedComponentStatement(query)}`, bounds))
        .map(row => ({ id: planNumber(row.id), selectType: row.select_type, table: row.table, type: row.type, key: row.key, rows: planNumber(row.rows) }));

      const nonZero = data.components.filter((entry: Entry) => !/^-?0\.0+$/.test(entry.amount)).length;
      const negative = data.components.filter((entry: Entry) => entry.amount.startsWith('-')).length;
      console.log('Trailer components', JSON.stringify({
        month: query.periodMonth, status: response.statusCode, durationMs, totalTaskCount: data.totalTaskCount,
        comparableTaskCount: data.reconciliation.comparableTaskCount, noDetailTaskCount: data.reconciliation.noDetailTaskCount,
        multipleDetailTaskCount: data.reconciliation.multipleDetailTaskCount, affectedTaskCount: data.reconciliation.affectedTaskCount,
        authoritativeEqualsFleetSummary: true, authoritativeEqualsDirect: true, componentsEqualDirect: true, orderVerified: true,
        padangosRank: data.components.findIndex((entry: Entry) => entry.component === 'padangos') + 1,
        nonZeroComponents: nonZero, negativeComponents: negative,
        authoritativeEqualsComponentTotal: data.authoritativeAmount === data.reconciliation.componentTotal,
      }));
      console.log('Trailer components EXPLAIN', JSON.stringify(plan));
    } catch (error) {
      throw safeFailure(stage, error);
    } finally {
      try { await Promise.all([app.close(), disabledApp.close()]); } catch { throw new Error('Trailer components app close failed'); }
    }
  });
}

if (requested === undefined) test('opt-in live fleet trailer fixed-cost components pilot', { skip: true }, () => {});
