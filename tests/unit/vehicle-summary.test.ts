import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { listVehicles, summarizeVehicles, vehicleMetrics, type VehicleMetric } from '../../src/vehicles/repository.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
function fixture(result: unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return result;
  }, end: async () => {} } as ReplicaPool;
  return { pool, calls };
}

test('summary selects only requested SQL aggregates and returns numeric JSON', async () => {
  const expected = { count: 3, sum_rent_price: 20, avg_rent_price: 10, min_rent_price: 0, max_rent_price: 20,
    sum_last_payment_amount: null, avg_last_payment_amount: null, min_last_payment_amount: null, max_last_payment_amount: null };
  const { pool, calls } = fixture([{ ...expected, count: 3n, sum_rent_price: '20.00', avg_rent_price: '10.000000', min_rent_price: '0.00', max_rent_price: '20.00' }]);
  const metrics = Object.keys(vehicleMetrics).filter((metric) => !metric.endsWith(':mileage')) as VehicleMetric[];
  assert.deepEqual(await summarizeVehicles(pool, { metrics }), { data: expected, meta: { view: 'summary', complete: true } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ROUND\(SUM\(r.kaina\), 2\)/);
  assert.match(calls[0].sql, /ROUND\(AVG\(r.kaina\), 2\)/);
  const sql = calls[0].sql;
  for (const expression of ['COUNT(*)', 'SUM(r.kaina)', 'AVG(r.kaina)', 'MIN(l.last_payment_amount)', 'MAX(l.last_payment_amount)']) assert.ok(sql.includes(expression));
  assert.match(sql, /ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1/);
  assert.match(sql, /ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1/);
  assert.doesNotMatch(sql, /NULLIF|COALESCE|CURRENT_DATE|NOW\(|OFFSET|GROUP BY|SELECT \*/i);
});

test('count-only skips joins; single-field metrics join only their own relation', async () => {
  for (const metric of ['count', 'sum:rent_price', 'max:last_payment_amount'] as const) {
    const key = metric.replace(':', '_');
    const { pool, calls } = fixture([{ [key]: 0, unwanted: 'not returned' }]);
    assert.deepEqual((await summarizeVehicles(pool, { metrics: [metric] })).data, { [key]: 0 });
    assert.equal(calls[0].sql.includes('masinu_priekabu_naudotojas'), metric === 'sum:rent_price');
    assert.equal(calls[0].sql.includes('masinu_priekabu_lizinguotojas'), metric === 'max:last_payment_amount');
  }
});

test('rows and summary share identical filter SQL and bindings', async () => {
  const filters = { plate_number: 'x%_!', plate_numbers: ['HOO756', 'LGK058'], make: "x' OR 1=1 --", model: 'fh', active: false };
  const rows = fixture([{ total: 0 }]);
  // Capture both row queries, returning no raw rows for the page.
  const pool = { query: async (sql: string, values: unknown[]) => {
    rows.calls.push({ sql, values });
    return sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
  }, end: async () => {} } as ReplicaPool;
  await listVehicles(pool, { ...filters, page: 9, per_page: 1, sort_by: 'rent_price', sort_direction: 'desc' });
  const summary = fixture([{ sum_rent_price: null }]);
  await summarizeVehicles(summary.pool, { ...filters, metrics: ['sum:rent_price'] });
  const where = rows.calls[0].sql.split('WHERE ')[1];
  assert.ok(summary.calls[0].sql.endsWith(`WHERE ${where}`));
  assert.deepEqual(summary.calls[0].values, rows.calls[0].values);
  assert.ok(!summary.calls[0].sql.includes(filters.make));
  assert.doesNotMatch(summary.calls[0].sql, /LIMIT \?|OFFSET/);
});

test('empty/all-null aggregates remain null, while zero remains numeric zero', async () => {
  for (const value of [null, '0.00']) {
    const result = { count: value === null ? 0 : 1, sum_rent_price: value, avg_rent_price: value, min_rent_price: value, max_rent_price: value };
    const { pool } = fixture([result]);
    const data = (await summarizeVehicles(pool, { metrics: ['count', 'sum:rent_price', 'avg:rent_price', 'min:rent_price', 'max:rent_price'] })).data;
    for (const key of ['sum_rent_price', 'avg_rent_price', 'min_rent_price', 'max_rent_price']) assert.equal(data[key], value === null ? null : 0);
    assert.equal(data.count, result.count);
  }
});

test('summary route accepts repeated metrics, deduplicates them and keeps default rows behavior', async () => {
  const { pool, calls } = fixture([{ count: 2n, sum_rent_price: '3050.00', avg_rent_price: '1525.00' }]);
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const response = await app.inject('/vehicles?view=summary&metric=count&metric=sum:rent_price&metric=avg:rent_price&metric=count&plate_numbers=HOO756,LGK058');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: { count: 2, sum_rent_price: 3050, avg_rent_price: 1525 }, meta: { view: 'summary', complete: true } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, ['HOO756', 'LGK058']);
    assert.equal((calls[0].sql.match(/COUNT\(\*\)/g) ?? []).length, 1);
    assert.equal((await app.inject(`/vehicles?view=summary&${Array(10).fill('metric=count').join('&')}`)).statusCode, 200);
  } finally { await app.close(); }
});

test('invalid metrics/views and summary pagination/sorting fail before querying', async () => {
  const { pool, calls } = fixture([]);
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const invalid = ['view=distinct&metric=count', 'view=summary', 'view=summary&metric=',
      'view=summary&metric=sum', 'view=summary&metric=count:rent_price',
      'view=summary&metric=SUM:rent_price', 'view=summary&metric=median:rent_price',
      'view=summary&metric=sum:id', 'view=summary&metric=sum:rent_price:extra',
      'view=summary&metric=sum:rent_price%29%3BDROP', 'view=summary&metric=__proto__',
      'view=summary&metric=count,sum:rent_price', 'metric=count', 'view=rows&metric=count',
      'view=summary&view=summary&metric=count', 'view=summary&metric=count&active=bad',
      ...['page=1', 'page=999', 'per_page=1', 'sort_by=rent_price', 'sort_direction=asc'].map((value) => `view=summary&metric=count&${value}`),
      `view=summary&${Array(11).fill('metric=count').join('&')}`];
    for (const query of invalid) {
      const response = await app.inject(`/vehicles?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid vehicle query' } });
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('failed or incomplete summaries never report complete or leak DB errors', async () => {
  for (const result of [[], [{}], [{ sum_rent_price: 'not numeric' }]]) {
    const { pool } = fixture(result);
    const app = buildApp(config, () => pool, { authenticate: false });
    try {
      const response = await app.inject('/vehicles?view=summary&metric=sum:rent_price');
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Vehicle data temporarily unavailable' } });
    } finally { await app.close(); }
  }
  const pool = { query: async () => { throw new Error('SELECT secret FROM private-host; mariadb://user:password@host'); }, end: async () => {} } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const response = await app.inject('/vehicles?view=summary&metric=count');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Vehicle data temporarily unavailable' } });
  } finally { await app.close(); }
});
