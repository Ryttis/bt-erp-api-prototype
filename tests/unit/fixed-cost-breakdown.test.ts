import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { ApiError } from '../../src/errors.js';
import {
  fixedCostBreakdownDefaultPageSize, fixedCostBreakdownMaxGroups, fixedCostBreakdownMaxPageSize,
  fixedCostBreakdownSortAvailability, fixedCostBreakdownTieBreaker, fixedCostComponentInventory,
  fixedCostGroupingAvailability, fixedCostGroupings, isGroupingAvailable,
  parseTruckFixedCostBreakdownRequest, TruckFixedCostBreakdownUnavailable,
  type TruckFixedCostBreakdownRequest,
} from '../../src/fixed-costs/breakdown-contract.js';
import {
  buildTruckFixedCostBreakdown,
  type TruckBreakdownExecutor, type TruckBreakdownExecutorResult, type TruckBreakdownGroupRow,
} from '../../src/fixed-costs/breakdown-service.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes, InvalidFixedCostQuery } from '../../src/fixed-costs/contracts.js';
import {
  FixedCostDeletedPolicyUnapproved, InvalidFixedCostMonetaryResult, unapprovedFixedCostDeletedRowPolicy,
  type FixedCostDeletedRowPolicy, type FixedCostRepresentation,
} from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostComponentFields } from '../../src/fixed-costs/monetary-repository.js';

const month = '2025-03-01';
const approved: FixedCostDeletedRowPolicy = Object.freeze({
  treatment: 'exclude_deleted', approved: true, approvedBy: 'internal-test-owner', reference: 'FC-03',
});
/** Only injected so the orchestration below is reachable; the real registry is disabled. */
const enabledTruck = { truck: { enabled: true } };

