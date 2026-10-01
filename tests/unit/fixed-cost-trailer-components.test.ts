import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { resolveTrailerComponentsCapability, resolveTruckComponentsCapability } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes } from '../../src/fixed-costs/contracts.js';
import {
  fixedCostBreakdownSources, fixedCostMonetaryMaxRecords, fixedCostTrailerBreakdownSources, FixedCostDeletedPolicyUnapproved,
  InvalidFixedCostMonetaryQuery, InvalidFixedCostMonetaryResult, parseFixedCostMonetaryQuery,
} from '../../src/fixed-costs/monetary-contract.js';
import {
  fixedCostComponentFields, fixedCostMonetaryStatement, fixedCostRankedComponentStatement, fixedCostTrailerComponentFields,
  queryFixedCostRankedComponents, queryTrailerFleetRankedComponents, trailerFleetComponentsQuery,
} from '../../src/fixed-costs/monetary-repository.js';
import { parseFixedCostComponentsRequest, truckFixedCostComponentsSorting } from '../../src/fixed-costs/pilot-components.js';
import { pilotIncludedGroup, truckFixedCostPilotDeletedRowPolicy, TruckFixedCostPilotRefused } from '../../src/fixed-costs/pilot-summary.js';
import { trailerFixedCostPilotDeletedRowPolicy, trailerPilotIncludedGroup } from '../../src/fixed-costs/pilot-trailer.js';
import {
  projectTrailerFleetFixedCostPilotComponents, runTrailerFleetFixedCostPilotComponents, trailerFleetComponentsIncludedGroup,
  trailerFleetFixedCostComponentKeys, trailerFleetFixedCostComponentsLimitations, trailerFleetFixedCostComponentsSemanticsVersion,
} from '../../src/fixed-costs/pilot-trailer-components.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';
import { trailerFleetGroupsStatement, trailerFleetTotalsStatement } from '../../src/fixed-costs/trailer-fleet-repository.js';

const baseEnvironment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
  ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};
const truckFlag = 'ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED';
const trailerFlag = 'ERP_FIXED_COST_TRAILER_PILOT_ENABLED';
const trailerConfig = loadConfig({ ...baseEnvironment, [trailerFlag]: 'true' });
const truckOnlyConfig = loadConfig({ ...baseEnvironment, [truckFlag]: 'true' });
const bothConfig = loadConfig({ ...baseEnvironment, [truckFlag]: 'true', [trailerFlag]: 'true' });
const disabledConfig = loadConfig(baseEnvironment);
const month = '2025-03-01';
const period = 'allocationScope=trailer&dateFrom=2025-03-01&dateTo=2025-03-31';
const truckPeriod = 'allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31';
const componentsUrl = (query: string) => `/expense-analytics/fixed-costs/components?${query}`;
const periodValues = ['2025-03-01', '2025-04-01'];
const now = new Date('2026-09-30T10:00:00Z');

/** Truck component keys that are not trailer component keys. */
const truckOnlyKeys = fixedCostComponentFields.filter(field => !(fixedCostTrailerComponentFields as readonly string[]).includes(field));

type Ordered = readonly (readonly [string, string | null])[];

/**
 * A database-ordered trailer component list: padangos largest, a tie broken by key,
 * the remaining keys at "0.00" in binary key order, and one negative last. The fake
 * driver cannot sort, so fixtures carry the order the statement's ORDER BY produces.
 */
const listed = ['padangos', 'amortizacija', 'lizingas', 'insurance_repair'];
const defaultOrder: Ordered = [
  ['padangos', '700.00'], ['amortizacija', '200.00'], ['lizingas', '200.00'],
  ...[...fixedCostTrailerComponentFields].filter(field => !listed.includes(field)).sort().map(field => [field, '0.00'] as const),
  ['insurance_repair', '-4.50'],
];
// 700 + 200 + 200 - 4.50 = 1095.50
const componentTotal = '1095.50';

interface AggregateOptions {
  deletedState?: string;
  records?: number;
  unlocked?: number;
  noDetail?: number;
  missingTask?: number;
  authoritativeTotal?: string | null;
}

