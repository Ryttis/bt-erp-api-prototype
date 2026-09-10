import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';

export const environment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2',
  ERP_REPLICA_USER: 'test-reader', ERP_REPLICA_PASSWORD: 'test-only-password',
  ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};

test('configuration defaults and explicit overrides', () => {
  const config = loadConfig(environment);
  assert.equal(config.port, 3000);
  assert.equal(config.auth.serviceToken, environment.ERP_ANALYTICS_API_TOKEN);
  assert.deepEqual(config.replica, {
    host: 'example.invalid', database: 'infot_2', user: 'test-reader',
    password: 'test-only-password', port: 3306, ssl: false, connectionLimit: 4,
  });
  assert.deepEqual(config.safety, { queryTimeoutMs: 30000, analyticsConcurrency: 3, analyticsQueueLimit: 6, analyticsQueueTimeoutMs: 1000, slowQueryMs: 1000, maxRequestUrlLength: 4096 });
  const explicit = loadConfig({ ...environment, PORT: '8080', ERP_REPLICA_PORT: '3307', ERP_REPLICA_SSL: 'true', ERP_REPLICA_CONNECTION_LIMIT: '2' });
  assert.equal(explicit.port, 8080);
  assert.equal(explicit.replica.port, 3307);
  assert.equal(explicit.replica.ssl, true);
  assert.equal(explicit.replica.connectionLimit, 2);
});

test('required fields reject missing and blank values without leaking values', () => {
  for (const name of Object.keys(environment)) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => loadConfig({ ...environment, [name]: value }), { message: `Missing required configuration: ${name}` });
    }
  }
});

test('numeric and boolean configuration is strictly validated', () => {
  for (const name of ['PORT', 'ERP_REPLICA_PORT', 'ERP_REPLICA_CONNECTION_LIMIT', 'ERP_REPLICA_QUERY_TIMEOUT_MS', 'ERP_ANALYTICS_CONCURRENCY', 'ERP_ANALYTICS_QUEUE_LIMIT', 'ERP_ANALYTICS_QUEUE_TIMEOUT_MS', 'ERP_SLOW_QUERY_MS', 'MAX_REQUEST_URL_LENGTH']) {
    for (const value of ['0', '-1', '1.5', 'abc', '', '1e2']) {
      assert.throws(() => loadConfig({ ...environment, [name]: value }), new RegExp(name));
    }
  }
  assert.throws(() => loadConfig({ ...environment, ERP_REPLICA_CONNECTION_LIMIT: '101' }));
  assert.throws(() => loadConfig({ ...environment, ERP_REPLICA_SSL: 'yes' }));
  assert.throws(() => loadConfig({ ...environment, ERP_ANALYTICS_API_TOKEN: 'too-short' }));
});