const baseQuery = { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', groupBy: 'truck' };
const request = (overrides: Record<string, string> = {}): TruckFixedCostBreakdownRequest =>
  parseTruckFixedCostBreakdownRequest({ ...baseQuery, ...overrides });

const reconciliation = (overrides: Record<string, unknown> = {}) => ({
  status: 'unreconciled' as const,
  comparableRecords: 4,
  affectedRecords: 1,
  componentTotal: '99.50',
  netDifference: '0.50',
  grossAbsoluteDifference: '0.50',
  buckets: { exact: 3, rounding: 1, small: 0, moderate: 0, material: 0, large: 0 },
  noDetailRecords: 0,
  multipleDetailRecords: 0,
  ...overrides,
});

function groupRow(overrides: Partial<TruckBreakdownGroupRow> = {}): TruckBreakdownGroupRow {
  const taskCount = overrides.taskCount ?? 4;
  return {
    truckId: 11,
    authoritativeTotal: '100.00',
    taskCount,
    lockedRecords: taskCount,
    unlockedRecords: 0,
    unknownLockRecords: 0,
    missingTaskCount: 0,
    zeroTruckCount: 0,
    reconciliation: reconciliation(),
    ...overrides,
  };
}

function executor(build: (representation: FixedCostRepresentation) => Partial<TruckBreakdownExecutorResult>) {
  const calls: { representation: FixedCostRepresentation; periodMonth: string; truckIds?: readonly number[] }[] = [];
  const execute: TruckBreakdownExecutor = async input => {
    calls.push({ representation: input.representation, periodMonth: input.periodMonth, truckIds: input.truckIds });
    await setImmediate();
    const partial = build(input.representation);
    const rows = partial.rows ?? [groupRow()];
    return {
      representation: input.representation,
      periodMonth: input.periodMonth,
      rows,
      complete: true,
      truncated: false,
      groupCount: rows.length,
      ...partial,
    };
  };
  return { execute, calls };
}

const build = (
  overrides: Partial<Parameters<typeof buildTruckFixedCostBreakdown>[0]> = {},
  rowsFor: (representation: FixedCostRepresentation) => Partial<TruckBreakdownExecutorResult> = () => ({}),
) => {
  const { execute } = executor(rowsFor);
  return buildTruckFixedCostBreakdown({
    request: request(), periodMonths: [month], execute, policy: approved, capabilities: enabledTruck, ...overrides,
  });
};

// --- request contract ---------------------------------------------------------

test('the breakdown request accepts the allowlist and applies documented defaults', () => {
  const parsed = request();
  assert.deepEqual(parsed, {
    allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', groupBy: 'truck',
    page: 1, perPage: fixedCostBreakdownDefaultPageSize, sortBy: 'truckId', sortDirection: 'asc',
  });
  assert.equal(request({ page: '3', perPage: '200' }).perPage, 200);
  assert.deepEqual(request({ truckIds: '11,22' }).truckIds, [11, 22]);
  assert.equal(request({ sortDirection: 'desc' }).sortDirection, 'desc');
  for (const grouping of fixedCostGroupings) assert.equal(request({ groupBy: grouping }).groupBy, grouping);
});

test('the breakdown request rejects unknown, repeated, unbounded and SQL-shaped input', () => {
  const invalid: Record<string, unknown>[] = [
    {}, { ...baseQuery, allocationScope: 'trailer' }, { ...baseQuery, allocationScope: 'fleet' },
    { dateFrom: '2025-03-01', dateTo: '2025-03-31', groupBy: 'truck' },
    { ...baseQuery, groupBy: 'driver' }, { ...baseQuery, groupBy: 'TRUCK' }, { ...baseQuery, groupBy: '' },
    { ...baseQuery, dateFrom: '2025-02-30' }, { ...baseQuery, dateFrom: '2025-3-01' },
    { ...baseQuery, dateFrom: '2025-04-01', dateTo: '2025-03-01' },
    { ...baseQuery, dateFrom: '2024-01-01', dateTo: '2025-01-02' },
    { allocationScope: 'truck', dateFrom: '2025-03-01', groupBy: 'truck' },
    // Unbounded or malformed pagination.
    { ...baseQuery, page: '0' }, { ...baseQuery, page: '-1' }, { ...baseQuery, page: '1.5' },
    { ...baseQuery, perPage: '0' }, { ...baseQuery, perPage: String(fixedCostBreakdownMaxPageSize + 1) },
    { ...baseQuery, perPage: '1e3' }, { ...baseQuery, perPage: ' 10' }, { ...baseQuery, perPage: '+10' },
    // Unsupported sorting.
    { ...baseQuery, sortBy: 'amount' }, { ...baseQuery, sortBy: 'kastaiVilkiko' }, { ...baseQuery, sortDirection: 'up' },
    // Repeated parameters arrive as arrays.
    { ...baseQuery, groupBy: ['truck', 'month'] }, { ...baseQuery, allocationScope: ['truck', 'truck'] },
    // Truck identifiers must be positive distinct integers.
    { ...baseQuery, truckIds: '0' }, { ...baseQuery, truckIds: '-1' }, { ...baseQuery, truckIds: '1.5' },
    { ...baseQuery, truckIds: 'abc' }, { ...baseQuery, truckIds: '11,11' }, { ...baseQuery, truckIds: '11,' },
    { ...baseQuery, truckIds: Array.from({ length: 51 }, (_, i) => i + 1).join(',') },
    // Arbitrary fields, measures, filters, tables, columns and SQL.
    { ...baseQuery, fields: 'amount' }, { ...baseQuery, measures: 'sum' }, { ...baseQuery, filter: 'amount>1' },
    { ...baseQuery, table: 'kastai_fiksuoti_ataskaita' }, { ...baseQuery, column: 'kastaiVilkiko' },
    { ...baseQuery, representation: 'locked' }, { ...baseQuery, deletedPolicy: 'include_all' },
    { ...baseQuery, tolerance: '1.00' }, { ...baseQuery, limit: '5' },
    { ...baseQuery, truckIds: "11); DROP TABLE masinos --" },
    { ...baseQuery, sortBy: 'truckId; DROP TABLE masinos' },
    { ...baseQuery, dateFrom: "2025-03-01' OR 1=1" },
  ];
  for (const input of invalid) {
    assert.throws(() => parseTruckFixedCostBreakdownRequest(input), InvalidFixedCostQuery, JSON.stringify(input));
  }
});

// --- grouping availability ----------------------------------------------------

test('grouping availability is explicit and blocked groupings are never treated as supported', async () => {
  assert.equal(fixedCostGroupingAvailability.truck.status, 'structurally_supported_not_activated');
  assert.match(fixedCostGroupingAvailability.truck.basis, /uzdavinio_masina/);
  assert.equal(fixedCostGroupingAvailability.month.status, 'blocked');
  assert.deepEqual([...fixedCostGroupingAvailability.month.blockers], ['FC-P19']);
  assert.equal(fixedCostGroupingAvailability.costComponent.status, 'blocked');
  assert.deepEqual([...fixedCostGroupingAvailability.costComponent.blockers], ['FC-06', 'FC-07']);
  assert.equal(isGroupingAvailable('truck'), true);
  assert.equal(isGroupingAvailable('month'), false);
  assert.equal(isGroupingAvailable('costComponent'), false);

  for (const [grouping, blockers] of [['month', ['FC-P19']], ['costComponent', ['FC-06', 'FC-07']]] as const) {
    const { execute, calls } = executor(() => ({}));
    await assert.rejects(
      buildTruckFixedCostBreakdown({ request: request({ groupBy: grouping }), periodMonths: [month], execute, policy: approved, capabilities: enabledTruck }),
      (error: unknown) => {
        assert.ok(error instanceof TruckFixedCostBreakdownUnavailable);
        assert.equal(error.reason, 'grouping_blocked');
        assert.deepEqual([...error.blockers], blockers);
        return true;
      }, grouping,
    );
    assert.equal(calls.length, 0, `${grouping} never reached the executor`);
  }
});

// --- gates --------------------------------------------------------------------

test('capability and policy gates both run before any executor access', async () => {
  // The real registry is disabled, so the default path refuses.
  const { execute, calls } = executor(() => ({}));
  await assert.rejects(
    buildTruckFixedCostBreakdown({ request: request(), periodMonths: [month], execute, policy: approved }),
    (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostBreakdownUnavailable);
      assert.equal(error.reason, 'grouping_not_activated');
      return true;
    },
  );
  assert.equal(calls.length, 0, 'Disabled capability blocked before the executor');
  for (const scope of fixedCostAllocationScopes) assert.equal(fixedCostSemanticCapabilities[scope].enabled, false);

  // With the capability injected, the unapproved policy still refuses first.
  for (const policy of [undefined, unapprovedFixedCostDeletedRowPolicy, { ...approved, approved: false }, { ...approved, approvedBy: '' }]) {
    await assert.rejects(
      buildTruckFixedCostBreakdown({ request: request(), periodMonths: [month], execute, policy: policy as FixedCostDeletedRowPolicy, capabilities: enabledTruck }),
      FixedCostDeletedPolicyUnapproved,
    );
  }
  assert.equal(calls.length, 0, 'Unapproved policy blocked before the executor');
});

