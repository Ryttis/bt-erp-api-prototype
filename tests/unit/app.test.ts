import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });

test('health and every existing mock domain remain available; pool closes once', async () => {
  let closes = 0;
  let creations = 0;
  const pool = { query: async () => { throw new Error('Unexpected DB query'); }, end: async () => { closes++; } } as ReplicaPool;
  const app = buildApp(config, (received) => {
    creations++;
    assert.deepEqual(received, config.replica);
    return pool;
  });
  try {
    const health = await app.inject('/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    for (const path of ['/api/trips', '/api/orders', '/api/customers', '/api/invoices', '/api/documents']) {
      const denied = await app.inject(path);
      assert.equal(denied.statusCode, 401);
      assert.deepEqual(denied.json(), { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      const response = await app.inject({ url: path, headers: { authorization: `Bearer ${config.auth.serviceToken}` } });
      assert.equal(response.statusCode, 200);
      assert.ok(response.json().length > 0);
    }
    const wrongToken = await app.inject({ url: '/vehicles', headers: { authorization: 'Bearer definitely-not-the-service-token' } });
    assert.equal(wrongToken.statusCode, 401);
    assert.equal(wrongToken.headers['www-authenticate'], 'Bearer');
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(app.replica, pool);
    assert.equal(creations, 1);
    assert.equal((await app.inject({ url: '/api/trips/missing', headers: { authorization: `Bearer ${config.auth.serviceToken}` } })).statusCode, 404);
  } finally {
    await app.close();
  }
  await app.close();
  assert.equal(closes, 1);
});

test('app instances own separate pools', async () => {
  let closes = 0;
  const factory = () => ({ query: async () => [], end: async () => { closes++; } }) as ReplicaPool;
  const first = buildApp(config, factory);
  const second = buildApp(config, factory);
  assert.notEqual(first.replica, second.replica);
  await first.close();
  assert.equal(closes, 1);
  await second.close();
  assert.equal(closes, 2);
});
