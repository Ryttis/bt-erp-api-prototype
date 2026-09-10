import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { categorizeVehicles, summarizeVehicles, type VehicleCategoryField } from '../../src/vehicles/repository.js';
const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
function fixture(rows: unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return rows; }, end: async () => {} } as ReplicaPool;
  return { pool, calls };
}

test('distinct make includes counts, exact UTF-8 values and a null category', async () => {
  const { pool, calls } = fixture([{ category_value: Buffer.from('VOLVO'), count: 3n }, { category_value: null, count: 2n }]);
  assert.deepEqual(await categorizeVehicles(pool, { field: 'make', metrics: [] }, 'distinct'), {
    data: [{ value: 'VOLVO', count: 3 }, { value: null, count: 2 }], meta: { view: 'distinct', field: 'make', complete: true },
  });
  assert.match(calls[0].sql, /CAST\(CONVERT\(m.marke_2 USING utf8mb4\) AS BINARY\)/);
  assert.match(calls[0].sql, /GROUP BY category_value\s+ORDER BY COUNT\(\*\) DESC, category_value IS NULL ASC, category_value ASC\s+LIMIT 101/);
  assert.ok(!calls[0].sql.includes('JOIN'));
});

test('categorical active values are booleans and foreign-key zero means null', async () => {
  for (const view of ['distinct', 'grouped'] as const) {
    const { pool } = fixture([{ category_value: 0, count: 2 }, { category_value: 1, count: 1 }]);
    const result = await categorizeVehicles(pool, { field: 'active', metrics: ['count'] }, view);
    const key = view === 'distinct' ? 'value' : 'group';
    assert.deepEqual(result.data, [{ [key]: false, count: 2 }, { [key]: true, count: 1 }]);
  }
  for (const field of ['consumer_id', 'lessor_id', 'bank_id'] as const) {
    const { pool, calls } = fixture([{ category_value: 0, count: 1 }]);
    assert.equal((await categorizeVehicles(pool, { field, metrics: [] }, 'distinct')).data[0].value, null);
    assert.match(calls[0].sql, /SELECT NULLIF\([rl]\.[a-z]+, 0\) AS category_value/);
    assert.match(calls[0].sql, /data_nuo DESC, [a-z]+.id DESC LIMIT 1/);
  }
});

test('lookup categories reuse the verified canonical field expressions and joins', async () => {
  const expected = {
    department: { field: 'd.skyrius', join: 'LEFT JOIN infot_2.skyriai d' },
    group: { field: 'g.poskyris', join: 'LEFT JOIN infot_2.poskyriai g' },
    market: { field: 'mk.rinka', join: 'LEFT JOIN infot_2.rinkos mk' },
  } as const;
  for (const [field, mapping] of Object.entries(expected) as [VehicleCategoryField, typeof expected[keyof typeof expected]][]) {
    const { pool, calls } = fixture([{ category_value: Buffer.from('Operations'), count: 2 }]);
    const result = await categorizeVehicles(pool, { field, department: 'Operations', metrics: [] }, 'distinct');
    assert.deepEqual(result.data, [{ value: 'Operations', count: 2 }]);
    assert.match(calls[0].sql, new RegExp(`CAST\\(CONVERT\\(${mapping.field.replace('.', '\\.')} USING utf8mb4\\) AS BINARY\\)`));
    assert.match(calls[0].sql, new RegExp(mapping.join.replace(/[.]/g, '\\.')));
    assert.deepEqual(calls[0].values, ['Operations']);
  }
});