test('a monetary sort field is refused because money is never sorted in JavaScript', async () => {
  assert.equal(fixedCostBreakdownSortAvailability.truckId, true);
  assert.equal(fixedCostBreakdownSortAvailability.currentAmount, false);
  assert.equal(fixedCostBreakdownSortAvailability.lockedAmount, false);
  for (const sortBy of ['currentAmount', 'lockedAmount']) {
    const { execute, calls } = executor(() => ({}));
    await assert.rejects(
      buildTruckFixedCostBreakdown({ request: request({ sortBy }), periodMonths: [month], execute, policy: approved, capabilities: enabledTruck }),
      (error: unknown) => {
        assert.ok(error instanceof TruckFixedCostBreakdownUnavailable);
        assert.equal(error.reason, 'sort_field_unavailable');
        return true;
      }, sortBy,
    );
    assert.equal(calls.length, 0);
  }
});

// --- ordering and pagination --------------------------------------------------

test('ordering is total and deterministic on the immutable tie-breaker', async () => {
  const rows = [33, 11, 22].map(truckId => groupRow({ truckId }));
  const ascending = await build({}, () => ({ rows }));
  assert.deepEqual(ascending.data.groups.map(group => group.truckId), [11, 22, 33]);
  const descending = await build({ request: request({ sortDirection: 'desc' }) }, () => ({ rows }));
  assert.deepEqual(descending.data.groups.map(group => group.truckId), [33, 22, 11]);
  // Re-running with a different input order produces the same output order.
  const shuffled = await build({}, () => ({ rows: [22, 33, 11].map(truckId => groupRow({ truckId })) }));
  assert.deepEqual(shuffled.data.groups.map(group => group.truckId), ascending.data.groups.map(group => group.truckId));
  assert.deepEqual(ascending.meta.sorting.tieBreaker, fixedCostBreakdownTieBreaker);
  assert.equal(ascending.meta.sorting.sortBy, 'truckId');
});

