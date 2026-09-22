import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import { InvalidFixedCostQuery, fixedCostAllocationScopes, fixedCostMaximumDateRangeDays, parseFixedCostRequest } from '../../src/fixed-costs/contracts.js';
import type { ReplicaPool } from '../../src/db/replica.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
const auth = { authorization: `Bearer ${config.auth.serviceToken}` };
const semanticError = {
  error: {
    code: 'SEMANTICS_UNVERIFIED',
    message: 'The requested fixed-cost allocation scope has not passed source, amount, currency, date, lock/status, and reconciliation validation.',
  },
};

function fixture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      throw new Error('Fixed-cost routes must not execute replica SQL in this slice');
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls };
}

test('fixed-cost parser allowlists scopes and paired bounded ISO date ranges', () => {
  assert.deepEqual(parseFixedCostRequest({ allocationScope: 'truck', dateFrom: '2024-01-01', dateTo: '2025-01-01' }), {
    allocationScope: 'truck', dateFrom: '2024-01-01', dateTo: '2025-01-01',
  });
  assert.equal(fixedCostMaximumDateRangeDays, 366);
  for (const input of [
    {}, { allocationScope: 'fleet' }, { allocationScope: 'truck', allocationScope2: 'trailer' },
    { allocationScope: ['truck', 'trailer'] }, { allocationScope: 'truck', dateFrom: '2026-2-01', dateTo: '2026-02-02' },
    { allocationScope: 'truck', dateFrom: '2026-02-01' }, { allocationScope: 'truck', dateTo: '2026-02-01' },
    { allocationScope: 'truck', dateFrom: '2026-02-02', dateTo: '2026-02-01' },
    { allocationScope: 'truck', dateFrom: '2024-01-01', dateTo: '2025-01-02' },
  ]) assert.throws(() => parseFixedCostRequest(input), InvalidFixedCostQuery);
});

test('all three fixed-cost routes are authenticated and route valid recognized scopes to the semantic gate', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool);
  try {
    for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
      assert.equal((await app.inject(`/expense-analytics/fixed-costs/${endpoint}?allocationScope=truck`)).statusCode, 401, endpoint);
      for (const allocationScope of fixedCostAllocationScopes) {
        const response = await app.inject({ url: `/expense-analytics/fixed-costs/${endpoint}?allocationScope=${allocationScope}`, headers: auth });
        assert.equal(response.statusCode, 422, `${endpoint}/${allocationScope}`);
        assert.deepEqual(response.json(), semanticError);
      }
    }
    assert.ok(Object.values(fixedCostSemanticCapabilities).every((capability) => capability.enabled === false && capability.status === 'unverified'));
    assert.equal(calls.length, 0);
    assert.equal(app.analyticsGate.active, 0);
    assert.equal(app.analyticsGate.waiting, 0);
  } finally { await app.close(); }
});

test('fixed-cost routes reject invalid or unsupported input before the semantic gate and replica access', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const invalid = [
      '', 'allocationScope=', 'allocationScope=fleet', 'allocationScope=truck&unknown=value',
      'allocationScope=truck&allocationScope=trailer', 'allocationScope=truck&dateFrom=2026-02-30&dateTo=2026-03-01',
      'allocationScope=truck&dateFrom=2026-02-01', 'allocationScope=truck&dateTo=2026-02-01',
      'allocationScope=truck&dateFrom=2026-02-02&dateTo=2026-02-01',
      'allocationScope=truck&dateFrom=2024-01-01&dateTo=2025-01-02',
      'allocationScope=truck&page=0', 'allocationScope=truck&per_page=201',
      'allocationScope=truck&groupBy=truck', 'allocationScope=truck&dimension=truck',
      'allocationScope=truck&sortBy=amount', 'allocationScope=truck&sortDirection=desc',
      'allocationScope=truck&table=kastai_fiksuoti_ataskaita', 'allocationScope=truck&field=amount', 'allocationScope=truck&expression=SUM%28amount%29',
    ];
    for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
      for (const query of invalid) {
        const separator = query ? '?' : '';
        const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}${separator}${query}`);
        assert.equal(response.statusCode, 400, `${endpoint}?${query}`);
        assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid fixed-cost query' } });
      }
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});
