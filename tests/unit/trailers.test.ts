import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { listTrailers, type TrailerQuery } from '../../src/trailers/repository.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
const defaults: TrailerQuery = { page: 1, per_page: 50 };
const row = { id: 47, registration_number: 'ABC123' };

function fixture(rows: unknown[] = [row], total = rows.length) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return sql.includes('COUNT(*)') ? [{ total: BigInt(total) }] : rows;
  }, end: async () => {} } as ReplicaPool;
  return { pool, calls };
}

test('exact trailer registration lookup returns the canonical priekabos id', async () => {
  const { pool, calls } = fixture();
  const result = await listTrailers(pool, { ...defaults, registration_numbers: ['ABC123'], per_page: 2 });
  assert.deepEqual(result.data, [row]);
  assert.deepEqual(result.meta, { page: 1, per_page: 2, total: 1, last_page: 1, sort: { field: 'registration_number', direction: 'asc' } });
  assert.match(calls[0].sql, /FROM infot_2\.priekabos t/);
  assert.match(calls[0].sql, /t\.masinos_nr IN \(\?\)/);
  assert.deepEqual(calls[0].values, ['ABC123']);
  assert.deepEqual(calls[1].values, ['ABC123', 2, 0]);
  assert.match(calls[1].sql, /ORDER BY t\.masinos_nr IS NULL ASC, t\.masinos_nr ASC, t\.id ASC/);
});

test('zero and duplicate exact matches remain observable rather than being selected implicitly', async () => {
  assert.deepEqual((await listTrailers(fixture([], 0).pool, { ...defaults, registration_numbers: ['UNKNOWN'] })).data, []);
  const duplicates = fixture([row, { id: 48, registration_number: 'ABC123' }], 2);
  const result = await listTrailers(duplicates.pool, { ...defaults, registration_numbers: ['ABC123'] });
  assert.equal(result.data.length, 2);
  assert.equal(result.meta.total, 2);
});

test('route supports exact lookup, optional substring lookup, and field projection', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const exact = await app.inject('/trailers?registration_numbers=ABC123&fields=id,registration_number&per_page=2');
    assert.equal(exact.statusCode, 200);
    assert.deepEqual(exact.json().data, [row]);
    assert.deepEqual(calls.at(-1)!.values, ['ABC123', 2, 0]);
    const partial = await app.inject('/trailers?registration_number=BC1&fields=id');
    assert.equal(partial.statusCode, 200);
    assert.deepEqual(partial.json().data, [{ id: 47 }]);
    assert.deepEqual(calls.at(-1)!.values, ['%BC1%', 50, 0]);
  } finally { await app.close(); }
});

test('invalid trailer input is rejected before database access', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    for (const query of ['unknown=x', 'page=1&page=2', 'per_page=201', 'per_page=0', 'page=0', 'fields=id,nope', 'fields=', "registration_numbers=x'%20OR%201=1", 'registration_number=ABC%3BSELECT', 'registration_numbers=A,,B']) {
      const response = await app.inject(`/trailers?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid trailer query' } });
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('trailer endpoint is authenticated and /vehicles remains registered', async () => {
  const { pool } = fixture();
  const app = buildApp(config, () => pool);
  try {
    assert.equal((await app.inject('/trailers?registration_numbers=ABC123')).statusCode, 401);
    const auth = { authorization: `Bearer ${config.auth.serviceToken}` };
    assert.equal((await app.inject({ url: '/trailers?registration_numbers=ABC123', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ url: '/vehicles', headers: auth })).statusCode, 200);
  } finally { await app.close(); }
});

test('pagination bounds and deterministic sorting are retained', async () => {
  const { pool, calls } = fixture([], 2);
  const result = await listTrailers(pool, { ...defaults, page: 10, per_page: 2 });
  assert.deepEqual(result.meta, { page: 10, per_page: 2, total: 2, last_page: 1, sort: { field: 'registration_number', direction: 'asc' } });
  assert.match(calls[1].sql, /ORDER BY t\.masinos_nr IS NULL ASC, t\.masinos_nr ASC, t\.id ASC/);
});