test('pagination is bounded, page-complete and never overlaps or gaps', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => groupRow({ truckId: index + 1 }));
  const seen: number[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await build({ request: request({ page: String(page), perPage: '10' }) }, () => ({ rows }));
    assert.equal(response.meta.pagination.page, page);
    assert.equal(response.meta.pagination.perPage, 10);
    assert.equal(response.meta.pagination.groupCount, 25);
    assert.equal(response.meta.pagination.pageCount, 3);
    assert.equal(response.meta.pagination.maxGroups, fixedCostBreakdownMaxGroups);
    seen.push(...response.data.groups.map(group => group.truckId));
  }
  assert.deepEqual(seen, Array.from({ length: 25 }, (_, index) => index + 1), 'Pages tile the set exactly once');
  // A page beyond the end fails closed rather than silently returning empty.
  await assert.rejects(
    build({ request: request({ page: '4', perPage: '10' }) }, () => ({ rows })),
    (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostBreakdownUnavailable);
      assert.equal(error.reason, 'page_out_of_range');
      return true;
    },
  );
});

test('a group count beyond the maximum fails closed', async () => {
  const rows = Array.from({ length: fixedCostBreakdownMaxGroups + 1 }, (_, index) => groupRow({ truckId: index + 1 }));
  await assert.rejects(build({}, () => ({ rows })), (error: unknown) => {
    assert.ok(error instanceof TruckFixedCostBreakdownUnavailable);
    assert.equal(error.reason, 'group_count_exceeded');
    return true;
  });
});

// --- completeness -------------------------------------------------------------

test('an incomplete or truncated grouping is never presented as complete', async () => {
  for (const partial of [{ complete: false }, { truncated: true }]) {
    await assert.rejects(build({}, () => partial), (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostBreakdownUnavailable);
      assert.equal(error.reason, 'incomplete_grouping');
      return true;
    });
  }
  // A group count that disagrees with the rows means the executor cannot prove completeness.
  await assert.rejects(build({}, () => ({ rows: [groupRow()], groupCount: 5 })), InvalidFixedCostMonetaryResult);
  await assert.rejects(build({}, () => ({ rows: [groupRow({ truckId: 11 }), groupRow({ truckId: 11 })], groupCount: 2 })), InvalidFixedCostMonetaryResult);
});

test('representation, period and population mismatches are rejected', async () => {
  await assert.rejects(build({}, representation => representation === 'locked' ? { representation: 'current' } : {}), InvalidFixedCostMonetaryResult);
  await assert.rejects(build({}, () => ({ periodMonth: '2025-02-01' })), InvalidFixedCostMonetaryResult);
  // Different group sets between representations.
  await assert.rejects(build({}, representation => ({
    rows: representation === 'current' ? [groupRow({ truckId: 11 })] : [groupRow({ truckId: 22 })],
  })), InvalidFixedCostMonetaryResult);
  // Same groups, different populations.
  await assert.rejects(build({}, representation => ({
    rows: [groupRow({ truckId: 11, taskCount: representation === 'current' ? 4 : 5, lockedRecords: representation === 'current' ? 4 : 5 })],
  })), InvalidFixedCostMonetaryResult);
  // Lock states that do not cover the group.
  await assert.rejects(build({}, () => ({ rows: [groupRow({ taskCount: 4, lockedRecords: 1, unlockedRecords: 1, unknownLockRecords: 1 })] })), InvalidFixedCostMonetaryResult);
});

// --- amounts and separation ---------------------------------------------------

