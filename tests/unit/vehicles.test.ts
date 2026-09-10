import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { listVehicles, type VehicleQuery } from '../../src/vehicles/repository.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
const defaults: VehicleQuery = { page: 1, per_page: 50, sort_by: 'plate_number', sort_direction: 'asc' };
const row = { manufactured_at: null, registration_date: null, mileage: null, department: null, group: null, market: null, consumer_name: null, lessor_name: null, bank_name: null, id: 1, plate_number: 'NIR935', make: null, model: null, vin: null, active: 1,
  consumer_id: 0, consumer_from: '0000-00-00', consumer_to: null, rent_price: '0.00',
  lessor_id: null, bank_id: 0, lease_start: null, lease_end: '0000-00-00', last_payment_amount: null };

function fixture(rows: unknown[] = [row], total = 123) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return sql.includes('COUNT(*)') ? [{ total: BigInt(total) }] : rows;
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls };
}

test('repository normalizes zero, nulls, decimal numbers and canonical fields', async () => {
  const { pool, calls } = fixture([row, { ...row, id: 2, active: 0, rent_price: null }]);
  const result = await listVehicles(pool, defaults);
  assert.deepEqual(result.data[0], { ...row, active: true, consumer_id: null,
    consumer_from: null, bank_id: null, lease_end: null, rent_price: 0 });
  assert.equal(result.data[1].rent_price, null);
  assert.equal(result.data[1].active, false);
  assert.deepEqual(result.meta, { page: 1, per_page: 50, total: 123, last_page: 3, sort: { field: 'plate_number', direction: 'asc' } });
  assert.match(calls[1].sql, /ORDER BY m.masinos_nr IS NULL ASC, m.masinos_nr ASC, m.id ASC/);
  assert.match(calls[1].sql, /ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1/);
  assert.match(calls[1].sql, /ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1/);
  assert.doesNotMatch(calls[1].sql, /CURRENT_DATE|NOW\(|SELECT \*/i);
});

test('repository binds all filters and pagination; LIKE wildcards remain literal', async () => {
  const { pool, calls } = fixture();
  const injection = "x' OR 1=1 --";
  const result = await listVehicles(pool, { ...defaults, page: 2, per_page: 2,
    plate_number: 'A%_!', plate_numbers: ['NIR935', 'NJI449'], make: injection,
    model: 'ab', active: false, sort_by: 'rent_price', sort_direction: 'desc' });
  assert.equal(result.meta.total, 123);
  assert.equal(result.meta.last_page, 62);
  assert.deepEqual(calls[0].values, ['%A!%!_!!%', 'NIR935', 'NJI449', injection, '%ab%', 0]);
  assert.deepEqual(calls[1].values, [...calls[0].values, 2, 2]);
  assert.ok(!calls[1].sql.includes(injection));
  assert.match(calls[1].sql, /ORDER BY r.kaina IS NULL ASC, r.kaina DESC, m.id ASC/);
  assert.match(calls[0].sql, /m.masinos_nr IN \(\?, \?\)/);
  assert.ok(!calls[0].sql.includes('LIMIT'));
});

test('route defaults, pagination, filters and allowlisted explicit sorting', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const response = await app.inject('/vehicles');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data[0].rent_price, 0);
    assert.equal(response.json().meta.per_page, 50);
    for (const sort_by of ['plate_number', 'make', 'model', 'rent_price', 'last_payment_amount', 'lease_start', 'lease_end']) {
      const response = await app.inject(`/vehicles?page=2&per_page=1&sort_by=${sort_by}&sort_direction=desc`);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().meta, { page: 2, per_page: 1, total: 123, last_page: 123, sort: { field: sort_by, direction: 'desc' } });
      assert.deepEqual(calls.at(-1)!.values, [1, 1]);
      assert.match(calls.at(-1)!.sql, / DESC, m.id ASC/);
    }
    for (const active of ['true', 'false', '1', '0']) {
      assert.equal((await app.inject(`/vehicles?active=${active}`)).statusCode, 200);
      assert.equal(calls.at(-1)!.values[0], ['true', '1'].includes(active) ? 1 : 0);
    }
    const filtered = await app.inject('/vehicles?plate_numbers=NIR935,NJI449&plate_number=nir&make=volvo&model=fh');
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(calls.at(-1)!.values, ['%nir%', 'NIR935', 'NJI449', 'volvo', '%fh%', 50, 0]);
    assert.equal((await app.inject(`/vehicles?plate_numbers=${Array.from({ length: 100 }, (_, i) => `P${i}`).join(',')}`)).statusCode, 200);
  } finally { await app.close(); }
});

test('invalid query parameters fail safely before DB access', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const invalid = ['per_page=0', 'per_page=201', 'per_page=-1', 'per_page=1.5', 'per_page=abc',
      'page=0', 'page=1e3', 'page=9007199254740991&per_page=200', 'sort_by=id',
      'sort_by=__proto__', 'sort_by=rent_price%20DESC', 'sort_direction=invalid',
      'active=yes', 'active=2', 'active=', 'plate_numbers=A,,B', 'plate_numbers=',
      'page=1&page=2', 'view=summary', 'group_by=make', 'make=',
      `plate_numbers=${Array.from({ length: 101 }, (_, i) => `P${i}`).join(',')}`];
    for (const query of invalid) {
      const response = await app.inject(`/vehicles?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid vehicle query' } });
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('out-of-range pages retain totals; empty dataset has last_page zero', async () => {
  const nonempty = fixture([], 2);
  assert.deepEqual((await listVehicles(nonempty.pool, { ...defaults, page: 10 })).meta,
    { page: 10, per_page: 50, total: 2, last_page: 1, sort: { field: 'plate_number', direction: 'asc' } });
  const empty = fixture([], 0);
  assert.equal((await listVehicles(empty.pool, defaults)).meta.last_page, 0);
});

test('route never returns raw DB errors or partial data after either query fails', async () => {
  for (const failAt of [1, 2]) {
    let count = 0;
    const pool = { query: async () => {
      if (++count === failAt) throw new Error('SELECT secret FROM private-host; mariadb://user:password@host');
      return [{ total: 1 }];
    }, end: async () => {} } as ReplicaPool;
    const app = buildApp(config, () => pool, { authenticate: false });
    try {
      const response = await app.inject('/vehicles');
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Vehicle data temporarily unavailable' } });
    } finally { await app.close(); }
  }
});
