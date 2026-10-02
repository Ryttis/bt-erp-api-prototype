import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { resolveTruckComponentsCapability } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes } from '../../src/fixed-costs/contracts.js';
import {
  fixedCostBreakdownSources, fixedCostMonetaryMaxRecords, FixedCostDeletedPolicyUnapproved, InvalidFixedCostMonetaryQuery,
  InvalidFixedCostMonetaryResult, parseFixedCostMonetaryQuery,
} from '../../src/fixed-costs/monetary-contract.js';
import {
  fixedCostComponentFields, fixedCostMonetaryStatement, fixedCostRankedComponentStatement, fixedCostTrailerComponentFields,
  queryFixedCostRankedComponents,
} from '../../src/fixed-costs/monetary-repository.js';
import {
  parseTruckFixedCostComponentsRequest, projectTruckFixedCostPilotComponents, runTruckFixedCostPilotComponents,
  truckFixedCostComponentKeys, truckFixedCostComponentsLimitations, truckFixedCostComponentsSemanticsVersion,
  truckFixedCostComponentsSorting,
} from '../../src/fixed-costs/pilot-components.js';
import { truckFixedCostPilotDeletedRowPolicy, TruckFixedCostPilotRefused } from '../../src/fixed-costs/pilot-summary.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';

const baseEnvironment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
  ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};
const enabledConfig = loadConfig({ ...baseEnvironment, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'true' });
const disabledConfig = loadConfig(baseEnvironment);
const trailerOnlyConfig = loadConfig({ ...baseEnvironment, ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'true' });
const month = '2025-03-01';
const period = 'allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31';
const componentsUrl = (query: string) => `/expense-analytics/fixed-costs/components?${query}`;
const now = new Date('2026-09-23T10:00:00Z');

type Ordered = readonly (readonly [string, string | null])[];

/**
 * A database-ordered component list: two positives with a tie broken by key, every
 * other key at "0.00" in binary key order, and one negative last. The fake driver
 * cannot sort, so fixtures carry the order the statement's ORDER BY produces.
 */
const listed = ['padangos', 'amortizacija', 'remontas', 'kitiMokesciai'];
const defaultOrder: Ordered = [
  ['padangos', '500.00'], ['amortizacija', '300.00'], ['remontas', '300.00'],
  ...[...fixedCostComponentFields].filter(field => !listed.includes(field)).sort().map(field => [field, '0.00'] as const),
  ['kitiMokesciai', '-5.00'],
];

interface AggregateOptions {
  deletedState?: string;
  records?: number;
  unlocked?: number;
  noDetail?: number;
  authoritativeTotal?: string | null;
  componentTotal?: string;
}