test('current and locked amounts stay independent and are copied as decimal strings', async () => {
  const response = await build({}, representation => ({
    rows: [groupRow({ truckId: 11, authoritativeTotal: representation === 'current' ? '0.30' : '2000.10' })],
  }));
  const [group] = response.data.groups;
  assert.equal(group.currentAmount, '0.30');
  assert.equal(group.lockedAmount, '2000.10');
  assert.notEqual(group.currentAmount, group.lockedAmount);
  assert.equal(typeof group.currentAmount, 'string');
  assert.notEqual(group.currentAmount, String(0.1 + 0.2), 'Never round-tripped through a float');
  // Reconciliation stays per representation and is never netted away.
  assert.equal(group.reconciliation.current.grossAbsoluteDifference, '0.50');
  assert.equal(group.reconciliation.locked.grossAbsoluteDifference, '0.50');
  // A malformed decimal fails closed rather than being coerced.
  for (const bad of [100, '100', '1,00', '1e2', true]) {
    await assert.rejects(build({}, () => ({ rows: [groupRow({ authoritativeTotal: bad as string })] })), InvalidFixedCostMonetaryResult);
  }
});

test('a component total never stands in for the authoritative total', async () => {
  const response = await build({}, () => ({
    rows: [groupRow({ truckId: 11, authoritativeTotal: '500.00', reconciliation: reconciliation({ componentTotal: '499.00' }) })],
  }));
  const [group] = response.data.groups;
  assert.equal(group.currentAmount, '500.00');
  assert.notEqual(group.currentAmount, group.reconciliation.current.componentTotal);
  assert.equal(response.meta.amountSemantics, 'stored_task_level_authoritative_total');
  // The component inventory is explanatory only and carries no measure.
  assert.equal(fixedCostComponentInventory.status, 'explanatory_semantics_unverified');
  assert.equal(fixedCostComponentInventory.independentlyAdditive, false);
  assert.equal(fixedCostComponentInventory.syntheticResidualBucket, false);
  assert.deepEqual([...fixedCostComponentInventory.fields], [...fixedCostComponentFields].sort());
  assert.equal(fixedCostComponentInventory.fields.length, 15);
  assert.ok(!fixedCostComponentInventory.fields.some(field => /^other$/i.test(field)), 'No synthetic residual bucket');
  assert.doesNotMatch(JSON.stringify(fixedCostComponentInventory.fields), /fuel|payroll|overhead|category|group/i);
});

test('no detail table is joined, so a one-to-many relationship cannot multiply a total', async () => {
  // Multiple detail rows behind a task never change the authoritative total, and the
  // structural counter stays visible instead.
  const response = await build({}, () => ({
    rows: [groupRow({ truckId: 11, authoritativeTotal: '100.00', reconciliation: reconciliation({ multipleDetailRecords: 3, comparableRecords: 1, affectedRecords: 0, buckets: { exact: 1, rounding: 0, small: 0, moderate: 0, material: 0, large: 0 } }) })],
  }));
  const [group] = response.data.groups;
  assert.equal(group.currentAmount, '100.00', 'Unmultiplied by the three detail rows');
  assert.equal(group.reconciliation.current.multipleDetailRecords, 3);
  assert.equal(group.taskCount, 4);
});

// --- orphans ------------------------------------------------------------------

