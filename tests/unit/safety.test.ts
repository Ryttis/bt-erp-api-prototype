import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { logVehicleTelemetry } from '../../src/telemetry.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters', ERP_ANALYTICS_CONCURRENCY: '1', ERP_ANALYTICS_QUEUE_LIMIT: '1', ERP_ANALYTICS_QUEUE_TIMEOUT_MS: '10' });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((res, rej) => { resolve = res; reject = rej; }), resolve, reject };
};

test('analytics gate releases slots after success, failure, and each queued operation', async () => {
  const gate = new AnalyticsGate(1, 2, 100);
  const first = deferred<void>();
  const running = gate.run(async () => first.promise);
  assert.equal(gate.active, 1);
  const next = gate.run(async () => 2);
  assert.equal(gate.waiting, 1);
  first.resolve();
  await running;
  assert.equal(await next, 2);
  assert.equal(gate.active, 0);
  await assert.rejects(gate.run(async () => { throw new Error('expected'); }), /expected/);
  assert.equal(gate.active, 0);
  assert.equal(await gate.run(async () => 3), 3);
});

test('analytics gate bounds its queue and removes expired waiters without leaking slots', async () => {
  const gate = new AnalyticsGate(1, 1, 10);
  const hold = deferred<void>();
  const running = gate.run(async () => hold.promise);
  const queued = gate.run(async () => 2);
  await assert.rejects(gate.run(async () => 3), (error: unknown) => (error as { code?: string }).code === 'SERVICE_BUSY');
  await assert.rejects(queued, (error: unknown) => (error as { code?: string }).code === 'SERVICE_BUSY');
  assert.equal(gate.waiting, 0);
  hold.resolve();
  await running;
  assert.equal(gate.active, 0);
  assert.equal(await gate.run(async () => 4), 4);
});

test('vehicle API returns stable safe timeout, busy, and URL-limit errors without analytical completeness', async () => {
  const timeoutPool = { query: async () => { throw Object.assign(new Error('SELECT secret; mariadb://user:password@host'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }); }, end: async () => {} } as ReplicaPool;
  const timeoutApp = buildApp(config, () => timeoutPool, { authenticate: false });
  try {
    const timeout = await timeoutApp.inject('/vehicles?view=summary&metric=count');
    assert.equal(timeout.statusCode, 504);
    assert.deepEqual(timeout.json(), { error: { code: 'QUERY_TIMEOUT', message: 'Vehicle query timed out' } });
    assert.doesNotMatch(timeout.body, /SELECT|mariadb|password|host|complete/);
  } finally { await timeoutApp.close(); }

  const busyPool = { query: async () => [{ count: 1 }], end: async () => {} } as ReplicaPool;
  const busyApp = buildApp(config, () => busyPool, { authenticate: false });
  try {
    const hold = deferred<void>();
    const active = busyApp.analyticsGate.run(async () => hold.promise);
    const waiting = busyApp.analyticsGate.run(async () => hold.promise);
    const busy = await busyApp.inject('/vehicles?view=summary&metric=count');
    assert.equal(busy.statusCode, 503);
    assert.deepEqual(busy.json(), { error: { code: 'SERVICE_BUSY', message: 'Analytical service is busy' } });
    assert.doesNotMatch(busy.body, /complete/);
    hold.resolve();
    await active;
    await waiting;
  } finally { await busyApp.close(); }

  const shortConfig = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters', MAX_REQUEST_URL_LENGTH: '40' });
  const urlApp = buildApp(shortConfig, () => busyPool, { authenticate: false });
  try {
    const response = await urlApp.inject(`/vehicles?plate_number=${'A'.repeat(100)}`);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid vehicle query' } });
  } finally { await urlApp.close(); }
});

test('telemetry is structured, warning-threshold aware, and carries no query values', () => {
  const events: { level: string; event: object; message: string }[] = [];
  const logger = { info: (event: object, message: string) => events.push({ level: 'info', event, message }), warn: (event: object, message: string) => events.push({ level: 'warn', event, message }) };
  logVehicleTelemetry(logger, 1000, { request_id: 'request-1', endpoint: '/vehicles', view: 'summary', operation: 'vehicle.summary', duration_ms: 12.5, outcome: 'success', timeout: false, busy: false, metric_count: 2, result_count: 1 });
  logVehicleTelemetry(logger, 1000, { request_id: 'request-2', endpoint: '/vehicles', view: 'grouped', operation: 'vehicle.grouped', duration_ms: 1000, outcome: 'timeout', timeout: true, busy: false, metric_count: 1, category_count: 0 });
  assert.deepEqual(events.map((entry) => entry.level), ['info', 'warn']);
  assert.equal(events[1].message, 'Slow vehicle database request');
  assert.deepEqual(events[0].event, { request_id: 'request-1', endpoint: '/vehicles', view: 'summary', operation: 'vehicle.summary', duration_ms: 12.5, outcome: 'success', timeout: false, busy: false, metric_count: 2, result_count: 1 });
  assert.doesNotMatch(JSON.stringify(events), /plate|secret|sql|password/i);
});
