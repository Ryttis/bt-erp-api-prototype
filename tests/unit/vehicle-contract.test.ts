import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { allVehicleFields, listVehicles, summarizeVehicles, categorizeVehicles, vehicleSortFields, type VehicleQuery } from '../../src/vehicles/repository.js';
const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
const defaults: VehicleQuery = { page: 1, per_page: 50, sort_by: 'plate_number', sort_direction: 'asc' };
function fixture(row: Record<string, unknown> = { id: 1, plate_number: 'TEST', mileage: 0, rent_price: 0 }) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return sql.includes('COUNT(*) AS total') ? [{ total: 1 }] : [row];
  }, end: async () => {} } as ReplicaPool;
  return { pool, calls };
}

test('projection returns only requested fields, deduplicates and selects only required columns/joins', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    for (const fields of ['plate_number', 'plate_number,mileage,rent_price', 'plate_number,plate_number']) {
      const result = await app.inject(`/vehicles?fields=${fields}`);
      assert.equal(result.statusCode, 200);
      assert.deepEqual(Object.keys(result.json().data[0]), [...new Set(fields.split(','))]);
      assert.equal(Object.hasOwn(result.json().data[0], 'id'), false);
    }
    assert.match(calls[1].sql, /SELECT m.masinos_nr AS `plate_number`/);
    assert.doesNotMatch(calls[1].sql, /JOIN|m\.id AS /);
    assert.match(calls[3].sql, /s.ar_priekaba = 0/);
    assert.match(calls[3].sql, /masinu_priekabu_naudotojas/);
    assert.doesNotMatch(calls[3].sql, /masinu_priekabu_lizinguotojas/);
  } finally { await app.close(); }
});

test('invalid projection/ranges/dates/IDs are rejected before any DB access', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const invalid = ['fields=', 'fields=id,unknown', 'fields=id,,make', 'fields=__proto__', 'fields=rent_price%20AS%20x',
      'fields=id&fields=make', `fields=${Array(allVehicleFields.length + 1).fill('id').join(',')}`, 'mileage_from=-1',
      'mileage_from=NaN', 'rent_price_to=Infinity', 'rent_price_from=1e3', 'last_payment_from=abc',
      'rent_price_to=', 'mileage_from=10&mileage_to=9', 'rent_price_from=2&rent_price_to=1',
      'last_payment_from=2&last_payment_to=0', 'consumer_id=0', 'lessor_id=-1', 'bank_id=1.5',
      'view=summary&metric=sum:mileage'];
    for (const prefix of ['manufactured', 'registration', 'consumer', 'lease_start', 'lease_end']) {
      for (const date of ['0000-00-00', '2023-02-29', '2024-02-30', '2025-04-31', '2025-00-01', '2025-01-00', '2025-1-1', '2025-01-01T00:00:00Z']) invalid.push(`${prefix}_from=${date}`);
      invalid.push(`${prefix}_from=2025-02-01&${prefix}_to=2025-01-01`);
    }
    for (const query of ['view=summary&metric=count', 'view=distinct&field=make', 'view=grouped&group_by=make&metric=count']) invalid.push(`${query}&fields=make`);
    for (const query of invalid) assert.equal((await app.inject(`/vehicles?${query}`)).statusCode, 400, query);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('valid numeric/date/name/ID/category filters bind parameters and select needed joins', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const query = new URLSearchParams({ fields: 'plate_number', mileage_from: '0', mileage_to: '100',
      rent_price_from: '0', rent_price_to: '1350', last_payment_from: '0', last_payment_to: '7226.34',
      manufactured_from: '2024-02-29', manufactured_to: '2025-01-01', registration_from: '2020-01-01',
      consumer_from: '2020-01-01', consumer_to: '2025-01-01', lease_start_from: '2020-01-01', lease_end_to: '2029-01-01',
      consumer_id: '56', lessor_id: '8915', bank_id: '28479', consumer_name: "name' OR 1=1 --", lessor_name: 'rental', bank_name: 'bank',
      department: 'dept', group: 'group', market: 'market' });
    assert.equal((await app.inject(`/vehicles?${query}`)).statusCode, 200);
    for (const call of calls) {
      assert.ok(call.values.includes(0));
      assert.ok(call.values.includes(7226.34));
      assert.ok(call.values.includes('2024-02-29'));
      assert.ok(call.values.includes("%name' OR 1=1 --%"));
      assert.ok(call.values.includes('dept'));
      assert.match(call.sql, /s.ar_priekaba = 0/);
      assert.match(call.sql, /c.id = NULLIF\(r.naudotojas, 0\)/);
      assert.match(call.sql, /mk.id = NULLIF\(m.priskirto_rinka_id, 0\)/);
      assert.doesNotMatch(call.sql, /OR 1=1/);
    }
  } finally { await app.close(); }
});