test('unresolved trucks are reported separately and never given an invented identifier', async () => {
  const response = await build({}, () => ({
    rows: [
      groupRow({ truckId: 11 }),
      groupRow({ truckId: null, taskCount: 7, lockedRecords: 7, missingTaskCount: 5, zeroTruckCount: 2, authoritativeTotal: '42.00' }),
    ],
  }));
  assert.deepEqual(response.data.groups.map(group => group.truckId), [11], 'Only resolved trucks are grouped');
  assert.ok(response.data.unresolved);
  assert.equal(response.data.unresolved.reason, 'truck_unresolved');
  assert.equal(response.data.unresolved.taskCount, 7);
  assert.equal(response.data.unresolved.missingTaskCount, 5);
  assert.equal(response.data.unresolved.zeroTruckCount, 2);
  assert.equal(response.data.unresolved.currentAmount, '42.00');
  // No placeholder identifier anywhere in the serialized response.
  assert.ok(!Object.hasOwn(response.data.unresolved, 'truckId'), 'The unresolved bucket carries no identifier at all');
  // Every emitted truckId is a real positive master id; none is a placeholder.
  // (`lockStates.unknown` is a lock-state count, not an identifier, so the guard
  // targets identifier values rather than scanning for the word anywhere.)
  assert.ok(response.data.groups.every(group => Number.isSafeInteger(group.truckId) && group.truckId > 0));
  assert.doesNotMatch(JSON.stringify(response.data), /"truckId":\s*(0|-1|null|"[^"]*")/i, 'No placeholder or textual truck id');
  assert.ok(response.meta.limitations.some(entry => /never given an invented truck identifier/.test(entry)));
  // Absent when every record resolves.
  const clean = await build({}, () => ({ rows: [groupRow({ truckId: 11 })] }));
  assert.equal(clean.data.unresolved, null);
  // An invalid identifier from the executor fails closed instead of being coerced.
  for (const truckId of [0, -1, 1.5]) {
    await assert.rejects(build({}, () => ({ rows: [groupRow({ truckId })] })), InvalidFixedCostMonetaryResult);
  }
});

test('a group with no comparable records is never reported as a reconciled zero', async () => {
  const empty = reconciliation({
    status: 'structurally_non_comparable', comparableRecords: 0, affectedRecords: 0,
    componentTotal: null, netDifference: null, grossAbsoluteDifference: null,
    buckets: { exact: 0, rounding: 0, small: 0, moderate: 0, material: 0, large: 0 },
  });
  const response = await build({}, () => ({ rows: [groupRow({ reconciliation: empty })] }));
  const current = response.data.groups[0].reconciliation.current;
  assert.equal(current.status, 'structurally_non_comparable');
  assert.equal(current.netDifference, null);
  assert.equal(current.grossAbsoluteDifference, null);
  // A zero-comparable group claiming a difference, or claiming to be reconciled, fails closed.
  await assert.rejects(build({}, () => ({ rows: [groupRow({ reconciliation: reconciliation({ ...empty, netDifference: '0.00' }) })] })), InvalidFixedCostMonetaryResult);
  await assert.rejects(build({}, () => ({ rows: [groupRow({ reconciliation: reconciliation({ ...empty, status: 'unreconciled' }) })] })), InvalidFixedCostMonetaryResult);
});

// --- filtering, errors and metadata -------------------------------------------

test('a verified truck filter is forwarded as numbers only', async () => {
  const { execute, calls } = executor(() => ({ rows: [groupRow({ truckId: 11 })] }));
  await buildTruckFixedCostBreakdown({
    request: request({ truckIds: '11,22' }), periodMonths: [month], execute, policy: approved, capabilities: enabledTruck,
  });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual([...call.truckIds!], [11, 22]);
  assert.ok(calls.every(call => call.truckIds!.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)));
});

test('timeout and busy errors propagate unchanged', async () => {
  const timeout = Object.assign(new Error('driver'), { code: 'ER_STATEMENT_TIMEOUT', statusCode: 504 });
  await assert.rejects(build({ execute: async () => { throw timeout; } }), (error: unknown) => {
    assert.equal(error, timeout, 'Timeout is not re-wrapped');
    return true;
  });
  const busy = new ApiError(503, 'SERVICE_BUSY', 'Analytical service is busy');
  await assert.rejects(build({ execute: async () => { throw busy; } }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'SERVICE_BUSY');
    assert.equal(error.statusCode, 503);
    return true;
  });
});