test('grouped metrics reuse SQL aggregates, preserve zero/null and omit unrequested count', async () => {
  const { pool, calls } = fixture([{ category_value: 'VOLVO', sum_rent_price: '0.00', avg_rent_price: '0.00', max_last_payment_amount: null, count: 5 }]);
  const result = await categorizeVehicles(pool, { field: 'make', metrics: ['sum:rent_price', 'avg:rent_price', 'max:last_payment_amount'] }, 'grouped');
  assert.deepEqual(result, { data: [{ group: 'VOLVO', sum_rent_price: 0, avg_rent_price: 0, max_last_payment_amount: null }], meta: { view: 'grouped', group_by: 'make', complete: true } });
  assert.match(calls[0].sql, /ROUND\(SUM\(r.kaina\), 2\)/);
  assert.match(calls[0].sql, /ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1/);
  assert.match(calls[0].sql, /ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1/);
  assert.doesNotMatch(calls[0].sql, /CURRENT_DATE|NOW\(|COUNT\(\*\) AS count|SELECT \*/);
});

test('categorical views share summary filters and bind values before grouping', async () => {
  const filters = { plate_number: 'a%_', plate_numbers: ['HOO756', 'LGK058'], make: "x' OR 1=1 --", model: 'fh', active: true };
  const summary = fixture([{ count: 0 }]);
  await summarizeVehicles(summary.pool, { ...filters, metrics: ['count'] });
  for (const view of ['distinct', 'grouped'] as const) {
    const { pool, calls } = fixture([]);
    const result = await categorizeVehicles(pool, { ...filters, field: 'make', metrics: ['count'] }, view);
    assert.deepEqual(result.data, []);
    assert.equal(result.meta.complete, true);
    assert.deepEqual(calls[0].values, summary.calls[0].values);
    assert.equal(calls[0].sql.split('WHERE ')[1].split('GROUP BY')[0].trim(), summary.calls[0].sql.split('WHERE ')[1]);
    assert.ok(!calls[0].sql.includes(filters.make));
  }
});

test('routes support every categorical field and repeated grouped metrics', async () => {
  const { pool } = fixture([{ category_value: null, count: 2n, sum_rent_price: '3050' }]);
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    for (const field of ['make', 'model', 'department', 'group', 'market', 'active', 'consumer_id', 'lessor_id', 'bank_id']) {
      const distinct = await app.inject(`/vehicles?view=distinct&field=${field}`);
      assert.equal(distinct.statusCode, 200);
      assert.deepEqual(distinct.json(), { data: [{ value: null, count: 2 }], meta: { view: 'distinct', field, complete: true } });
      const grouped = await app.inject(`/vehicles?view=grouped&group_by=${field}&metric=count&metric=sum:rent_price`);
      assert.equal(grouped.statusCode, 200);
      assert.deepEqual(grouped.json(), { data: [{ group: null, count: 2, sum_rent_price: 3050 }], meta: { view: 'grouped', group_by: field, complete: true } });
    }
  } finally { await app.close(); }
});

test('100 categories are complete; 101 reject without partial data in both views', async () => {
  for (const length of [100, 101]) {
    const { pool } = fixture(Array.from({ length }, (_, i) => ({ category_value: `make-${i}`, count: 1 })));
    const app = buildApp(config, () => pool, { authenticate: false });
    try {
      for (const field of ['make', 'department', 'group', 'market']) {
        for (const query of [`view=distinct&field=${field}`, `view=grouped&group_by=${field}&metric=count`]) {
          const response = await app.inject(`/vehicles?${query}`);
          assert.equal(response.statusCode, length === 100 ? 200 : 422);
          if (length === 100) {
            assert.equal(response.json().data.length, 100);
            assert.equal(response.json().meta.complete, true);
          } else {
            assert.deepEqual(response.json(), { error: { code: 'CATEGORY_LIMIT_EXCEEDED', message: 'Category limit exceeded; narrow the filters', limit: 100 } });
          }
        }
      }
    } finally { await app.close(); }
  }
});

test('meaningless combinations, unsupported fields/metrics and excessive metrics reject before DB access', async () => {
  const { pool, calls } = fixture([]);
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const invalid = ['view=distinct', 'view=distinct&field=id', 'view=distinct&field=__proto__',
      'view=distinct&field=make&metric=count', 'view=distinct&field=make&group_by=make',
      'view=distinct&field=make&field=model', 'view=grouped&group_by=make',
      'view=grouped&group_by=id&metric=count', 'view=grouped&group_by=make,model&metric=count',
      'view=grouped&group_by=make&group_by=model&metric=count', 'view=grouped&group_by=make&metric=sum:id',
      'view=grouped&group_by=make&metric=median:rent_price', 'view=grouped&group_by=make&metric=',
      'view=grouped&group_by=make&metric=count&field=make', 'view=summary&metric=count&field=make',
      'field=make', 'group_by=make', `view=grouped&group_by=make&${Array(11).fill('metric=count').join('&')}`];
    for (const base of ['view=distinct&field=make', 'view=grouped&group_by=make&metric=count']) {
      for (const param of ['page=1', 'per_page=1', 'sort_by=make', 'sort_direction=asc']) invalid.push(`${base}&${param}`);
    }
    for (const query of invalid) assert.equal((await app.inject(`/vehicles?${query}`)).statusCode, 400, query);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('category queries fail safely on DB failure or incomplete metric data', async () => {
  for (const throws of [true, false]) {
    const pool = { query: async () => {
      if (throws) throw new Error('SELECT private; mariadb://user:password@private-host');
      return [{ category_value: 'VOLVO' }];
    }, end: async () => {} } as ReplicaPool;
    const app = buildApp(config, () => pool, { authenticate: false });
    try {
      for (const query of ['view=distinct&field=make', 'view=grouped&group_by=make&metric=count']) {
        const response = await app.inject(`/vehicles?${query}`);
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Vehicle data temporarily unavailable' } });
      }
    } finally { await app.close(); }
  }
});