test('all row sort fields and directions have null-last and id tie-breaks', async () => {
  for (const sort_by of Object.keys(vehicleSortFields) as VehicleQuery['sort_by'][]) {
    for (const sort_direction of ['asc', 'desc'] as const) {
      const { pool, calls } = fixture();
      await listVehicles(pool, { ...defaults, fields: ['plate_number'], sort_by, sort_direction });
      const sql = calls[1].sql;
      assert.ok(sql.includes(`ORDER BY ${vehicleSortFields[sort_by]} IS NULL ASC, ${vehicleSortFields[sort_by]} ${sort_direction.toUpperCase()}, m.id ASC`));
    }
  }
});

test('date normalization rejects impossible/partial dates and keeps valid leap dates; mileage zero survives', async () => {
  for (const value of ['0000-00-00', '2025-00-01', '2025-01-00', '2025-02-29', '2024-02-29', null]) {
    const { pool } = fixture({ manufactured_at: value, registration_date: value, mileage: 0 });
    const result = await listVehicles(pool, { ...defaults, fields: ['manufactured_at', 'registration_date', 'mileage'] });
    assert.deepEqual(result.data[0], { manufactured_at: value === '2024-02-29' ? value : null, registration_date: value === '2024-02-29' ? value : null, mileage: 0 });
  }
});

test('new filters have identical conditions, bindings, and joins across all views', async () => {
  const filters = { mileage_from: 0, rent_price_to: 1350, bank_id: 28479, department: 'dept' };
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes('AS total')) return [{ total: 0 }];
    if (sql.includes('GROUP BY')) return [];
    if (sql.includes('AS count')) return [{ count: 0 }];
    return [];
  }, end: async () => {} } as ReplicaPool;
  await listVehicles(pool, { ...defaults, ...filters, fields: ['id'] });
  await summarizeVehicles(pool, { ...filters, metrics: ['count'] });
  await categorizeVehicles(pool, { ...filters, field: 'make', metrics: ['count'] }, 'grouped');
  await categorizeVehicles(pool, { ...filters, field: 'make', metrics: [] }, 'distinct');
  const where = calls[0].sql.split('WHERE ').at(-1)!.trim();
  for (const call of [calls[2], calls[3], calls[4]]) {
    assert.deepEqual(call.values, calls[0].values);
    assert.ok(call.sql.includes(where));
    assert.match(call.sql, /s.ar_priekaba = 0/);
    assert.match(call.sql, /masinu_priekabu_naudotojas/);
    assert.match(call.sql, /masinu_priekabu_lizinguotojas/);
  }
});

test('mileage analytics allow avg/min/max and retain zero/null numeric results', async () => {
  const { pool, calls } = fixture({ avg_mileage: '50.5', min_mileage: 0, max_mileage: null });
  const result = await summarizeVehicles(pool, { metrics: ['avg:mileage', 'min:mileage', 'max:mileage'] });
  assert.deepEqual(result.data, { avg_mileage: 50.5, min_mileage: 0, max_mileage: null });
  assert.match(calls[0].sql, /AVG\(s.last_odometer\)/);
  assert.match(calls[0].sql, /s.ar_priekaba = 0/);
});