test('metadata is complete, deterministic and invents no version', async () => {
  const response = await build();
  assert.equal(response.meta.sourceFamily, 'fixed_cost_truck_allocation');
  assert.equal(response.meta.dateBasis, 'kastai_data');
  assert.equal(response.meta.semanticsVersion, null);
  assert.equal(response.meta.classificationVersion, null);
  assert.equal(response.meta.classificationApplied, false);
  assert.equal(response.meta.reconciliationStatus, 'unreconciled');
  assert.equal(response.meta.groupBy, 'truck');
  assert.deepEqual(response.meta.groupingAvailability, fixedCostGroupingAvailability);
  assert.equal(response.data.currency, 'EUR');
  const limitations = [...response.meta.limitations];
  assert.deepEqual(limitations, [...limitations].sort(), 'Limitations sorted');
  assert.equal(new Set(limitations).size, limitations.length, 'Limitations de-duplicated');
  assert.ok(limitations.some(entry => /not final results/.test(entry)));
  assert.ok(limitations.some(entry => /money is never sorted in JavaScript/.test(entry)));
  for (const approval of ['FC-02', 'FC-03', 'FC-06', 'FC-07', 'FC-11', 'FC-14', 'FC-P17', 'FC-P19']) {
    assert.ok(response.meta.pendingApprovals.includes(approval), approval);
  }
});

// --- mutation guards ----------------------------------------------------------

test('mutation: dropping a safeguard changes an observable outcome', async () => {
  const rows = [33, 11, 22].map(truckId => groupRow({ truckId }));

  // Tie-breaker: without a total order the page contents would not be reproducible.
  const ordered = await build({}, () => ({ rows }));
  assert.deepEqual(ordered.data.groups.map(group => group.truckId), [11, 22, 33]);
  const unsorted = rows.map(row => row.truckId);
  assert.notDeepEqual(unsorted, ordered.data.groups.map(group => group.truckId), 'Input order is not the output order');

  // Crossing sources: swapping which representation supplies an amount is detectable.
  const separated = await build({}, representation => ({
    rows: [groupRow({ truckId: 11, authoritativeTotal: representation === 'current' ? '1.00' : '2.00' })],
  }));
  assert.equal(separated.data.groups[0].currentAmount, '1.00');
  assert.equal(separated.data.groups[0].lockedAmount, '2.00');
  assert.notEqual(separated.data.groups[0].currentAmount, separated.data.groups[0].lockedAmount);

  // Component sum as authoritative: the two remain distinguishable.
  const distinct = await build({}, () => ({
    rows: [groupRow({ authoritativeTotal: '10.00', reconciliation: reconciliation({ componentTotal: '9.00' }) })],
  }));
  assert.notEqual(distinct.data.groups[0].currentAmount, distinct.data.groups[0].reconciliation.current.componentTotal);

  // Gate order: executing before the gates would have produced a result.
  const { execute, calls } = executor(() => ({}));
  await assert.rejects(buildTruckFixedCostBreakdown({ request: request(), periodMonths: [month], execute, policy: approved }), TruckFixedCostBreakdownUnavailable);
  await assert.rejects(buildTruckFixedCostBreakdown({ request: request(), periodMonths: [month], execute, capabilities: enabledTruck }), FixedCostDeletedPolicyUnapproved);
  assert.equal(calls.length, 0, 'Neither gate allowed an executor call');

  // Truncated treated as complete would have produced a response.
  await assert.rejects(build({}, () => ({ truncated: true })), TruckFixedCostBreakdownUnavailable);

  // An invented identifier for an orphan would have placed it in the groups list.
  const orphaned = await build({}, () => ({ rows: [groupRow({ truckId: null, taskCount: 1, lockedRecords: 1 })] }));
  assert.deepEqual(orphaned.data.groups, []);
  assert.ok(orphaned.data.unresolved);
});

// --- public route boundary ----------------------------------------------------