/** One declared-state aggregate exactly as the inner monetary statement returns it. */
function aggregate(order: Ordered, options: AggregateOptions = {}) {
  const records = options.records ?? 4;
  const noDetail = options.noDetail ?? 1;
  const comparable = records - noDetail;
  const unlocked = options.unlocked ?? 0;
  return {
    deletedState: options.deletedState ?? 'zero',
    authoritativeRecords: records,
    authoritativeTotal: options.authoritativeTotal !== undefined ? options.authoritativeTotal : '1200.40',
    comparableRecords: comparable,
    comparableAuthoritativeTotal: comparable > 0 ? '1095.40' : null,
    componentTotal: comparable > 0 ? options.componentTotal ?? '1095.00' : null,
    netDifference: comparable > 0 ? '0.40' : null,
    grossAbsoluteDifference: comparable > 0 ? '0.60' : null,
    affectedRecords: comparable > 0 ? 2 : 0,
    ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`,
      name === 'exact' ? Math.max(comparable - 2, 0) : name === 'rounding' && comparable > 0 ? 2 : 0])),
    noDetailRecords: noDetail,
    multipleDetailRecords: 0,
    missingTotalRecords: 0,
    missingTaskCount: 0,
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

function fakePool(respond: (sql: string) => unknown) {
  const calls: { sql: string; values: unknown[] }[] = [];
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
  body: (app: ReturnType<typeof buildApp>, calls: { sql: string; values: unknown[] }[]) => Promise<T>,
  config = enabledConfig,
) {
  const { pool, calls } = fakePool(respond);
  const app = buildApp(config, () => pool, { authenticate: false });
  try { return await body(app, calls); } finally { await app.close(); }
}

async function run(rows: unknown, component?: string) {
  const { pool, calls } = fakePool(() => rows);
  const result = await runTruckFixedCostPilotComponents(pool, new AnalyticsGate(1), {
    allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31',
    ...(component === undefined ? {} : { component: component as never }),
  }, now);
  return { result, calls };
}

const refusedWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof TruckFixedCostPilotRefused, String(error));
  assert.equal(error.code, code);
  return true;
};

const incompleteRead = (error: unknown) =>
  error instanceof InvalidFixedCostMonetaryResult || (error instanceof TruckFixedCostPilotRefused && error.code === 'INCOMPLETE_RESULT');

// --- capability and request contract ------------------------------------------

test('components resolve only for the truck scope under the strict truck pilot flag', () => {
  for (const scope of fixedCostAllocationScopes) {
    assert.equal(resolveTruckComponentsCapability(scope, enabledConfig.fixedCosts), scope === 'truck', scope);
    assert.equal(resolveTruckComponentsCapability(scope, disabledConfig.fixedCosts), false, scope);
    assert.equal(resolveTruckComponentsCapability(scope, trailerOnlyConfig.fixedCosts), false, scope);
  }
});

test('flag off, trailer flag only, and every non-truck scope are 422 SEMANTICS_UNVERIFIED with zero replica access', async () => {
  for (const config of [disabledConfig, trailerOnlyConfig]) {
    await withApp(() => rankedRows(), async (app, calls) => {
      const response = await app.inject(componentsUrl(period));
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      assert.equal(calls.length, 0);
    }, config);
  }
  await withApp(() => rankedRows(), async (app, calls) => {
    for (const scope of fixedCostAllocationScopes.filter(scope => scope !== 'truck')) {
      const response = await app.inject(componentsUrl(period.replace('allocationScope=truck', `allocationScope=${scope}`)));
      assert.equal(response.statusCode, 422, scope);
      assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED', scope);
    }
    assert.equal(calls.length, 0);
  });
});

test('unknown scopes, unknown components and every grouping, sorting or selector parameter are 400 before replica access', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    for (const query of [
      'allocationScope=fleet&dateFrom=2025-03-01&dateTo=2025-03-31', 'allocationScope=TRUCK&dateFrom=2025-03-01&dateTo=2025-03-31',
      'allocationScope=truck', 'allocationScope=truck&dateFrom=2025-03-01', 'dateFrom=2025-03-01&dateTo=2025-03-31',
      `${period}&component=tires`, `${period}&component=PADANGOS`, `${period}&component=`, `${period}&component=padangos%20`,
      `${period}&component=padangos&component=remontas`, `${period}&component=padangos,remontas`,
      // Trailer-only component keys are not truck component keys.
      `${period}&component=user_fee`, `${period}&component=insurance_repair`,
      `${period}&groupBy=costComponent`, `${period}&sortBy=amount`, `${period}&sortDirection=asc`, `${period}&page=1`,
      `${period}&perPage=5`, `${period}&limit=3`, `${period}&truckId=1`, `${period}&trailerId=1`, `${period}&representation=current`,
      `${period}&measure=SUM(padangos)`, `${period}&component=padangos%3BDROP`, 'allocationScope=truck&dateFrom=2025-03-01&dateTo=2026-04-30',
      'allocationScope=truck&dateFrom=2025-03-31&dateTo=2025-03-01', 'allocationScope=truck&dateFrom=2025-02-30&dateTo=2025-03-31',
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
      ['allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-03-02&dateTo=2025-03-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-04-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-01-01&dateTo=2025-12-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2099-01-01&dateTo=2099-01-31', 'PERIOD_NOT_SETTLED'],
    ] as const) {
      const response = await app.inject(componentsUrl(query));
      assert.equal(response.statusCode, 422, query);
      assert.equal(response.json().error.code, code, query);
    }
    assert.equal(calls.length, 0);
  });
});

test('the request parser accepts exactly the verified truck component keys', () => {
  assert.deepEqual([...truckFixedCostComponentKeys], [...fixedCostComponentFields].sort());
  for (const component of fixedCostComponentFields) {
    assert.equal(parseTruckFixedCostComponentsRequest({ allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', component }).component, component);
  }
  assert.equal(parseTruckFixedCostComponentsRequest({ allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31' }).component, undefined);
  assert.ok(Object.isFrozen(truckFixedCostComponentKeys));
});

// --- results ------------------------------------------------------------------

test('known month: every component, database-ordered, with the stored total and reconciliation evidence', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();
    assert.deepEqual(Object.keys(data), [
      'allocationScope', 'periodMonth', 'currency', 'representation', 'components', 'authoritativeAmount',
      'totalTaskCount', 'lockedTaskCount', 'reconciliation',
    ]);
    assert.deepEqual(data.components, defaultOrder.map(([component, amount]) => ({ component, amount })));
    assert.equal(data.components.length, fixedCostComponentFields.length);
    assert.ok(data.allocationScope === 'truck' && data.periodMonth === month && data.currency === 'EUR' && data.representation === 'locked');
    assert.equal(data.authoritativeAmount, '1200.40');
    assert.equal(data.totalTaskCount, 4);
    assert.equal(data.lockedTaskCount, 4);
    assert.deepEqual(data.reconciliation, {
      comparableTaskCount: 3, noDetailTaskCount: 1, multipleDetailTaskCount: 0,
      comparableAuthoritativeAmount: '1095.40', componentTotal: '1095.00', netDifference: '0.40', grossAbsoluteDifference: '0.60',
      affectedTaskCount: 2, componentsSumToComponentTotal: true,
    });
    assert.deepEqual(meta, {
      sourceFamily: 'truck_fixed_costs',
      amountSemantics: 'explanatory_locked_component_sums_over_comparable_tasks_excluding_deleted',
      authoritativeSource: 'kastai_fiksuoti_ataskaita',
      componentSource: 'kastai_fiksuoti_vilkikai_det_locked',
      componentKeys: [...fixedCostComponentFields].sort(),
      componentFilter: null,
      sorting: { sortBy: 'amount', sortDirection: 'desc', tieBreaker: { field: 'component', direction: 'asc' } },
      dateBasis: 'kastai_data',
      semanticsVersion: truckFixedCostComponentsSemanticsVersion,
      reconciliationStatus: 'provisional_unreconciled_erp_reference',
      complete: true,
      pilot: true,
      limitations: [...truckFixedCostComponentsLimitations],
    });
    // One fleet-wide locked read, bound only by the month.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, ['2025-03-01', '2025-04-01']);
    assert.ok(calls[0].sql.includes(fixedCostBreakdownSources.locked) && !calls[0].sql.includes(`${fixedCostBreakdownSources.current} `));
    assert.ok(!calls[0].sql.includes('uzdavinio_masina IN'));
  });
});

test('one exact component returns the same decimal text the full list carries, with unchanged totals', async () => {
  for (const [component, amount] of defaultOrder) {
    await withApp(() => rankedRows(), async (app, calls) => {
      const response = await app.inject(componentsUrl(`${period}&component=${component}`));
      assert.equal(response.statusCode, 200, component);
      const { data, meta } = response.json();
      assert.deepEqual(data.components, [{ component, amount }]);
      assert.equal(data.authoritativeAmount, '1200.40');
      // componentTotal stays the all-component comparable sum; it is not the selected component.
      assert.equal(data.reconciliation.componentTotal, '1095.00');
      assert.equal(meta.componentFilter, component);
      // Same statement and bindings as the all-component read: no component text reaches SQL.
      assert.deepEqual(calls[0].values, ['2025-03-01', '2025-04-01']);
      assert.equal(calls[0].sql, fixedCostRankedComponentStatement(parseFixedCostMonetaryQuery({
        allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
      }, now)));
    });
  }
});

test('ordering is the database\'s: amount DESC then key ASC in SQL DECIMAL, and the driver order is kept exactly', async () => {
  const statement = fixedCostRankedComponentStatement(parseFixedCostMonetaryQuery({
    allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, now));
  const amount = `CASE k.component ${fixedCostComponentFields.map(field => `WHEN '${field}' THEN g.component_${field}`).join(' ')} END`;
  assert.ok(statement.endsWith(`ORDER BY g.deletedState, CAST(${amount} AS DECIMAL(65,6)) DESC, CAST(k.component AS BINARY) ASC`));

  // The fake driver returns an order no JavaScript comparator would produce from
  // these values. Keeping it proves nothing re-sorts money or keys in JavaScript.
  const driverOrder: Ordered = [...defaultOrder].reverse();
  const { result } = await run(rankedRows(driverOrder));
  assert.deepEqual(result.data.components.map(entry => entry.component), driverOrder.map(([component]) => component));

  // Ties stay in the database's tie-break order, and repeated requests are identical.
  const first = await run(rankedRows());
  const second = await run(rankedRows());
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.result.data.components.slice(1, 3), [{ component: 'amortizacija', amount: '300.00' }, { component: 'remontas', amount: '300.00' }]);
  assert.deepEqual(truckFixedCostComponentsSorting, { sortBy: 'amount', sortDirection: 'desc', tieBreaker: { field: 'component', direction: 'asc' } });
  assert.ok(Object.isFrozen(truckFixedCostComponentsSorting));
});

test('zero-valued components are listed and selectable as "0.00", never dropped or refused', async () => {
  const { result } = await run(rankedRows());
  const zeros = result.data.components.filter(entry => entry.amount === '0.00');
  assert.equal(zeros.length, fixedCostComponentFields.length - listed.length);
  const single = await run(rankedRows(), 'vairuotojoTelefonas');
  assert.deepEqual(single.result.data.components, [{ component: 'vairuotojoTelefonas', amount: '0.00' }]);
});

test('negative and beyond-float-precision amounts pass through as exact decimal text', async () => {
  const big = '98765432109876543.21';
  const order: Ordered = [['padangos', big], ...defaultOrder.filter(([field]) => field !== 'padangos')];
  const { result } = await run(rankedRows(order, { authoritativeTotal: '-1.05' }));
  assert.equal(result.data.components[0].amount, big);
  assert.deepEqual(result.data.components.at(-1), { component: 'kitiMokesciai', amount: '-5.00' });
  assert.equal(result.data.authoritativeAmount, '-1.05');
  const single = await run(rankedRows(), 'kitiMokesciai');
  assert.deepEqual(single.result.data.components, [{ component: 'kitiMokesciai', amount: '-5.00' }]);
});

test('no included records, or only deleted = 1 records, is NO_DATA_FOR_PERIOD, never zero components', async () => {
  await assert.rejects(run([]), refusedWith('NO_DATA_FOR_PERIOD'));
  await assert.rejects(run(rankedRows(defaultOrder, { deletedState: 'one' })), refusedWith('NO_DATA_FOR_PERIOD'));
  await withApp(() => [], async app => {
    const response = await app.inject(componentsUrl(`${period}&component=padangos`));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'NO_DATA_FOR_PERIOD');
  });
});

test('deleted = 1 rows are excluded and cannot influence components or totals', async () => {
  const deletedOrder: Ordered = defaultOrder.map(([field]) => [field, '999999.99']);
  const rows = [...rankedRows(), ...rankedRows(deletedOrder, { deletedState: 'one', authoritativeTotal: '777.77', records: 9, noDetail: 0 })];
  const { result } = await run(rows);
  assert.deepEqual(result.data.components, defaultOrder.map(([component, amount]) => ({ component, amount })));
  assert.equal(result.data.authoritativeAmount, '1200.40');
  assert.equal(result.data.totalTaskCount, 4);
  // An undeclared deleted state with records makes the included set unprovable.
  await assert.rejects(run([...rankedRows(), ...rankedRows(defaultOrder, { deletedState: 'other' })]), incompleteRead);
});

test('unlocked tasks refuse the month exactly as the summary does', async () => {
  await assert.rejects(run(rankedRows(defaultOrder, { unlocked: 1 })), refusedWith('PERIOD_NOT_FULLY_LOCKED'));
});

// --- reconciliation -----------------------------------------------------------

test('authoritativeAmount is the summary amount for the same read; the component gap is reported, not closed', async () => {
  // The summary statement has no CROSS JOIN; it reads the same aggregate columns.
  const respond = (sql: string) => sql.includes('CROSS JOIN') ? rankedRows() : [aggregate(defaultOrder)];
  await withApp(respond, async app => {
    const summary = (await app.inject(`/expense-analytics/fixed-costs/summary?${period}`)).json();
    const components = (await app.inject(componentsUrl(period))).json();
    assert.equal(components.data.authoritativeAmount, summary.data.amount);
    assert.equal(components.data.totalTaskCount, summary.data.totalTaskCount);
    assert.equal(components.data.lockedTaskCount, summary.data.lockedTaskCount);
    // Stored total and component total differ (no-detail task plus residual); neither replaces the other.
    assert.notEqual(components.data.authoritativeAmount, components.data.reconciliation.componentTotal);
    assert.equal(components.data.reconciliation.noDetailTaskCount, 1);
    assert.equal(components.data.reconciliation.netDifference, '0.40');
  });
});

test('the database proves the listed components add up to componentTotal; a failed proof is INCOMPLETE_RESULT', () => {
  const statement = fixedCostRankedComponentStatement(parseFixedCostMonetaryQuery({
    allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, now));
  assert.ok(statement.includes(`WHEN CAST(g.componentTotal AS DECIMAL(65,6)) = ${fixedCostComponentFields
    .map(field => `CAST(g.component_${field} AS DECIMAL(65,6))`).join(' + ')} THEN 1`));
  return assert.rejects(run(rankedRows(defaultOrder, { reconcile: 0 })), refusedWith('INCOMPLETE_RESULT'));
});

test('no comparable task means no component amount exists: INCOMPLETE_RESULT, never zero-filled', async () => {
  await assert.rejects(run(rankedRows(defaultOrder, { noDetail: 4 })), refusedWith('INCOMPLETE_RESULT'));
});

test('malformed ranked reads are refused, never repaired', async () => {
  const rows = rankedRows();
  const cases: [string, unknown][] = [
    ['missing component row', rows.slice(1)],
    ['duplicate component', [...rows.slice(0, -1), { ...rows[0] }]],
    ['unknown component', rows.map((row, index) => index === 0 ? { ...row, component: 'tires' } : row)],
    ['trailer component', rows.map((row, index) => index === 0 ? { ...row, component: fixedCostTrailerComponentFields[5] } : row)],
    ['ranked amount differs from its component sum', rows.map((row, index) => index === 0 ? { ...row, componentAmount: '499.99' } : row)],
    ['numeric amount', rows.map((row, index) => index === 0 ? { ...row, componentAmount: 500 } : row)],
    ['rows disagree on the aggregate', rows.map((row, index) => index === 1 ? { ...row, authoritativeTotal: '1.00' } : row)],
    ['inconsistent reconcile flag', rows.map((row, index) => index === 1 ? { ...row, componentsReconcile: 0 } : row)],
    ['reconcile flag out of range', rows.map(row => ({ ...row, componentsReconcile: 2 }))],
    ['null driver row', [null, ...rows.slice(1)]],
    ['non-array result', { rows }],
  ];
  for (const [name, input] of cases) {
    await assert.rejects(run(input), incompleteRead, name);
  }
  await withApp(() => rows.slice(1), async app => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
});

test('a truncated month never yields component amounts', async () => {
  const rows = rankedRows(defaultOrder, { records: fixedCostMonetaryMaxRecords + 1, noDetail: 1 });
  await withApp(() => rows, async app => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
});

// --- repository and projection guards ----------------------------------------

test('the ranked statement embeds the unchanged monetary statement and adds no bound values', () => {
  const query = parseFixedCostMonetaryQuery({
    allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, now);
  const statement = fixedCostRankedComponentStatement(query);
  assert.ok(statement.includes(fixedCostMonetaryStatement(query)));
  assert.equal(statement.split('?').length, fixedCostMonetaryStatement(query).split('?').length);
  for (const field of fixedCostComponentFields) assert.ok(statement.includes(`SELECT '${field}'`), field);
  for (const field of fixedCostTrailerComponentFields.filter(field => !(fixedCostComponentFields as readonly string[]).includes(field))) {
    assert.ok(!statement.includes(field), field);
  }
});

test('the ranked read runs the policy and component gates before any replica access', async () => {
  const { pool, calls } = fakePool(() => rankedRows());
  const input = { allocationScope: 'truck', representation: 'locked', periodMonth: month, limit: fixedCostMonetaryMaxRecords };
  await assert.rejects(queryFixedCostRankedComponents(pool, new AnalyticsGate(1), { ...input, includeComponents: true }, undefined, now), FixedCostDeletedPolicyUnapproved);
  await assert.rejects(queryFixedCostRankedComponents(pool, new AnalyticsGate(1), input, truckFixedCostPilotDeletedRowPolicy, now), InvalidFixedCostMonetaryQuery);
  assert.equal(calls.length, 0);
});

test('mutation: a current-representation or wrong-month read is refused by the projection', async () => {
  const { pool } = fakePool(() => rankedRows());
  const read = (representation: string, periodMonth = month) => queryFixedCostRankedComponents(pool, new AnalyticsGate(1), {
    allocationScope: 'truck', representation, periodMonth, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, truckFixedCostPilotDeletedRowPolicy, now);
  const current = await read('current');
  assert.throws(() => projectTruckFixedCostPilotComponents(current.totals, current.ranking, month), InvalidFixedCostMonetaryResult);
  const locked = await read('locked', '2025-02-01');
  assert.throws(() => projectTruckFixedCostPilotComponents(locked.totals, locked.ranking, month), InvalidFixedCostMonetaryResult);
});

test('limitations state the explanatory, comparable-only, raw-column semantics and stay sorted', () => {
  for (const pattern of [/exact ERP column names/, /FC-06, FC-07/, /comparable tasks/, /never replace authoritativeAmount/, /ordered by the database in DECIMAL/, /deleted = 1 are excluded/]) {
    assert.ok(truckFixedCostComponentsLimitations.some(entry => pattern.test(entry)), String(pattern));
  }
  assert.deepEqual([...truckFixedCostComponentsLimitations], [...truckFixedCostComponentsLimitations].sort());
});

test('telemetry records outcome and counters only, never amounts, keys or months; failures map like the summary', async () => {
  const events: Record<string, unknown>[] = [];
  await withApp(() => rankedRows(), async app => {
    app.addHook('onRequest', async request => {
      const capture = (event: Record<string, unknown>, message: string) => { events.push({ ...event, message }); };
      request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
    });
    assert.equal((await app.inject(componentsUrl(`${period}&component=padangos`))).statusCode, 200);
  });
  const pilot = events.filter(event => event.operation === 'fixed_cost.truck_components_pilot');
  assert.equal(pilot.length, 1);
  assert.ok(pilot[0].outcome === 'success' && pilot[0].component_count === 1 && pilot[0].total_task_count === 4);
  assert.equal(pilot[0].endpoint, '/expense-analytics/fixed-costs/components');
  assert.doesNotMatch(JSON.stringify(events), /500\.00|1200\.40|1095|padangos|2025-03|kastai|SELECT/);

  const timeout = Object.assign(new Error('statement timeout'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 });
  await withApp(() => { throw timeout; }, async app => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 504);
    assert.equal(response.json().error.code, 'QUERY_TIMEOUT');
  });
  await withApp(() => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }, async app => {
    const response = await app.inject(componentsUrl(period));
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /ECONNREFUSED/);
  });
});

test('authentication is still required', async () => {
  const { pool, calls } = fakePool(() => rankedRows());
  const app = buildApp(enabledConfig, () => pool);
  try {
    assert.equal((await app.inject(componentsUrl(period))).statusCode, 401);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('BA selected trucks: one bound SQL ranking over the selected IDs, not per-truck reduction', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    const response = await app.inject(componentsUrl(`${period}&truckIds=55,11,44,22,33`));
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.data.truckIds, [11, 22, 33, 44, 55]);
    assert.deepEqual(body.data.components, defaultOrder.map(([component, amount]) => ({ component, amount })));
    assert.equal(body.data.authoritativeAmount, '1200.40');
    assert.equal(body.data.reconciliation.noDetailTaskCount, 1);
    assert.ok(body.meta.limitations.some((entry: string) => entry.includes('is in truckIds')));
    assert.ok(!body.meta.limitations.some((entry: string) => entry.includes('remain in the included population')));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, ['2025-03-01', '2025-04-01', 11, 22, 33, 44, 55]);
    assert.match(calls[0].sql, /t\.uzdavinio_masina IN \(\?, \?, \?, \?, \?\)/);
    assert.match(calls[0].sql, /ORDER BY g.deletedState,.*DESC, CAST\(k.component AS BINARY\) ASC/s);
  });
});

test('selected truck selector fails closed before SQL, including on trailer scope', async () => {
  await withApp(() => rankedRows(), async (app, calls) => {
    for (const extra of ['truckIds=', 'truckIds=0', 'truckIds=01', 'truckIds=1,1', 'truckIds=1,-2', 'truckIds=1.5',
      'truckIds=9007199254740992', 'truckIds=1&truckIds=2', 'truckIds[]=1', 'truckIds=1%20OR%201=1',
      `truckIds=${Array.from({ length: 51 }, (_, i) => i + 1).join(',')}`, 'truckIds=1&truckId=1']) {
      assert.equal((await app.inject(componentsUrl(`${period}&${extra}`))).statusCode, 400, extra);
    }
    assert.equal((await app.inject(componentsUrl(`${period.replace('truck', 'trailer')}&truckIds=1`))).statusCode, 400);
    assert.equal(calls.length, 0);
  });
});

test('selected trucks retain monthly locking and completeness refusals', async () => {
  for (const [rows, code] of [
    [rankedRows(defaultOrder, { unlocked: 1 }), 'PERIOD_NOT_FULLY_LOCKED'],
    [rankedRows(defaultOrder, { noDetail: 4 }), 'INCOMPLETE_RESULT'],
    [[], 'NO_DATA_FOR_PERIOD'],
  ] as const) {
    await withApp(() => rows, async (app) => {
      const response = await app.inject(componentsUrl(`${period}&truckIds=11,22`));
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, code);
      assert.equal(response.json().data, undefined);
    });
  }
});

test('component projection cannot confuse selected trucks with the whole fleet', async () => {
  const { pool } = fakePool(() => rankedRows());
  const { totals, ranking } = await queryFixedCostRankedComponents(pool, new AnalyticsGate(1), {
    allocationScope: 'truck', representation: 'locked', periodMonth: month,
    limit: 50000, includeComponents: true, truckIds: [11, 22],
  }, truckFixedCostPilotDeletedRowPolicy, now);
  assert.throws(() => projectTruckFixedCostPilotComponents(totals, ranking, month), InvalidFixedCostMonetaryResult);
  assert.deepEqual(projectTruckFixedCostPilotComponents(totals, ranking, month, undefined, [11, 22]).data.truckIds, [11, 22]);
});