/** One declared-state aggregate exactly as the inner monetary statement returns it. */
function aggregate(order: Ordered, options: AggregateOptions = {}) {
  const records = options.records ?? 5;
  const noDetail = options.noDetail ?? 2;
  const comparable = records - noDetail;
  const unlocked = options.unlocked ?? 0;
  return {
    deletedState: options.deletedState ?? 'zero',
    authoritativeRecords: records,
    authoritativeTotal: options.authoritativeTotal !== undefined ? options.authoritativeTotal : '1100.00',
    comparableRecords: comparable,
    comparableAuthoritativeTotal: comparable > 0 ? '1095.80' : null,
    componentTotal: comparable > 0 ? componentTotal : null,
    netDifference: comparable > 0 ? '0.30' : null,
    grossAbsoluteDifference: comparable > 0 ? '0.50' : null,
    affectedRecords: comparable > 0 ? 2 : 0,
    ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`,
      name === 'exact' ? Math.max(comparable - 2, 0) : name === 'rounding' && comparable > 0 ? 2 : 0])),
    noDetailRecords: noDetail,
    multipleDetailRecords: 0,
    missingTotalRecords: 0,
    missingTaskCount: options.missingTask ?? 1,
    lockedRecords: records - unlocked,
    unlockedRecords: unlocked,
    unknownLockRecords: 0,
    ...Object.fromEntries(order.map(([field, amount]) => [`component_${field}`, comparable > 0 ? amount : null])),
  };
}

/** The ranked statement's rows for one state: the aggregate repeated once per component, in database order. */
function rankedRows(order: Ordered = defaultOrder, options: AggregateOptions & { reconcile?: number | null } = {}) {
  const base = aggregate(order, options);
  const comparable = base.comparableRecords > 0;
  return order.map(([component, amount]) => ({
    ...base, component, componentAmount: comparable ? amount : null,
    componentsReconcile: options.reconcile !== undefined ? options.reconcile : comparable ? 1 : null,
  }));
}

/** The fleet summary's totals row for the same population (stored total 1100.00 over 5 tasks). */
function fleetTotalsRow() {
  return {
    deletedState: 'zero', authoritativeRecords: 5, authoritativeTotal: '1100.00', missingTotalRecords: 0,
    unlockedRecords: 0, lockedRecords: 5, unknownLockRecords: 0,
    attributedRecords: 4, attributedTrailers: 2, attributedTotal: '1105.00',
    unattributedRecords: 1, unattributedNonZeroRecords: 1, unattributedTotal: '-5.00',
    missing_taskRecords: 1, missing_taskNonZeroRecords: 1, missing_taskTotal: '-5.00',
    missing_assignmentRecords: 0, missing_assignmentNonZeroRecords: 0, missing_assignmentTotal: '0.00',
    invalid_master_idRecords: 0, invalid_master_idNonZeroRecords: 0, invalid_master_idTotal: '0.00',
    reconciles: 1,
  };
}

type Call = { sql: string; values: unknown[] };

function fakePool(respond: (sql: string) => unknown) {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      await setImmediate();
      return respond(sql);
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls };
}

async function withApp<T>(
  respond: (sql: string) => unknown,
  body: (app: ReturnType<typeof buildApp>, calls: Call[]) => Promise<T>,
  config = trailerConfig,
) {
  const { pool, calls } = fakePool(respond);
  const app = buildApp(config, () => pool, { authenticate: false });
  try { return await body(app, calls); } finally { await app.close(); }
}

async function run(rows: unknown, component?: string) {
  const { pool, calls } = fakePool(() => rows);
  const result = await runTrailerFleetFixedCostPilotComponents(pool, new AnalyticsGate(1), {
    allocationScope: 'trailer', dateFrom: '2025-03-01', dateTo: '2025-03-31',
    ...(component === undefined ? {} : { component: component as never }),
  }, now);
  return { result, calls };
}

const fleetStatement = () => fixedCostRankedComponentStatement(trailerFleetComponentsQuery(month, now));

const refusedWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof TruckFixedCostPilotRefused, String(error));
  assert.equal(error.code, code);
  return true;
};

const incompleteRead = (error: unknown) =>
  error instanceof InvalidFixedCostMonetaryResult || (error instanceof TruckFixedCostPilotRefused && error.code === 'INCOMPLETE_RESULT');

// --- capability and request contract ------------------------------------------

test('trailer components resolve only for the trailer scope under the strict trailer flag', () => {
  for (const scope of fixedCostAllocationScopes) {
    assert.equal(resolveTrailerComponentsCapability(scope, trailerConfig.fixedCosts), scope === 'trailer', scope);
    assert.equal(resolveTrailerComponentsCapability(scope, truckOnlyConfig.fixedCosts), false, scope);
    assert.equal(resolveTrailerComponentsCapability(scope, disabledConfig.fixedCosts), false, scope);
    // The trailer flag never enables the truck components.
    assert.equal(resolveTruckComponentsCapability(scope, trailerConfig.fixedCosts), false, scope);
  }
});

test('flag off and truck flag only are 422 SEMANTICS_UNVERIFIED for the trailer scope with zero replica access', async () => {
  for (const config of [disabledConfig, truckOnlyConfig]) {
    await withApp(() => rankedRows(), async (app, calls) => {
      for (const query of [period, `${period}&component=padangos`]) {
        const response = await app.inject(componentsUrl(query));
        assert.equal(response.statusCode, 422, query);
        assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED', query);
      }
      assert.equal(calls.length, 0);
    }, config);
  }
  // With only the trailer flag, the truck scope and every other scope stay disabled.
  await withApp(() => rankedRows(), async (app, calls) => {
    for (const scope of fixedCostAllocationScopes.filter(scope => scope !== 'trailer')) {
      const response = await app.inject(componentsUrl(period.replace('allocationScope=trailer', `allocationScope=${scope}`)));
      assert.equal(response.statusCode, 422, scope);
      assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED', scope);
    }
    assert.equal(calls.length, 0);
  });
});

test('truck-only, unknown and case-variant keys, trailerId and every grouping, ranking or paging parameter are 400 before replica access', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    for (const query of [
      ...truckOnlyKeys.map(key => `${period}&component=${key}`),
      `${period}&component=tires`, `${period}&component=PADANGOS`, `${period}&component=Padangos`, `${period}&component=USER_FEE`,
      `${period}&component=userFee`, `${period}&component=`, `${period}&component=padangos%20`, `${period}&component=padangos&component=remontas`,
      `${period}&component=padangos,remontas`, `${period}&component=padangos%3BDROP`,
      `${period}&trailerId=1`, `${period}&trailerId=0`, `${period}&truckId=1`,
      `${period}&groupBy=costComponent`, `${period}&groupBy=trailerId`, `${period}&sortBy=amount`, `${period}&sortDirection=asc`,
      `${period}&rank=1`, `${period}&top=5`, `${period}&page=1`, `${period}&perPage=5`, `${period}&limit=3`, `${period}&offset=1`,
      `${period}&representation=current`, `${period}&measure=SUM(padangos)`,
      'allocationScope=Trailer&dateFrom=2025-03-01&dateTo=2025-03-31', 'allocationScope=trailer', 'allocationScope=trailer&dateFrom=2025-03-01',
      'allocationScope=trailer&dateFrom=2025-03-01&dateTo=2026-04-30', 'allocationScope=trailer&dateFrom=2025-03-31&dateTo=2025-03-01',
    ]) {
      const response = await app.inject(componentsUrl(query));
      assert.equal(response.statusCode, 400, query);
      assert.equal(response.json().error.code, 'INVALID_QUERY', query);
    }
    assert.equal(calls.length, 0);
  });
});

test('date ranges, partial months and unsettled months are refused before replica access', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    for (const [query, code] of [
      ['allocationScope=trailer&dateFrom=2025-12-01&dateTo=2025-12-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=trailer&dateFrom=2025-12-02&dateTo=2025-12-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=trailer&dateFrom=2025-11-01&dateTo=2025-12-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=trailer&dateFrom=2025-01-01&dateTo=2025-12-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=trailer&dateFrom=2099-01-01&dateTo=2099-01-31', 'PERIOD_NOT_SETTLED'],
    ] as const) {
      const response = await app.inject(componentsUrl(query));
      assert.equal(response.statusCode, 422, query);
      assert.equal(response.json().error.code, code, query);
    }
    assert.equal(calls.length, 0);
  });
});

test('the parser accepts exactly the verified trailer keys for trailer and keeps the truck keys for truck', () => {
  assert.deepEqual([...trailerFleetFixedCostComponentKeys], [...fixedCostTrailerComponentFields].sort());
  assert.ok(Object.isFrozen(trailerFleetFixedCostComponentKeys));
  const request = (allocationScope: string, component?: string) => parseFixedCostComponentsRequest({
    allocationScope, dateFrom: '2025-12-01', dateTo: '2025-12-31', ...(component === undefined ? {} : { component }),
  });
  for (const component of fixedCostTrailerComponentFields) assert.equal(request('trailer', component).component, component);
  for (const component of truckOnlyKeys) assert.throws(() => request('trailer', component), component);
  for (const component of fixedCostComponentFields) assert.equal(request('truck', component).component, component);
  for (const component of ['user_fee', 'preparation', 'insurance_repair']) assert.throws(() => request('truck', component), component);
  assert.equal(request('trailer').component, undefined);
});

// --- results ------------------------------------------------------------------

test('single trailer component padangos: the BA question for one month, with the stored total and reconciliation', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    const response = await app.inject(componentsUrl('allocationScope=trailer&dateFrom=2025-03-01&dateTo=2025-03-31&component=padangos'));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();
    assert.deepEqual(data.components, [{ component: 'padangos', amount: '700.00' }]);
    assert.equal(data.authoritativeAmount, '1100.00');
    // componentTotal stays the all-component comparable sum; it is not the selected component.
    assert.equal(data.reconciliation.componentTotal, componentTotal);
    assert.equal(meta.componentFilter, 'padangos');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, periodValues);
    // No component text reaches SQL: the statement is the all-component fleet statement.
    assert.equal(calls[0].sql, fleetStatement());
  });
});

test('all 8 trailer components: database-ordered, with the stored total, reconciliation evidence and trailer meta', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();
    assert.deepEqual(Object.keys(data), [
      'allocationScope', 'periodMonth', 'currency', 'representation', 'components', 'authoritativeAmount',
      'totalTaskCount', 'lockedTaskCount', 'reconciliation',
    ]);
    assert.equal(data.components.length, 8);
    assert.deepEqual(data.components, defaultOrder.map(([component, amount]) => ({ component, amount })));
    assert.deepEqual([...data.components.map((entry: { component: string }) => entry.component)].sort(), [...fixedCostTrailerComponentFields].sort());
    assert.ok(data.allocationScope === 'trailer' && data.periodMonth === month && data.currency === 'EUR' && data.representation === 'locked');
    assert.equal(data.authoritativeAmount, '1100.00');
    assert.equal(data.totalTaskCount, 5);
    assert.equal(data.lockedTaskCount, 5);
    assert.deepEqual(data.reconciliation, {
      comparableTaskCount: 3, noDetailTaskCount: 2, multipleDetailTaskCount: 0,
      comparableAuthoritativeAmount: '1095.80', componentTotal, netDifference: '0.30', grossAbsoluteDifference: '0.50',
      affectedTaskCount: 2, componentsSumToComponentTotal: true,
    });
    assert.deepEqual(meta, {
      sourceFamily: 'trailer_fixed_costs',
      amountSemantics: 'explanatory_locked_component_sums_over_comparable_tasks_excluding_deleted',
      authoritativeSource: 'kastai_fiksuoti_ataskaita',
      componentSource: 'kastai_fiksuoti_priekabos_det_locked',
      componentKeys: [...fixedCostTrailerComponentFields].sort(),
      componentFilter: null,
      sorting: { sortBy: 'amount', sortDirection: 'desc', tieBreaker: { field: 'component', direction: 'asc' } },
      dateBasis: 'kastai_data',
      semanticsVersion: trailerFleetFixedCostComponentsSemanticsVersion,
      reconciliationStatus: 'provisional_unreconciled_erp_reference',
      complete: true,
      pilot: true,
      limitations: [...trailerFleetFixedCostComponentsLimitations],
    });
    // One fleet-wide locked trailer read, bound only by the month.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, periodValues);
    const { sql } = calls[0];
    assert.ok(sql.includes(fixedCostTrailerBreakdownSources.locked));
    assert.ok(!sql.includes(`${fixedCostTrailerBreakdownSources.current} `));
    assert.ok(!sql.includes(fixedCostBreakdownSources.locked) && !sql.includes(fixedCostBreakdownSources.current));
    assert.ok(sql.includes('locked_kastaiPriekabos') && !sql.includes('kastaiVilkiko'));
    // No trailer predicate, no master check and no attribution: the fleet summary population.
    assert.doesNotMatch(sql, /uzdavinio_priekaba|uzdavinio_masina|EXISTS|priekabos p/);
  });
});

test('every single trailer component returns the same decimal text the full list carries, with unchanged totals', async () => {
  for (const [component, amount] of defaultOrder) {
    await withApp(() => rankedRows(), async (app, calls) => {
      const response = await app.inject(componentsUrl(`${period}&component=${component}`));
      assert.equal(response.statusCode, 200, component);
      const { data, meta } = response.json();
      assert.deepEqual(data.components, [{ component, amount }]);
      assert.equal(data.authoritativeAmount, '1100.00');
      assert.equal(data.reconciliation.componentTotal, componentTotal);
      assert.equal(meta.componentFilter, component);
      assert.equal(calls[0].sql, fleetStatement());
      assert.deepEqual(calls[0].values, periodValues);
    });
  }
});

test('ordering is the database\'s: DECIMAL amount DESC then key ASC, and the driver order is kept exactly', async () => {
  const amount = `CASE k.component ${fixedCostTrailerComponentFields.map(field => `WHEN '${field}' THEN g.component_${field}`).join(' ')} END`;
  assert.ok(fleetStatement().endsWith(`ORDER BY g.deletedState, CAST(${amount} AS DECIMAL(65,6)) DESC, CAST(k.component AS BINARY) ASC`));

  // An order no JavaScript comparator would produce from these values: kept verbatim.
  const driverOrder: Ordered = [...defaultOrder].reverse();
  const { result } = await run(rankedRows(driverOrder));
  assert.deepEqual(result.data.components.map(entry => entry.component), driverOrder.map(([component]) => component));

  // Ties keep the database tie-break, and repeated requests are identical.
  const first = await run(rankedRows());
  const second = await run(rankedRows());
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.result.data.components.slice(1, 3), [{ component: 'amortizacija', amount: '200.00' }, { component: 'lizingas', amount: '200.00' }]);
  assert.equal(first.result.meta.sorting, truckFixedCostComponentsSorting);

  // No JavaScript money handling in the trailer components module; the only sort is the static key list.
  const source = readFileSync(new URL('../../src/fixed-costs/pilot-trailer-components.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /parseFloat|parseInt|Number\(|toFixed|Math\.|BigInt\(/);
  assert.equal(source.split('.sort(').length - 1, 1);
  assert.ok(source.includes('Object.freeze([...fixedCostTrailerComponentFields].sort())'));
});

test('zero, negative and beyond-float-precision amounts pass through as exact decimal text', async () => {
  const big = '98765432109876543.21';
  const order: Ordered = [['padangos', big], ...defaultOrder.filter(([field]) => field !== 'padangos')];
  const { result } = await run(rankedRows(order, { authoritativeTotal: '-1.05' }));
  assert.equal(result.data.components[0].amount, big);
  assert.deepEqual(result.data.components.at(-1), { component: 'insurance_repair', amount: '-4.50' });
  assert.equal(result.data.authoritativeAmount, '-1.05');
  assert.deepEqual((await run(rankedRows(), 'user_fee')).result.data.components, [{ component: 'user_fee', amount: '0.00' }]);
});

test('no included records, or only deleted = 1 records, is NO_DATA_FOR_PERIOD, never zero components', async () => {
  await assert.rejects(run([]), refusedWith('NO_DATA_FOR_PERIOD'));
  await assert.rejects(run(rankedRows(defaultOrder, { deletedState: 'one' })), refusedWith('NO_DATA_FOR_PERIOD'));
  await withApp(() => [], async app => {
    const response = await app.inject(componentsUrl(`${period}&component=padangos`));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'NO_DATA_FOR_PERIOD');
    assert.doesNotMatch(response.body, /0\.00/);
  });
});

test('deleted = 1 rows are excluded and cannot influence components or totals; undeclared states refuse', async () => {
  const deletedOrder: Ordered = defaultOrder.map(([field]) => [field, '999999.99']);
  const rows = [...rankedRows(), ...rankedRows(deletedOrder, { deletedState: 'one', authoritativeTotal: '777.77', records: 9, noDetail: 0 })];
  const { result } = await run(rows);
  assert.deepEqual(result.data.components, defaultOrder.map(([component, amount]) => ({ component, amount })));
  assert.equal(result.data.authoritativeAmount, '1100.00');
  assert.equal(result.data.totalTaskCount, 5);
  await assert.rejects(run([...rankedRows(), ...rankedRows(defaultOrder, { deletedState: 'other' })]), incompleteRead);
});

test('unlocked tasks refuse the month exactly as the trailer summary does', async () => {
  await assert.rejects(run(rankedRows(defaultOrder, { unlocked: 1 })), refusedWith('PERIOD_NOT_FULLY_LOCKED'));
  await withApp(() => rankedRows(defaultOrder, { unlocked: 2 }), async app => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'PERIOD_NOT_FULLY_LOCKED');
  });
});

// --- reconciliation -----------------------------------------------------------

test('authoritativeAmount is the fleet trailer summary amount for the same month; the component gap is reported, not closed', async () => {
  const respond = (sql: string) => sql === trailerFleetTotalsStatement ? [fleetTotalsRow()] : sql.includes('CROSS JOIN') ? rankedRows() : [];
  await withApp(respond, async app => {
    const summary = (await app.inject(`/expense-analytics/fixed-costs/summary?${period}`)).json();
    const components = (await app.inject(componentsUrl(`${period}&component=padangos`))).json();
    assert.equal(components.data.authoritativeAmount, summary.data.amount);
    assert.equal(components.data.totalTaskCount, summary.data.totalTaskCount);
    assert.equal(components.data.lockedTaskCount, summary.data.lockedTaskCount);
    // Stored total and component total differ; neither replaces the other and no residual component is invented.
    assert.notEqual(components.data.authoritativeAmount, components.data.reconciliation.componentTotal);
    assert.equal(components.data.reconciliation.noDetailTaskCount, 2);
    assert.equal(components.data.reconciliation.netDifference, '0.30');
    assert.equal(components.data.reconciliation.grossAbsoluteDifference, '0.50');
    assert.equal(components.data.reconciliation.affectedTaskCount, 2);
    const all = (await app.inject(componentsUrl(period))).json();
    assert.ok(!all.data.components.some((entry: { component: string }) => /residual|other|unattributed/i.test(entry.component)));
  });
});

test('the database proves the listed components add up to componentTotal; a failed proof is INCOMPLETE_RESULT', async () => {
  assert.ok(fleetStatement().includes(`WHEN CAST(g.componentTotal AS DECIMAL(65,6)) = ${fixedCostTrailerComponentFields
    .map(field => `CAST(g.component_${field} AS DECIMAL(65,6))`).join(' + ')} THEN 1`));
  await assert.rejects(run(rankedRows(defaultOrder, { reconcile: 0 })), refusedWith('INCOMPLETE_RESULT'));
});

test('no comparable task means no component amount exists: INCOMPLETE_RESULT, never zero-filled', async () => {
  await assert.rejects(run(rankedRows(defaultOrder, { noDetail: 5 })), refusedWith('INCOMPLETE_RESULT'));
});

test('malformed ranked reads are refused, never repaired', async () => {
  const rows = rankedRows();
  const cases: [string, unknown][] = [
    ['missing component row', rows.slice(1)],
    ['duplicate component', [...rows.slice(0, -1), { ...rows[0] }]],
    ['unknown component', rows.map((row, index) => index === 0 ? { ...row, component: 'tires' } : row)],
    ['truck-only component', rows.map((row, index) => index === 0 ? { ...row, component: truckOnlyKeys[0] } : row)],
    ['ranked amount differs from its component sum', rows.map((row, index) => index === 0 ? { ...row, componentAmount: '699.99' } : row)],
    ['numeric amount', rows.map((row, index) => index === 0 ? { ...row, componentAmount: 700 } : row)],
    ['rows disagree on the aggregate', rows.map((row, index) => index === 1 ? { ...row, authoritativeTotal: '1.00' } : row)],
    ['inconsistent reconcile flag', rows.map((row, index) => index === 1 ? { ...row, componentsReconcile: 0 } : row)],
    ['null driver row', [null, ...rows.slice(1)]],
    ['non-array result', { rows }],
  ];
  for (const [name, input] of cases) await assert.rejects(run(input), incompleteRead, name);
});

test('a truncated month never yields component amounts', async () => {
  await withApp(() => rankedRows(defaultOrder, { records: fixedCostMonetaryMaxRecords + 1 }), async app => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
});

// --- repository and projection guards ----------------------------------------

test('the fleet statement is the shared trailer statement without any trailer predicate, with only period bounds bound', () => {
  const query = trailerFleetComponentsQuery(month, now);
  assert.deepEqual(query, {
    allocationScope: 'trailer', representation: 'locked', periodMonth: month, periodEnd: '2025-04-01',
    limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  });
  const statement = fleetStatement();
  const single = fixedCostMonetaryStatement({ ...query, trailerId: 1 });
  // Identical to the single-trailer statement except for the bound trailer predicate and master check.
  assert.equal(
    fixedCostMonetaryStatement(query),
    single.replace('\n        AND t.uzdavinio_priekaba IN (?)\n        AND EXISTS (SELECT 1 FROM priekabos p WHERE p.id = t.uzdavinio_priekaba)', ''),
  );
  assert.ok(statement.includes(fixedCostMonetaryStatement(query)));
  assert.equal(statement.split('?').length - 1, 2);
  for (const field of fixedCostTrailerComponentFields) assert.ok(statement.includes(`SELECT '${field}'`), field);
  for (const field of truckOnlyKeys) assert.ok(!statement.includes(field), field);
  // Same population bound and order as the fleet summary statements.
  assert.ok(statement.includes(`ORDER BY a.uzdavinys\n        LIMIT ${fixedCostMonetaryMaxRecords + 1}`));
  // Period validation is the shared settled-month rule.
  for (const invalid of ['2026-09-01', '2025-03-15', '2025-3-01', undefined]) {
    assert.throws(() => trailerFleetComponentsQuery(invalid, now), InvalidFixedCostMonetaryQuery, String(invalid));
  }
});

test('the fleet ranked read runs the policy and period gates before any replica access', async () => {
  const { pool, calls } = fakePool(() => rankedRows());
  await assert.rejects(queryTrailerFleetRankedComponents(pool, new AnalyticsGate(1), month, undefined, now), FixedCostDeletedPolicyUnapproved);
  await assert.rejects(queryTrailerFleetRankedComponents(pool, new AnalyticsGate(1), '2099-01-01', trailerFixedCostPilotDeletedRowPolicy, now), InvalidFixedCostMonetaryQuery);
  assert.equal(calls.length, 0);
  const { totals } = await queryTrailerFleetRankedComponents(pool, new AnalyticsGate(1), month, trailerFixedCostPilotDeletedRowPolicy, now);
  assert.equal(totals.meta.trailerFilterApplied, false);
  assert.equal(totals.meta.truckFilterApplied, false);
  assert.equal(totals.meta.breakdownSource, fixedCostTrailerBreakdownSources.locked);
  assert.ok(totals.meta.limitations.some(entry => /fleet-wide trailer population/.test(entry)));
  assert.ok(!totals.meta.limitations.some(entry => /bound trailer identifier/.test(entry)));
});

test('mutation: truck, single-trailer, current and wrong-month reads are never projected as fleet trailer components', async () => {
  const { pool } = fakePool(() => rankedRows());
  const gate = new AnalyticsGate(1);
  const single = await queryFixedCostRankedComponents(pool, gate, {
    allocationScope: 'trailer', representation: 'locked', periodMonth: month, trailerId: 1, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, trailerFixedCostPilotDeletedRowPolicy, now);
  assert.equal(single.totals.meta.trailerFilterApplied, true);
  assert.throws(() => projectTrailerFleetFixedCostPilotComponents(single.totals, single.ranking, month), InvalidFixedCostMonetaryResult);
  const current = await queryFixedCostRankedComponents(pool, gate, {
    allocationScope: 'trailer', representation: 'current', periodMonth: month, trailerId: 1, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, trailerFixedCostPilotDeletedRowPolicy, now);
  assert.throws(() => trailerFleetComponentsIncludedGroup(current.totals, month), InvalidFixedCostMonetaryResult);
  const fleet = await queryTrailerFleetRankedComponents(pool, gate, month, trailerFixedCostPilotDeletedRowPolicy, now);
  assert.throws(() => projectTrailerFleetFixedCostPilotComponents(fleet.totals, fleet.ranking, '2025-02-01'), InvalidFixedCostMonetaryResult);

  const { pool: truckPool } = fakePool(() => rankedRows(fixedCostComponentFields.map(field => [field, '0.00'] as const)));
  const truck = await queryFixedCostRankedComponents(truckPool, gate, {
    allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, truckFixedCostPilotDeletedRowPolicy, now);
  assert.throws(() => projectTrailerFleetFixedCostPilotComponents(truck.totals, truck.ranking, month), InvalidFixedCostMonetaryResult);

  // And the reverse: a fleet trailer read is neither a single-trailer nor a truck result.
  assert.throws(() => trailerPilotIncludedGroup(fleet.totals, 'locked', month), InvalidFixedCostMonetaryResult);
  assert.throws(() => pilotIncludedGroup(fleet.totals, 'locked', month), InvalidFixedCostMonetaryResult);
});

// --- unchanged truck, trailer summary and trailer breakdown behaviour ----------

test('truck components are unchanged with both flags on: truck keys, truck SQL, truck meta', async () => {
  const truckOrder = fixedCostComponentFields.map(field => [field, field === 'padangos' ? '10.00' : '0.00'] as const);
  await withApp(sql => sql.includes('kastai_fiksuoti_vilkikai_det_locked') ? rankedRows(truckOrder) : [], async (app, calls) => {
    const response = await app.inject(componentsUrl(`${truckPeriod}&component=padangos`));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();
    assert.equal(data.allocationScope, 'truck');
    assert.deepEqual(data.components, [{ component: 'padangos', amount: '10.00' }]);
    assert.equal(meta.sourceFamily, 'truck_fixed_costs');
    assert.equal(meta.componentSource, fixedCostBreakdownSources.locked);
    assert.deepEqual(meta.componentKeys, [...fixedCostComponentFields].sort());
    assert.equal(calls[0].sql, fixedCostRankedComponentStatement(parseFixedCostMonetaryQuery({
      allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
    }, now)));
    // Trailer-only keys are still not truck keys.
    for (const key of ['user_fee', 'preparation', 'insurance_repair']) {
      assert.equal((await app.inject(componentsUrl(`${truckPeriod}&component=${key}`))).statusCode, 400, key);
    }
  }, bothConfig);
});

test('trailer summary and breakdown keep their statements and responses, and the shared query still has no fleet trailer form', async () => {
  assert.throws(() => parseFixedCostMonetaryQuery({ allocationScope: 'trailer', representation: 'locked', periodMonth: month }, now),
    InvalidFixedCostMonetaryQuery);
  const respond = (sql: string) => sql === trailerFleetTotalsStatement ? [fleetTotalsRow()]
    : sql === trailerFleetGroupsStatement ? [{ trailerId: 900000001, taskCount: 3, lockedAmount: '700.00' }, { trailerId: 900000002, taskCount: 1, lockedAmount: '405.00' }]
      : [];
  await withApp(respond, async (app, calls) => {
    const summary = await app.inject(`/expense-analytics/fixed-costs/summary?${period}`);
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().data.amount, '1100.00');
    assert.equal(summary.json().meta.semanticsVersion, 'trailer-fleet-fixed-cost-pilot-v1');
    const breakdown = await app.inject(`/expense-analytics/fixed-costs/breakdown?${period}`);
    assert.equal(breakdown.statusCode, 200);
    assert.equal(breakdown.json().data.groups.length, 2);
    // The fleet summary and breakdown never run the components statement.
    assert.ok(calls.every(call => !call.sql.includes('CROSS JOIN') && !call.sql.includes('_det_locked')));
  });
});

test('telemetry records outcome and counters only, never amounts, keys or months', async () => {
  const events: Record<string, unknown>[] = [];
  await withApp(() => rankedRows(), async app => {
    app.addHook('onRequest', async request => {
      const capture = (event: Record<string, unknown>, message: string) => { events.push({ ...event, message }); };
      request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
    });
    assert.equal((await app.inject(componentsUrl(`${period}&component=padangos`))).statusCode, 200);
  });
  const pilot = events.filter(event => event.operation === 'fixed_cost.trailer_fleet_components_pilot');
  assert.equal(pilot.length, 1);
  assert.ok(pilot[0].outcome === 'success' && pilot[0].component_count === 1 && pilot[0].total_task_count === 5);
  assert.equal(pilot[0].endpoint, '/expense-analytics/fixed-costs/components');
  assert.doesNotMatch(JSON.stringify(events), /700\.00|1100\.00|1095|padangos|2025-03|kastai|priekab|SELECT/);
});

test('limitations state the trailer, explanatory, comparable-only semantics and stay sorted', () => {
  for (const pattern of [/kastai_fiksuoti_priekabos_det_locked/, /locked_kastaiPriekabos/, /FC-06, FC-07/, /comparable tasks/,
    /never replace authoritativeAmount/, /ordered by the database in DECIMAL/, /deleted = 1 are excluded/, /FCB-05/, /no trailerId/]) {
    assert.ok(trailerFleetFixedCostComponentsLimitations.some(entry => pattern.test(entry)), String(pattern));
  }
  assert.deepEqual([...trailerFleetFixedCostComponentsLimitations], [...trailerFleetFixedCostComponentsLimitations].sort());
});

test('authentication is still required', async () => {
  const { pool, calls } = fakePool(() => rankedRows());
  const app = buildApp(trailerConfig, () => pool);
  try {
    assert.equal((await app.inject(componentsUrl(period))).statusCode, 401);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});
