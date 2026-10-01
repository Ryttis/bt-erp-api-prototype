import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { ApiError } from '../../src/errors.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes, InvalidFixedCostQuery } from '../../src/fixed-costs/contracts.js';
import {
  fixedCostAuthoritativeSource, fixedCostBreakdownSources, FixedCostDeletedPolicyUnapproved,
  fixedCostMonetaryLimitations, fixedCostMonetaryPendingApprovals, InvalidFixedCostMonetaryResult,
  unapprovedFixedCostDeletedRowPolicy,
  type FixedCostDeletedRowPolicy, type FixedCostMonetaryResult, type FixedCostRepresentation,
} from '../../src/fixed-costs/monetary-contract.js';
import { FixedCostMonetaryError, queryFixedCostMonetaryTotals } from '../../src/fixed-costs/monetary-repository.js';
import {
  assertSummaryPeriodMonths, fixedCostSummaryMonthMappingBlocker, orderFixedCostLimitations,
  parseTruckFixedCostSummaryRequest,
  planTruckFixedCostSummaryPeriod, truckFixedCostSummaryLimitations, TruckFixedCostSummaryUnavailable,
} from '../../src/fixed-costs/summary-contract.js';
import { summarizeTruckFixedCosts, type FixedCostMonetaryExecutor } from '../../src/fixed-costs/summary-service.js';