test('public breakdown requests stay blocked with zero replica access', async () => {
  const config = loadConfig({
    ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
    ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
  });
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => { queries.push(sql); throw new Error('Public routes must not reach the replica'); },
    end: async () => {},
  } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  const routes = new Set<string>();
  app.addHook('onRoute', route => { routes.add(route.url); });
  try {
    await app.ready();
    // A request shaped exactly like the new contract is still refused.
    const blocked = await app.inject('/expense-analytics/fixed-costs/breakdown?allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31');
    assert.equal(blocked.statusCode, 422);
    assert.equal(blocked.json().error.code, 'SEMANTICS_UNVERIFIED');
    // Summary and dimensions are unchanged, and every scope stays blocked.
    for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
      for (const scope of fixedCostAllocationScopes) {
        const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?allocationScope=${scope}&dateFrom=2025-03-01&dateTo=2025-03-31`);
        assert.equal(response.statusCode, 422, `${endpoint}/${scope}`);
        assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
    }
    // Breakdown-specific parameters are still unknown to the public route, so they
    // are refused with 400 before the semantic gate and before any repository call.
    for (const query of ['allocationScope=truck&groupBy=truck', 'allocationScope=truck&page=1', 'allocationScope=truck&perPage=10', 'allocationScope=truck&sortBy=truckId']) {
      const rejected = await app.inject(`/expense-analytics/fixed-costs/breakdown?${query}`);
      assert.equal(rejected.statusCode, 400, query);
      assert.equal(rejected.json().error.code, 'INVALID_QUERY');
    }
    // No diagnostic, reconciliation, monetary or breakdown-detail path exists.
    assert.ok([...routes].every(path => !/monetary|reconcil|diagnost|totals|component|group/i.test(path)));
    for (const path of [
      '/expense-analytics/fixed-costs/breakdown/truck', '/expense-analytics/fixed-costs/groups',
      '/expense-analytics/fixed-costs/components', '/fixed-costs/breakdown',
    ]) {
      for (const method of ['GET', 'POST'] as const) assert.equal((await app.inject({ method, url: path })).statusCode, 404, path);
    }
    assert.deepEqual([...routes].filter(path => path.includes('fixed-costs')).sort(), [
      '/expense-analytics/fixed-costs/breakdown',
      '/expense-analytics/fixed-costs/dimensions',
      '/expense-analytics/fixed-costs/summary',
    ], 'No new fixed-cost route');
    assert.equal(queries.length, 0, 'Zero replica access');
  } finally { await app.close(); }
});

// --- review corrections -------------------------------------------------------

test('reconciliation money must be decimal text, never a JavaScript number', async () => {
  // Without validation a numeric component sum passes straight into the response.
  for (const field of ['componentTotal', 'netDifference', 'grossAbsoluteDifference'] as const) {
    for (const bad of [99.5, 0, '99,50', '1e2', true, {}]) {
      await assert.rejects(
        build({}, () => ({ rows: [groupRow({ reconciliation: reconciliation({ [field]: bad }) })] })),
        (error: unknown) => {
          assert.ok(error instanceof InvalidFixedCostMonetaryResult);
          assert.match(String(error), new RegExp(`reconciliation\\.${field}`));
          return true;
        }, `${field}=${String(bad)}`,
      );
    }
  }
  // Valid decimal text still passes through untouched, including a signed value.
  const response = await build({}, () => ({
    rows: [groupRow({ reconciliation: reconciliation({ netDifference: '-0.30', grossAbsoluteDifference: '0.30' }) })],
  }));
  const current = response.data.groups[0].reconciliation.current;
  assert.equal(current.netDifference, '-0.30');
  assert.equal(typeof current.netDifference, 'string');
  assert.notEqual(current.netDifference, String(0.1 + 0.2));
  // Nothing monetary in the response is a number.
  for (const value of [current.componentTotal, current.netDifference, current.grossAbsoluteDifference,
    response.data.groups[0].currentAmount, response.data.groups[0].lockedAmount]) {
    assert.ok(value === null || typeof value === 'string', 'Monetary values stay strings or null');
  }
});

test('a resolved truck group cannot silently carry missing-task records', async () => {
  // Truck resolution comes from uzdaviniai, so a resolved group implies its task
  // exists. Allowing a non-zero count here would drop that population entirely,
  // because only the unresolved bucket reports missing tasks.
  await assert.rejects(
    build({}, () => ({ rows: [groupRow({ truckId: 11, missingTaskCount: 5 })] })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidFixedCostMonetaryResult);
      assert.match(String(error), /resolved truck group cannot carry missing-task/);
      return true;
    },
  );
  // The unresolved bucket is still the place missing tasks stay visible.
  const response = await build({}, () => ({
    rows: [groupRow({ truckId: 11 }), groupRow({ truckId: null, taskCount: 3, lockedRecords: 3, missingTaskCount: 3 })],
  }));
  assert.equal(response.data.unresolved?.missingTaskCount, 3);
  assert.equal(response.data.groups.length, 1);
});