const month = '2025-03-01';
const request = { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31' } as const;
const approved: FixedCostDeletedRowPolicy = Object.freeze({
  treatment: 'exclude_deleted', approved: true, approvedBy: 'internal-test-owner', reference: 'FC-03',
});

/** A repository-shaped result. Monetary fields stay decimal text or null. */
function monetaryResult(options: {
  representation: FixedCostRepresentation;
  periodMonth?: string;
  groups?: Partial<FixedCostMonetaryResult['groups'][number]>[];
  complete?: boolean;
  truncated?: boolean;
  missingTaskCount?: number;
}): FixedCostMonetaryResult {
  const groups = (options.groups ?? [{}]).map(group => ({
    deletedState: 'zero' as const,
    reconciliationStatus: 'unreconciled' as const,
    authoritativeRecords: 10,
    authoritativeTotal: '125430.20',
    comparableRecords: 8,
    comparableAuthoritativeTotal: '124000.00',
    componentTotal: '123999.55',
    netDifference: '0.45',
    grossAbsoluteDifference: '0.85',
    affectedRecords: 3,
    buckets: { exact: 5, rounding: 1, small: 2, moderate: 0, material: 0, large: 0 },
    noDetailRecords: 2,
    multipleDetailRecords: 0,
    missingTotalRecords: 0,
    missingTaskCount: 0,
    lockedRecords: 6,
    unlockedRecords: 4,
    unknownLockRecords: 0,
    ...group,
  }));
  return {
    groups,
    meta: {
      allocationScope: 'truck',
      representation: options.representation,
      periodMonth: options.periodMonth ?? month,
      dateBasis: 'kastai_data',
      currency: 'EUR',
      authoritativeSource: fixedCostAuthoritativeSource,
      breakdownSource: fixedCostBreakdownSources[options.representation],
      componentFields: [],
      classificationApplied: false,
      classificationVersion: null,
      semanticsVersion: null,
      recordLimit: 50000,
      recordsRead: groups.reduce((sum, group) => sum + group.authoritativeRecords, 0),
      missingTaskCount: options.missingTaskCount ?? 0,
      truckFilterApplied: false,
      truncated: (options.truncated ?? false) as false,
      complete: options.complete ?? true,
      deletedRowPolicy: approved,
      reconciliationStatus: 'unreconciled',
      pendingApprovals: fixedCostMonetaryPendingApprovals,
      limitations: fixedCostMonetaryLimitations,
    },
  };
}

/** Records every executor call so representation independence is provable. */
function executor(build: (representation: FixedCostRepresentation) => FixedCostMonetaryResult) {
  const calls: { representation: FixedCostRepresentation; periodMonth: string }[] = [];
  const execute: FixedCostMonetaryExecutor = async input => {
    calls.push({ representation: input.representation, periodMonth: input.periodMonth });
    await setImmediate();
    return build(input.representation);
  };
  return { execute, calls };
}

const summarize = (
  build: (representation: FixedCostRepresentation) => FixedCostMonetaryResult,
  overrides: Partial<Parameters<typeof summarizeTruckFixedCosts>[0]> = {},
) => {
  const { execute } = executor(build);
  return summarizeTruckFixedCosts({ request, periodMonths: [month], execute, policy: approved, ...overrides });
};

// --- request contract ---------------------------------------------------------

test('the summary request accepts only truck plus a paired canonical date range', () => {
  assert.deepEqual(parseTruckFixedCostSummaryRequest({ allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31' }), {
    allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31',
  });
  assert.deepEqual(parseTruckFixedCostSummaryRequest({ allocationScope: 'truck', dateFrom: '2024-01-01', dateTo: '2025-01-01' }).dateTo, '2025-01-01');
});

test('the summary request rejects missing pairs, bad dates, ranges, repeats, unknowns and SQL shapes', () => {
  const invalid: Record<string, unknown>[] = [
    {},
    { allocationScope: 'truck' },
    { allocationScope: 'truck', dateFrom: '2025-03-01' },
    { allocationScope: 'truck', dateTo: '2025-03-31' },
    { allocationScope: 'trailer', dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { allocationScope: 'department', dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { allocationScope: 'support', dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { allocationScope: 'expedition', dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { allocationScope: 'fleet', dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { allocationScope: 'truck', dateFrom: '2025-02-30', dateTo: '2025-03-01' },
    { allocationScope: 'truck', dateFrom: '2025-3-01', dateTo: '2025-03-31' },
    { allocationScope: 'truck', dateFrom: '2025-03-31', dateTo: '2025-03-01' },
    { allocationScope: 'truck', dateFrom: '2024-01-01', dateTo: '2025-01-02' },
    // Repeated query parameters arrive as arrays, never strings.
    { allocationScope: ['truck', 'trailer'], dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { allocationScope: 'truck', dateFrom: ['2025-03-01', '2025-04-01'], dateTo: '2025-03-31' },
    // Nothing internal is accepted from the public surface.
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', representation: 'locked' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', deletedPolicy: 'include_all' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', tolerance: '1.00' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', limit: 5 },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', table: 'kastai_fiksuoti_ataskaita' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', groupBy: 'truck' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', sortBy: 'amount' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', page: '1' },
    { allocationScope: 'truck', dateFrom: "2025-03-01'; DROP TABLE kastai_fiksuoti_ataskaita --", dateTo: '2025-03-31' },
    { allocationScope: 'truck', dateFrom: '2025-03-01 OR 1=1', dateTo: '2025-03-31' },
    { allocationScope: "truck' UNION SELECT 1 --", dateFrom: '2025-03-01', dateTo: '2025-03-31' },
  ];
  for (const input of invalid) {
    assert.throws(() => parseTruckFixedCostSummaryRequest(input), InvalidFixedCostQuery, JSON.stringify(input));
  }
});

test('the day-range to cost-month mapping is an explicit blocker, not invented behaviour', () => {
  const plan = planTruckFixedCostSummaryPeriod(request);
  assert.equal(plan.resolved, false);
  assert.equal(plan.resolved === false && plan.reason, 'month_mapping_unapproved');
  assert.equal(plan.resolved === false && plan.blocker, fixedCostSummaryMonthMappingBlocker);
  // Even a range that looks month-aligned is not silently converted.
  for (const dates of [
    { dateFrom: '2025-03-01', dateTo: '2025-03-31' },
    { dateFrom: '2025-03-01', dateTo: '2025-04-01' },
    { dateFrom: '2025-03-15', dateTo: '2025-04-14' },
  ]) {
    assert.equal(planTruckFixedCostSummaryPeriod({ allocationScope: 'truck', ...dates }).resolved, false, JSON.stringify(dates));
  }
});

// --- orchestration ------------------------------------------------------------

test('current and locked are fetched independently and never substituted', async () => {
  const { execute, calls } = executor(representation => monetaryResult({
    representation,
    groups: [representation === 'current'
      ? { authoritativeTotal: '1000.00', componentTotal: '999.50', grossAbsoluteDifference: '0.50', netDifference: '0.50' }
      : { authoritativeTotal: '2000.00', componentTotal: '1999.25', grossAbsoluteDifference: '0.75', netDifference: '0.75' }],
  }));
  const response = await summarizeTruckFixedCosts({ request, periodMonths: [month], execute, policy: approved });
  assert.deepEqual(calls, [
    { representation: 'current', periodMonth: month },
    { representation: 'locked', periodMonth: month },
  ], 'Two independent reads, one per representation');
  assert.equal(response.data.currentAmount, '1000.00');
  assert.equal(response.data.lockedAmount, '2000.00');
  assert.notEqual(response.data.currentAmount, response.data.lockedAmount);
  assert.equal(response.data.reconciliation.current.grossAbsoluteDifference, '0.50');
  assert.equal(response.data.reconciliation.locked.grossAbsoluteDifference, '0.75');
  assert.equal(response.meta.representation.current, fixedCostBreakdownSources.current);
  assert.equal(response.meta.representation.locked, fixedCostBreakdownSources.locked);
  assert.equal(response.meta.representation.mode, 'current_and_locked_reported_separately');
});

test('a representation mismatch or crossed source from the repository fails closed', async () => {
  // Mutation: the repository answers a locked read with a current result.
  await assert.rejects(summarize(() => monetaryResult({ representation: 'current' })), InvalidFixedCostMonetaryResult);
  // Mutation: the breakdown source does not match the requested representation.
  await assert.rejects(summarize(representation => {
    const result = monetaryResult({ representation });
    return { ...result, meta: { ...result.meta, breakdownSource: fixedCostBreakdownSources.current } };
  }), InvalidFixedCostMonetaryResult);
  // Mutation: a different period sneaks back.
  await assert.rejects(summarize(representation => monetaryResult({ representation, periodMonth: '2025-02-01' })), InvalidFixedCostMonetaryResult);
  // Mutation: currency or date basis drift.
  for (const meta of [{ currency: 'USD' }, { dateBasis: 'locked_kastaiVilkiko_data' }, { allocationScope: 'trailer' }]) {
    await assert.rejects(summarize(representation => {
      const result = monetaryResult({ representation });
      return { ...result, meta: { ...result.meta, ...meta } } as FixedCostMonetaryResult;
    }), InvalidFixedCostMonetaryResult);
  }
});

test('monetary values pass through as exact decimal strings with no JavaScript arithmetic', async () => {
  const response = await summarize(representation => monetaryResult({
    representation,
    groups: [{
      authoritativeTotal: '0.30', comparableAuthoritativeTotal: '0.30',
      componentTotal: '0.10', netDifference: '0.20', grossAbsoluteDifference: '0.20',
    }],
  }));
  for (const value of [response.data.currentAmount, response.data.lockedAmount]) {
    assert.equal(typeof value, 'string');
    assert.equal(value, '0.30');
    assert.notEqual(value, String(0.1 + 0.2), 'Never round-tripped through a float');
  }
  assert.equal(response.data.reconciliation.current.netDifference, '0.20');
  // Trailing zeros and large magnitudes survive untouched.
  const wide = await summarize(representation => monetaryResult({
    representation, groups: [{ authoritativeTotal: '-12345678901.90' }],
  }));
  assert.equal(wide.data.currentAmount, '-12345678901.90');
});

test('the authoritative total is copied from the stored total, never from component sums', async () => {
  const response = await summarize(representation => monetaryResult({
    representation,
    groups: [{ authoritativeTotal: '500.00', componentTotal: '499.00', comparableAuthoritativeTotal: '480.00' }],
  }));
  assert.equal(response.data.currentAmount, '500.00', 'Stored authoritative total');
  assert.notEqual(response.data.currentAmount, response.data.reconciliation.current.componentTotal);
  assert.notEqual(response.data.currentAmount, response.data.reconciliation.current.comparableAuthoritativeTotal);
  assert.equal(response.meta.amountSemantics, 'stored_task_level_authoritative_total');
  assert.equal(response.meta.authoritativeSource, fixedCostAuthoritativeSource);
});

test('reconciliation evidence is preserved and never netted away', async () => {
  const response = await summarize(representation => monetaryResult({
    representation,
    groups: [{ netDifference: '0.00', grossAbsoluteDifference: '40.00', affectedRecords: 4, buckets: { exact: 4, rounding: 0, small: 4, moderate: 0, material: 0, large: 0 }, comparableRecords: 8 }],
  }));
  const current = response.data.reconciliation.current;
  // Opposite signs cancel in net but the gross figure still shows the exposure.
  assert.equal(current.netDifference, '0.00');
  assert.equal(current.grossAbsoluteDifference, '40.00');
  assert.notEqual(current.netDifference, current.grossAbsoluteDifference);
  assert.equal(current.affectedRecords, 4);
  assert.deepEqual(current.buckets, { exact: 4, rounding: 0, small: 4, moderate: 0, material: 0, large: 0 });
  assert.equal(response.meta.reconciliationStatus, 'unreconciled');
});

test('count invariants hold and a disagreeing population fails closed', async () => {
  const response = await summarize(representation => monetaryResult({
    representation, groups: [{ authoritativeRecords: 10, lockedRecords: 6, unlockedRecords: 3, unknownLockRecords: 1 }],
  }));
  assert.equal(response.data.totalTaskCount, 10);
  assert.equal(response.data.lockedTaskCount, 6);
  assert.equal(response.data.unlockedTaskCount, 3);
  assert.equal(response.data.unknownLockStateTaskCount, 1);
  assert.equal(
    response.data.lockedTaskCount + response.data.unlockedTaskCount + response.data.unknownLockStateTaskCount,
    response.data.totalTaskCount, 'Lock states cover the population',
  );
  // Lock states that do not cover the population fail closed.
  await assert.rejects(summarize(representation => monetaryResult({
    representation, groups: [{ authoritativeRecords: 10, lockedRecords: 6, unlockedRecords: 2, unknownLockRecords: 1 }],
  })), InvalidFixedCostMonetaryResult);
  // Current and locked reads describing different populations fail closed.
  await assert.rejects(summarize(representation => monetaryResult({
    representation,
    groups: [representation === 'current' ? { authoritativeRecords: 10, lockedRecords: 6, unlockedRecords: 4 } : { authoritativeRecords: 11, lockedRecords: 7, unlockedRecords: 4 }],
  })), InvalidFixedCostMonetaryResult);
});

test('an empty period reports zero counts and null amounts, never a fabricated zero', async () => {
  const response = await summarize(representation => monetaryResult({ representation, groups: [] }));
  assert.equal(response.data.currentAmount, null);
  assert.equal(response.data.lockedAmount, null);
  assert.equal(response.data.totalTaskCount, 0);
  assert.equal(response.data.lockedTaskCount, 0);
  assert.equal(response.data.unlockedTaskCount, 0);
  assert.equal(response.data.reconciliation.current.status, 'structurally_non_comparable');
  assert.equal(response.data.reconciliation.current.componentTotal, null);
  assert.doesNotMatch(JSON.stringify(response.data.reconciliation), /"0\.00"/);
});

test('a structurally non-comparable population keeps its total and nulls the comparison', async () => {
  const response = await summarize(representation => monetaryResult({
    representation,
    groups: [{
      reconciliationStatus: 'structurally_non_comparable', authoritativeTotal: '98765.43',
      comparableRecords: 0, affectedRecords: 0, comparableAuthoritativeTotal: null, componentTotal: null,
      netDifference: null, grossAbsoluteDifference: null, noDetailRecords: 10, authoritativeRecords: 10,
      buckets: { exact: 0, rounding: 0, small: 0, moderate: 0, material: 0, large: 0 },
      lockedRecords: 0, unlockedRecords: 10, unknownLockRecords: 0,
    }],
  }));
  assert.equal(response.data.currentAmount, '98765.43', 'The real authoritative total survives');
  assert.equal(response.data.reconciliation.current.status, 'structurally_non_comparable');
  assert.equal(response.data.reconciliation.current.componentTotal, null);
  assert.equal(response.data.reconciliation.current.grossAbsoluteDifference, null);
  assert.equal(response.data.unlockedTaskCount, 10);
});

test('orphan records surface through missingTaskCount and an extra limitation', async () => {
  const response = await summarize(representation => monetaryResult({
    representation, groups: [{ missingTaskCount: 7 }],
  }));
  assert.equal(response.meta.missingTaskCount, 7);
  assert.ok(response.meta.limitations.some(entry => /no matching uzdaviniai task/.test(entry)));
  const none = await summarize(representation => monetaryResult({ representation }));
  assert.equal(none.meta.missingTaskCount, 0);
  assert.ok(!none.meta.limitations.some(entry => /no matching uzdaviniai task/.test(entry)));
});

test('a truncated or incomplete repository result never becomes a summary', async () => {
  for (const meta of [{ complete: false }, { truncated: true }]) {
    await assert.rejects(summarize(representation => monetaryResult({ representation, ...meta })), (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostSummaryUnavailable);
      assert.equal(error.reason, 'incomplete_population');
      return true;
    });
  }
});

test('limitations are deterministically ordered, de-duplicated and never insertion-ordered', async () => {
  const response = await summarize(representation => monetaryResult({ representation, groups: [{ missingTaskCount: 3 }] }));
  const limitations = [...response.meta.limitations];
  assert.deepEqual(limitations, [...limitations].sort(), 'Sorted');
  assert.equal(new Set(limitations).size, limitations.length, 'De-duplicated');
  assert.deepEqual(orderFixedCostLimitations(['b', 'a', 'b']), ['a', 'b']);
  // The same inputs in any order produce the same output.
  assert.deepEqual(orderFixedCostLimitations(['z', 'a']), orderFixedCostLimitations(['a', 'z']));
  // Current values are never presented as final.
  assert.ok(truckFixedCostSummaryLimitations.some(entry => /not final results/.test(entry)));
  assert.ok(response.meta.limitations.some(entry => /not final results/.test(entry)));
  assert.equal(response.meta.semanticsVersion, null);
  assert.equal(response.meta.classificationVersion, null);
  assert.equal(response.meta.classificationApplied, false);
});

// --- policy and period gates --------------------------------------------------

test('the unapproved deleted-row policy blocks the summary before any executor call', async () => {
  const { execute, calls } = executor(representation => monetaryResult({ representation }));
  for (const policy of [undefined, unapprovedFixedCostDeletedRowPolicy, { ...approved, approved: false }, { ...approved, approvedBy: '' }]) {
    await assert.rejects(
      summarizeTruckFixedCosts({ request, periodMonths: [month], execute, policy: policy as FixedCostDeletedRowPolicy }),
      FixedCostDeletedPolicyUnapproved,
    );
  }
  assert.equal(calls.length, 0, 'No monetary read occurred');
});

test('policies that would merge or add across declared row states fail closed', async () => {
  for (const [treatment, reason] of [
    ['separate_by_state', 'deleted_state_collapse_unapproved'],
    ['include_all', 'cross_state_addition_unavailable'],
  ] as const) {
    await assert.rejects(summarize(representation => monetaryResult({
      representation,
      groups: [{ deletedState: 'zero' }, { deletedState: 'one', authoritativeTotal: '10.00' }],
    }), { policy: { ...approved, treatment } }), (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostSummaryUnavailable);
      assert.equal(error.reason, reason);
      return true;
    });
  }
  // `exclude_deleted` selects the zero group without any arithmetic.
  const response = await summarize(representation => monetaryResult({
    representation,
    groups: [{ deletedState: 'zero', authoritativeTotal: '100.00' }, { deletedState: 'one', authoritativeTotal: '10.00' }],
  }));
  assert.equal(response.data.currentAmount, '100.00', 'Only the zero-state group, never a sum');
  assert.ok(response.meta.limitations.some(entry => /non-zero deleted flag are excluded/.test(entry)));
});

test('multi-month and empty periods are explicit blockers, not silent aggregation', async () => {
  for (const [periodMonths, reason] of [
    [[], 'month_mapping_unapproved'],
    [['2025-02-01', '2025-03-01'], 'multi_month_aggregation_unavailable'],
  ] as const) {
    const { execute, calls } = executor(representation => monetaryResult({ representation }));
    await assert.rejects(
      summarizeTruckFixedCosts({ request, periodMonths, execute, policy: approved }),
      (error: unknown) => {
        assert.ok(error instanceof TruckFixedCostSummaryUnavailable);
        assert.equal(error.reason, reason);
        assert.equal(error.blocker, fixedCostSummaryMonthMappingBlocker);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'No monetary read for an unusable period');
  }
});

test('timeout stays a timeout and gate saturation stays SERVICE_BUSY', async () => {
  const timeout = Object.assign(new Error('driver'), { code: 'ER_STATEMENT_TIMEOUT' });
  const { execute } = executor(() => { throw new FixedCostMonetaryError(timeout); });
  await assert.rejects(summarizeTruckFixedCosts({ request, periodMonths: [month], execute, policy: approved }), (error: unknown) => {
    assert.ok(error instanceof FixedCostMonetaryError);
    assert.equal(error.code, 'QUERY_TIMEOUT');
    assert.equal(error.statusCode, 504);
    return true;
  });

  // The repository re-throws analytics-gate saturation unchanged, so SERVICE_BUSY survives.
  const busy = new AnalyticsGate(1, 0, 1000);
  const pool = { query: async () => [], end: async () => {} } as ReplicaPool;
  const held = busy.run(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await assert.rejects(
    queryFixedCostMonetaryTotals(pool, busy, { allocationScope: 'truck', representation: 'current', periodMonth: month, limit: 10 }, approved),
    (error: unknown) => {
      assert.ok(error instanceof ApiError, 'Saturation is not flattened into a repository error');
      assert.equal(error.code, 'SERVICE_BUSY');
      assert.equal(error.statusCode, 503);
      return true;
    },
  );
  await held;
});

// --- route boundary -----------------------------------------------------------

test('a valid public truck summary request is still blocked with zero replica access', async () => {
  const config = loadConfig({
    ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
    ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
  });
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => { calls.push(sql); throw new Error('Public routes must not reach the replica'); },
    end: async () => {},
  } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  const routes = new Set<string>();
  app.addHook('onRoute', route => { routes.add(route.url); });
  try {
    await app.ready();
    // The exact request the Slice 6A contract accepts is still refused.
    const response = await app.inject('/expense-analytics/fixed-costs/summary?allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31');
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json(), {
      error: {
        code: 'SEMANTICS_UNVERIFIED',
        message: 'The requested fixed-cost allocation scope has not passed source, amount, currency, date, lock/status, and reconciliation validation.',
      },
    });
    // Breakdown, dimensions and every other scope stay blocked.
    for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
      for (const scope of fixedCostAllocationScopes) {
        assert.equal(fixedCostSemanticCapabilities[scope].enabled, false, scope);
        const blocked = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?allocationScope=${scope}&dateFrom=2025-03-01&dateTo=2025-03-31`);
        assert.equal(blocked.statusCode, 422, `${endpoint}/${scope}`);
        assert.equal(blocked.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
    }
    // Unsupported input is refused before the semantic gate and never reaches a repository.
    for (const query of ['allocationScope=truck&representation=locked', 'allocationScope=truck&dateFrom=2025-03-01', 'allocationScope=truck&limit=5']) {
      const rejected = await app.inject(`/expense-analytics/fixed-costs/summary?${query}`);
      assert.equal(rejected.statusCode, 400, query);
      assert.equal(rejected.json().error.code, 'INVALID_QUERY');
    }
    // No summary, monetary, reconciliation or diagnostic HTTP path exists.
    assert.ok([...routes].every(path => !/monetary|reconcil|diagnost|totals|component/i.test(path)));
    for (const path of [
      '/expense-analytics/fixed-costs/summary/truck', '/expense-analytics/fixed-costs/totals',
      '/expense-analytics/fixed-costs/monetary', '/expense-analytics/fixed-costs/reconciliation',
      '/fixed-costs/summary',
    ]) {
      for (const method of ['GET', 'POST'] as const) assert.equal((await app.inject({ method, url: path })).statusCode, 404, path);
    }
    assert.equal(calls.length, 0, 'Zero replica access from the public surface');
  } finally { await app.close(); }
});

test('existing vehicle, invoice and schema routes are still registered unchanged', async () => {
  const config = loadConfig({
    ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
    ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
  });
  const pool = { query: async () => [], end: async () => {} } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  const routes = new Set<string>();
  app.addHook('onRoute', route => { routes.add(route.url); });
  try {
    await app.ready();
    // Plugin-registered routes appear on the hook; `/health` is registered directly
    // on the instance before the hook attaches, so it is verified by injection.
    for (const path of ['/vehicles', '/invoices', '/schema/tables']) {
      assert.ok([...routes].some(route => route === path || route.startsWith(`${path}/`)), `${path} still registered`);
    }
    assert.equal((await app.inject('/health')).statusCode, 200, '/health still registered');
    assert.deepEqual([...routes].filter(path => path.includes('fixed-costs')).sort(), [
      // MP-8 single-trailer month discovery; the only fixed-cost route added since.
      '/expense-analytics/fixed-costs/available-periods',
      '/expense-analytics/fixed-costs/breakdown',
      '/expense-analytics/fixed-costs/dimensions',
      '/expense-analytics/fixed-costs/summary',
    ], 'No new fixed-cost route was added');
  } finally { await app.close(); }
});

// --- period/request consistency (review correction) ---------------------------

test('an injected cost month must be canonical and must overlap the echoed request range', async () => {
  const build = (representation: FixedCostRepresentation) => monetaryResult({ representation, periodMonth: '2024-07-01' });
  // A month sharing no day with the requested range would let the response echo one
  // period while reporting another period's money.
  const { execute, calls } = executor(build);
  await assert.rejects(
    summarizeTruckFixedCosts({ request, periodMonths: ['2024-07-01'], execute, policy: approved }),
    (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostSummaryUnavailable);
      assert.equal(error.reason, 'period_outside_request_range');
      assert.equal(error.blocker, fixedCostSummaryMonthMappingBlocker);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'Rejected before any monetary read');

  // Non-canonical month text never reaches metadata.
  for (const bad of ['not-a-month', '2025-03', '2025-03-15', '2025-13-01', '', '2025-3-01']) {
    await assert.rejects(
      summarizeTruckFixedCosts({ request, periodMonths: [bad], execute, policy: approved }),
      (error: unknown) => {
        assert.ok(error instanceof TruckFixedCostSummaryUnavailable);
        assert.equal(error.reason, 'period_month_invalid');
        return true;
      }, bad,
    );
  }
});

test('the overlap check accepts any month sharing a day with the request and decides nothing else', () => {
  // It is a necessary condition only: it never chooses between overlapping months,
  // nor decides dateTo inclusivity or partial-month treatment. That stays FC-P19.
  const range = { allocationScope: 'truck', dateFrom: '2025-03-10', dateTo: '2025-04-20' } as const;
  for (const month of ['2025-03-01', '2025-04-01']) {
    assert.doesNotThrow(() => assertSummaryPeriodMonths([month], range), month);
  }
  for (const month of ['2025-02-01', '2025-05-01']) {
    assert.throws(() => assertSummaryPeriodMonths([month], range), TruckFixedCostSummaryUnavailable, month);
  }
  // Boundary: a month ending exactly on dateFrom does not overlap; one starting on dateTo does.
  assert.throws(() => assertSummaryPeriodMonths(['2025-02-01'], { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31' }));
  assert.doesNotThrow(() => assertSummaryPeriodMonths(['2025-03-01'], { allocationScope: 'truck', dateFrom: '2025-03-31', dateTo: '2025-04-02' }));
});

test('a consistent month still produces a summary whose dates describe its own data', async () => {
  const response = await summarize(representation => monetaryResult({ representation }));
  assert.equal(response.data.dateFrom, request.dateFrom);
  assert.equal(response.data.dateTo, request.dateTo);
  assert.deepEqual([...response.meta.periodMonths], [month]);
  // The reported month lies inside the echoed range.
  assert.ok(response.meta.periodMonths.every(entry => entry >= response.data.dateFrom.slice(0, 7) + '-01'));
});
