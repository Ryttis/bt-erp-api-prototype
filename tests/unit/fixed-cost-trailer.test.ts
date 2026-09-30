import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { ConfigurationError, loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { fixedCostEndpoints, resolveFixedCostCapability } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes } from '../../src/fixed-costs/contracts.js';
import {
  InvalidFixedCostMonetaryQuery, InvalidFixedCostMonetaryResult, parseFixedCostMonetaryQuery,
} from '../../src/fixed-costs/monetary-contract.js';
import {
  fixedCostComponentFields, fixedCostMonetaryStatement, fixedCostTrailerComponentFields, queryFixedCostMonetaryTotals,
} from '../../src/fixed-costs/monetary-repository.js';
import { pilotIncludedGroup, truckFixedCostPilotDeletedRowPolicy } from '../../src/fixed-costs/pilot-summary.js';
import {
  trailerFixedCostPilotBreakdownLimitations, trailerFixedCostPilotDeletedRowPolicy, trailerFixedCostPilotSummaryLimitations,
  trailerPilotIncludedGroup,
} from '../../src/fixed-costs/pilot-trailer.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';

const baseEnvironment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
  ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};
const truckFlag = 'ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED';
const trailerFlag = 'ERP_FIXED_COST_TRAILER_PILOT_ENABLED';
const bothConfig = loadConfig({ ...baseEnvironment, [truckFlag]: 'true', [trailerFlag]: 'true' });
const trailerOnlyConfig = loadConfig({ ...baseEnvironment, [trailerFlag]: 'true' });
const truckOnlyConfig = loadConfig({ ...baseEnvironment, [truckFlag]: 'true' });
const auth = { authorization: `Bearer ${bothConfig.auth.serviceToken}` };
const now = new Date('2026-09-30T10:00:00Z');

// A synthetic identifier, distinctive enough to detect interpolation. Not a real trailer.
const trailerId = 987654321;
const period = 'dateFrom=2025-03-01&dateTo=2025-03-31';
const trailerQuery = `allocationScope=trailer&trailerId=${trailerId}&${period}`;
const truckQuery = `allocationScope=truck&truckId=12345&${period}`;
const summaryUrl = (query: string) => `/expense-analytics/fixed-costs/summary?${query}`;
const breakdownUrl = (query: string) => `/expense-analytics/fixed-costs/breakdown?${query}`;
const trailerFilterSql = 'AND t.uzdavinio_priekaba IN (?)';
const invalidQueryBody = { error: { code: 'INVALID_QUERY', message: 'Invalid fixed-cost query' } };

/** One driver row as the repository statement returns a declared-state group. */
function driverRow(options: {
  deletedState?: string; records?: number; unlocked?: number; unknown?: number; missingTotal?: number;
  authoritativeTotal?: unknown; componentTotal?: string; components?: Record<string, unknown>;
  fields?: readonly string[];
} = {}) {
  const records = options.records ?? 3;
  const missingTotal = options.missingTotal ?? 0;
  const comparable = records - missingTotal;
  const unlocked = options.unlocked ?? 0;
  const unknown = options.unknown ?? 0;
  return {
    deletedState: options.deletedState ?? 'zero',
    authoritativeRecords: records,
    authoritativeTotal: options.authoritativeTotal !== undefined ? options.authoritativeTotal : comparable > 0 ? '4321.10' : null,
    comparableRecords: comparable,
    comparableAuthoritativeTotal: comparable > 0 ? '4321.10' : null,
    componentTotal: comparable > 0 ? options.componentTotal ?? '4320.95' : null,
    netDifference: comparable > 0 ? '0.15' : null,
    grossAbsoluteDifference: comparable > 0 ? '0.15' : null,
    affectedRecords: comparable > 0 ? 1 : 0,
    ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`,
      name === 'exact' ? Math.max(comparable - 1, 0) : name === 'rounding' && comparable > 0 ? 1 : 0])),
    noDetailRecords: 0,
    multipleDetailRecords: 0,
    missingTotalRecords: missingTotal,
    missingTaskCount: 0,
    lockedRecords: records - unlocked - unknown,
    unlockedRecords: unlocked,
    unknownLockRecords: unknown,
    ...Object.fromEntries((options.fields ?? fixedCostTrailerComponentFields).map(field => [`component_${field}`, comparable === 0 ? null
      : options.components !== undefined ? options.components[field] ?? '0.00'
        : field === 'amortizacija' ? options.componentTotal ?? '4320.95' : '0.00'])),
  };
}

type Call = { sql: string; values: unknown[] };

function fakePool(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      const call = { sql, values };
      calls.push(call);
      await setImmediate();
      return respond(call);
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls };
}

async function withApp<T>(
  respond: (call: Call) => unknown,
  body: (app: ReturnType<typeof buildApp>, calls: Call[]) => Promise<T>,
  config = bothConfig,
  authenticate = false,
) {
  const { pool, calls } = fakePool(respond);
  const app = buildApp(config, () => pool, { authenticate });
  try { return await body(app, calls); } finally { await app.close(); }
}

/** Answers the current read and the locked read differently, keyed on the statement itself. */
const perRepresentation = (current: unknown, locked: unknown) => (call: Call) =>
  /a\.locked_kastaiPriekabos,/.test(call.sql) ? locked : current;

// --- 1. Truck behaviour is preserved exactly -----------------------------------

test('truck SQL is byte-identical to the statements captured before trailer support', () => {
  // SHA-256 of every truck statement variant, recorded from the pre-trailer repository.
  const expected: Record<string, string> = {
    'current fleet plain': 'b75e3e8db21d095003d17decc98fd0ce80576c20ea22c95453463470e6e43ab7',
    'current fleet components': '26e0e92d57fc37cf0b6c2ec7c27a91369b7c2aa03afb036c151ce63d59e06c11',
    'current one plain': '78180f1e07abb34a53d724b57417b67e0a0fafc8865edcac92ce0845f229b907',
    'current one components': 'd8beb5f75c508b7383d45da17b6f9e9e43529b40d5a2f2c02c5b77cb1cba99e6',
    'locked fleet plain': '8e3c6d86dfd1a7f7782fbb68aeb7923b19905ca5eff75cd8641627d6061031d5',
    'locked fleet components': '3abc5f2a9e6cdf1ebd72182c87d4352aefc778f3ad0a9ba7cbf8f4f982bdcb1e',
    'locked one plain': 'dc256ff1d6b4bbbab64f2a3d14104ddd629afb965dc6779bb3f7fa095e555410',
    'locked one components': '15b0067deb69fd64b1c30f0933883e5db758f388b1791722dc519c4d90e396af',
  };
  for (const representation of ['current', 'locked'] as const) {
    for (const truckIds of [undefined, [7]]) {
      for (const includeComponents of [undefined, true as const]) {
        const statement = fixedCostMonetaryStatement({
          allocationScope: 'truck', representation, periodMonth: '2025-03-01', periodEnd: '2025-04-01', limit: 50000,
          ...(truckIds ? { truckIds } : {}), ...(includeComponents ? { includeComponents } : {}),
        });
        const name = `${representation} ${truckIds ? 'one' : 'fleet'} ${includeComponents ? 'components' : 'plain'}`;
        assert.equal(createHash('sha256').update(statement).digest('hex'), expected[name], name);
        assert.doesNotMatch(statement, /priekab/i, name);
      }
    }
  }
});

test('truck summary and breakdown responses are unchanged with the trailer pilot enabled', async () => {
  const responses: Record<string, unknown>[] = [];
  for (const config of [truckOnlyConfig, bothConfig]) {
    await withApp(() => [driverRow({ fields: fixedCostComponentFields })], async (app, calls) => {
      const fleet = await app.inject(summaryUrl(`allocationScope=truck&${period}`));
      const single = await app.inject(summaryUrl(truckQuery));
      const breakdown = await app.inject(breakdownUrl(truckQuery));
      for (const response of [fleet, single, breakdown]) assert.equal(response.statusCode, 200);
      assert.deepEqual(calls.map(call => call.values), [
        ['2025-03-01', '2025-04-01'], ['2025-03-01', '2025-04-01', 12345],
        ['2025-03-01', '2025-04-01', 12345], ['2025-03-01', '2025-04-01', 12345],
      ]);
      for (const call of calls) assert.doesNotMatch(call.sql, /priekab/i, 'A truck request never reads a trailer source');
      responses.push({ fleet: fleet.json(), single: single.json(), breakdown: breakdown.json(), sql: calls.map(call => call.sql) });
    }, config);
  }
  assert.deepEqual(responses[1], responses[0]);
  const { fleet, single } = responses[0] as Record<string, { data: Record<string, unknown>; meta: Record<string, unknown> }>;
  assert.equal(fleet.data.allocationScope, 'truck');
  assert.equal(single.data.truckId, 12345);
  assert.equal(single.meta.sourceFamily, 'truck_fixed_costs');
  assert.equal(Object.hasOwn(single.data, 'trailerId'), false);
});

// --- Flag and capability -------------------------------------------------------

test('the trailer flag is false by default, strictly parsed, and independent of the truck flag', () => {
  assert.equal(loadConfig(baseEnvironment).fixedCosts.trailerPilotEnabled, false);
  assert.equal(truckOnlyConfig.fixedCosts.trailerPilotEnabled, false);
  assert.equal(trailerOnlyConfig.fixedCosts.trailerPilotEnabled, true);
  assert.equal(trailerOnlyConfig.fixedCosts.truckSummaryPilotEnabled, false);
  for (const value of ['1', 'TRUE', 'yes', ' true', '']) {
    assert.throws(() => loadConfig({ ...baseEnvironment, [trailerFlag]: value }), ConfigurationError, JSON.stringify(value));
  }
});

test('the resolver enables trailer only for its own strict flag, for one trailerId or fleet-wide', () => {
  const on = { truckSummaryPilotEnabled: false, trailerPilotEnabled: true };
  assert.deepEqual(resolveFixedCostCapability('summary', 'trailer', on, { trailerId: 1 }), { enabled: true, mode: 'trailer_summary_pilot' });
  assert.deepEqual(resolveFixedCostCapability('breakdown', 'trailer', on, { trailerId: 1 }), { enabled: true, mode: 'trailer_breakdown_pilot' });
  assert.deepEqual(resolveFixedCostCapability('dimensions', 'trailer', on, { trailerId: 1 }), { enabled: false });
  // Without a selector the read is fleet-wide; a truck selector never resolves a trailer read.
  assert.deepEqual(resolveFixedCostCapability('summary', 'trailer', on), { enabled: true, mode: 'trailer_fleet_summary_pilot' });
  assert.deepEqual(resolveFixedCostCapability('breakdown', 'trailer', on), { enabled: true, mode: 'trailer_fleet_breakdown_pilot' });
  assert.deepEqual(resolveFixedCostCapability('dimensions', 'trailer', on), { enabled: false });
  assert.deepEqual(resolveFixedCostCapability('summary', 'trailer', on, { truckId: 1 }), { enabled: false });
  assert.deepEqual(resolveFixedCostCapability('summary', 'trailer', on, { truckId: 1, trailerId: 1 }), { enabled: false });
  // The truck flag alone never enables trailer, and the trailer flag alone never enables truck.
  for (const endpoint of fixedCostEndpoints) {
    assert.equal(resolveFixedCostCapability(endpoint, 'trailer', { truckSummaryPilotEnabled: true }, { trailerId: 1 }).enabled, false);
    assert.equal(resolveFixedCostCapability(endpoint, 'trailer', { truckSummaryPilotEnabled: true, trailerPilotEnabled: 'true' as unknown as boolean }, { trailerId: 1 }).enabled, false);
    for (const scope of fixedCostAllocationScopes.filter(scope => scope !== 'trailer')) {
      assert.equal(resolveFixedCostCapability(endpoint, scope, on, { truckId: 1, trailerId: 1 }).enabled, false, `${endpoint}/${scope}`);
    }
  }
});

test('flag off: a valid trailer request is 422 SEMANTICS_UNVERIFIED with zero replica access', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    for (const url of [summaryUrl(trailerQuery), breakdownUrl(trailerQuery)]) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
    }
    assert.equal(calls.length, 0);
  }, truckOnlyConfig);
});

// --- 2, 4. One-trailer summary with a bound identifier ---------------------------

test('valid trailerId returns a one-trailer locked summary from the trailer columns', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    const response = await app.inject(summaryUrl(trailerQuery));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: {
        allocationScope: 'trailer', trailerId, periodMonth: '2025-03-01', amount: '4321.10', currency: 'EUR',
        representation: 'locked', totalTaskCount: 3, lockedTaskCount: 3,
      },
      meta: {
        sourceFamily: 'trailer_fixed_costs',
        amountSemantics: 'authoritative_locked_task_total_excluding_deleted',
        dateBasis: 'kastai_data',
        semanticsVersion: 'trailer-fixed-cost-summary-pilot-v1',
        reconciliationStatus: 'provisional_unreconciled_erp_reference',
        complete: true,
        pilot: true,
        limitations: [...trailerFixedCostPilotSummaryLimitations],
      },
    });
    const { limitations } = response.json().meta;
    assert.deepEqual(limitations, [...limitations].sort());
    assert.ok(!limitations.some((entry: string) => /not confirmed|has not confirmed that field|not ERP-confirmed/.test(entry) && /uzdavinio_priekaba/.test(entry)),
      'Attribution by uzdavinio_priekaba is no longer reported as unconfirmed');
    for (const pattern of [/business-confirmed trailer identity/, /FCB-05/, /provisional internal pilot/i, /deleted = 1 are excluded/, /FC-11/]) {
      assert.ok(limitations.some((entry: string) => pattern.test(entry)), String(pattern));
    }

    assert.equal(calls.length, 1, 'One locked read; the summary never reads current or components');
    const [{ sql }] = calls;
    assert.match(sql, /FROM kastai_fiksuoti_ataskaita a/, 'Same authoritative summary table');
    assert.match(sql, /a\.locked_kastaiPriekabos, a\.locked_kastaiPriekabos_data/);
    assert.match(sql, /kastai_fiksuoti_priekabos_det_locked/);
    assert.doesNotMatch(sql, /component_/);
    assert.doesNotMatch(sql, /Vilkiko|vilkikai|uzdavinio_masina|masinos|uzd_pr_vaziavo/, 'No truck source and no plate lookup');
  });
});

test('trailerId is a bound parameter on the task-trailer column and is never interpolated', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    await app.inject(summaryUrl(trailerQuery));
    await app.inject(breakdownUrl(trailerQuery));
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.deepEqual(call.values, ['2025-03-01', '2025-04-01', trailerId], 'trailerId is a bound number');
      assert.equal(call.sql.split(trailerFilterSql).length, 2, 'Exactly one trailer predicate');
      assert.equal(call.sql.split('?').length - 1, 3, 'Two period markers and one trailer marker');
      assert.ok(!call.sql.includes(String(trailerId)), 'trailerId is never interpolated');
    }
  });
  // The statement text does not depend on the identifier at all.
  const statement = (id: number) => fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(
    { allocationScope: 'trailer', representation: 'locked', periodMonth: '2025-03-01', trailerId: id, limit: 10 }, now));
  assert.equal(statement(1), statement(trailerId));
});

// --- 3. Invalid input -----------------------------------------------------------

test('invalid trailerId variants and plate numbers fail with 400 INVALID_QUERY before replica access', async () => {
  for (const config of [bothConfig, truckOnlyConfig]) {
    await withApp(() => [driverRow()], async (app, calls) => {
      for (const url of [summaryUrl, breakdownUrl]) {
        for (const value of ['', '0', '00', '-1', '+5', '05', '1.5', '1.0', '1e3', '0x10', 'abc', '%205', '5%20', '9007199254740992',
          '1%20OR%201=1', "1'%20OR%20'1'='1", '1;DROP%20TABLE%20priekabos', '1)--', 'AB123', 'null', 'true', '1,2']) {
          const response = await app.inject(url(`allocationScope=trailer&${period}&trailerId=${value}`));
          assert.equal(response.statusCode, 400, value);
          assert.deepEqual(response.json(), invalidQueryBody, value);
        }
        for (const extra of ['trailerId=2', 'trailerIds=1', 'trailerId[]=1', 'plateNumber=AB123', 'trailer=1', 'representation=current', 'groupBy=trailer']) {
          assert.equal((await app.inject(url(`${trailerQuery}&${extra}`))).statusCode, 400, extra);
        }
      }
      assert.equal((await app.inject(`/expense-analytics/fixed-costs/dimensions?${trailerQuery}`)).statusCode, 400, 'dimensions');
      // Dates are required by the pilot contract; with the flag off the capability gate answers first.
      assert.equal((await app.inject(summaryUrl(`allocationScope=trailer&trailerId=${trailerId}`))).statusCode,
        config === bothConfig ? 400 : 422, 'dates are required');
      assert.equal(calls.length, 0);
    }, config);
  }
});

// --- 5, 6, 7. Refusals and the deleted-row policy --------------------------------

test('no included records is NO_DATA_FOR_PERIOD, never a zero amount', async () => {
  for (const rows of [[], [driverRow({ deletedState: 'one' })], [driverRow({ records: 0 })]]) {
    await withApp(() => rows, async app => {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(trailerQuery));
        assert.equal(response.statusCode, 422);
        assert.equal(response.json().error.code, 'NO_DATA_FOR_PERIOD');
        assert.equal(Object.hasOwn(response.json(), 'data'), false);
      }
    });
  }
});

test('a real fully locked stored zero is reported as 0.00', async () => {
  await withApp(() => [driverRow({ authoritativeTotal: '0.00' })], async app => {
    const response = await app.inject(summaryUrl(trailerQuery));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.amount, '0.00');
  });
});

test('unlocked, unknown lock state, incomplete and malformed reads refuse exactly as the truck pilot does', async () => {
  const cases: [unknown, string][] = [
    [[driverRow({ unlocked: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[driverRow({ unknown: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[driverRow({ missingTotal: 1 })], 'INCOMPLETE_RESULT'],
    [[driverRow({ deletedState: 'other' })], 'INCOMPLETE_RESULT'],
    [[driverRow({ records: 50001 })], 'INCOMPLETE_RESULT'],
    [[driverRow({ authoritativeTotal: 4321.1 })], 'INCOMPLETE_RESULT'],
    [[null], 'INCOMPLETE_RESULT'],
    [null, 'INCOMPLETE_RESULT'],
  ];
  for (const [rows, code] of cases) {
    await withApp(() => rows, async app => {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(trailerQuery));
        assert.equal(response.statusCode, 422, code);
        assert.equal(response.json().error.code, code);
        assert.equal(Object.hasOwn(response.json(), 'data'), false);
      }
    });
  }
});

test('partial, multi-month and unsettled periods are refused before replica access', async () => {
  const current = new Date();
  const recentStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const recentEnd = new Date(Date.UTC(recentStart.getUTCFullYear(), recentStart.getUTCMonth() + 1, 0));
  const recent = `dateFrom=${recentStart.toISOString().slice(0, 10)}&dateTo=${recentEnd.toISOString().slice(0, 10)}`;
  await withApp(() => [driverRow()], async (app, calls) => {
    for (const [dates, code] of [
      ['dateFrom=2025-03-01&dateTo=2025-03-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['dateFrom=2025-03-02&dateTo=2025-03-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['dateFrom=2025-03-01&dateTo=2025-04-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      [recent, 'PERIOD_NOT_SETTLED'],
    ]) {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(`allocationScope=trailer&trailerId=${trailerId}&${dates}`));
        assert.equal(response.statusCode, 422, dates);
        assert.equal(response.json().error.code, code, dates);
      }
    }
    assert.equal(calls.length, 0);
  });
});

test('the deleted-row policy is the truck pilot policy: deleted = 1 never reaches the amount or counts', async () => {
  assert.equal(trailerFixedCostPilotDeletedRowPolicy, truckFixedCostPilotDeletedRowPolicy);
  const rows = [driverRow({ deletedState: 'one', records: 9, authoritativeTotal: '99999.99' }), driverRow({ records: 2, authoritativeTotal: '150.25' })];
  await withApp(() => rows, async (app, calls) => {
    const summary = (await app.inject(summaryUrl(trailerQuery))).json();
    assert.equal(summary.data.amount, '150.25');
    assert.equal(summary.data.totalTaskCount, 2);
    const breakdown = (await app.inject(breakdownUrl(trailerQuery))).json();
    assert.equal(breakdown.data.groups[0].lockedAmount, '150.25');
    assert.equal(breakdown.data.groups[0].taskCount, 2);
    assert.deepEqual(breakdown.meta.deletedRowPolicy, { ...truckFixedCostPilotDeletedRowPolicy });
    for (const call of calls) assert.match(call.sql, /CASE WHEN j\.deleted = 0 THEN 'zero' WHEN j\.deleted = 1 THEN 'one' ELSE 'other' END/);
  });
});

test('authentication, timeouts, busy and driver errors keep the truck pilot behaviour', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    assert.equal((await app.inject(summaryUrl(trailerQuery))).statusCode, 401);
    assert.equal((await app.inject({ url: summaryUrl(trailerQuery), headers: auth })).statusCode, 200);
    assert.equal(calls.length, 1);
  }, bothConfig, true);
  const failures: [Error, number, string][] = [
    [Object.assign(new Error('statement timeout'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }), 504, 'QUERY_TIMEOUT'],
    [Object.assign(new Error('connect ECONNREFUSED 10.0.0.1'), { code: 'ECONNREFUSED' }), 503, 'REPLICA_UNAVAILABLE'],
  ];
  for (const [failure, status, code] of failures) {
    await withApp(() => { throw failure; }, async app => {
      const response = await app.inject(breakdownUrl(trailerQuery));
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, code);
      assert.doesNotMatch(response.body, /ECONNREFUSED|10\.0\.0\.1|statement timeout|priekab/);
    });
  }
});

test('telemetry names the trailer operation and carries no amount, identifier or row', async () => {
  const events: Record<string, unknown>[] = [];
  await withApp(() => [driverRow({ authoritativeTotal: '7654.98' })], async app => {
    app.addHook('onRequest', async request => {
      const capture = (event: Record<string, unknown>) => { events.push(event); };
      request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
    });
    await app.inject(summaryUrl(trailerQuery));
    await app.inject(breakdownUrl(trailerQuery));
  });
  assert.deepEqual(events.map(event => [event.operation, event.outcome]),
    [['fixed_cost.trailer_summary_pilot', 'success'], ['fixed_cost.trailer_breakdown_pilot', 'success']]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`7654|${trailerId}|2025-03|priekab|kastai|SELECT`));
});

// --- 8, 9. Populations never cross ------------------------------------------------

test('a trailer request cannot return the truck population', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    // A truck selector on the trailer scope is refused outright, alone or combined.
    const truckSelector = await app.inject(summaryUrl(`allocationScope=trailer&truckId=12345&${period}`));
    assert.equal(truckSelector.statusCode, 422);
    assert.equal(truckSelector.json().error.code, 'SEMANTICS_UNVERIFIED');
    assert.equal((await app.inject(summaryUrl(`${trailerQuery}&truckId=12345`))).statusCode, 400);
    assert.equal(calls.length, 0);
  });
  // Internal query: the trailer scope requires its one identifier and rejects truck identifiers.
  const base = { allocationScope: 'trailer', representation: 'locked', periodMonth: '2025-03-01' };
  for (const extra of [{}, { truckIds: [1] }, { trailerId: 1, truckIds: [1] }, { trailerId: 0 }, { trailerId: '1' }, { trailerId: 1.5 }, { trailerId: [1] }]) {
    assert.throws(() => parseFixedCostMonetaryQuery({ ...base, ...extra }, now), InvalidFixedCostMonetaryQuery, JSON.stringify(extra));
  }
  // A truck-shaped repository result is never projected as a trailer amount.
  const { pool } = fakePool(() => [driverRow({ fields: fixedCostComponentFields })]);
  const gate = new AnalyticsGate(1, 1, 100);
  const truckResult = await queryFixedCostMonetaryTotals(pool, gate,
    { allocationScope: 'truck', representation: 'locked', periodMonth: '2025-03-01', truckIds: [trailerId] }, truckFixedCostPilotDeletedRowPolicy, now);
  assert.throws(() => trailerPilotIncludedGroup(truckResult, 'locked', '2025-03-01'), InvalidFixedCostMonetaryResult);
});

test('a truck request cannot return the trailer population', async () => {
  await withApp(() => [driverRow({ fields: fixedCostComponentFields })], async (app, calls) => {
    for (const url of [summaryUrl, breakdownUrl]) {
      assert.equal((await app.inject(url(`${truckQuery}&trailerId=${trailerId}`))).statusCode, 400);
      assert.equal((await app.inject(url(`allocationScope=truck&trailerId=${trailerId}&${period}`))).statusCode, 400);
    }
    assert.equal(calls.length, 0);
    // With only the trailer flag on, the truck scope stays disabled.
  });
  await withApp(() => [driverRow()], async (app, calls) => {
    const response = await app.inject(summaryUrl(truckQuery));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
    assert.equal(calls.length, 0);
  }, trailerOnlyConfig);
  assert.throws(() => parseFixedCostMonetaryQuery(
    { allocationScope: 'truck', representation: 'locked', periodMonth: '2025-03-01', trailerId: 1 }, now), InvalidFixedCostMonetaryQuery);
  // A trailer-shaped repository result is never projected as a truck amount.
  const { pool } = fakePool(() => [driverRow()]);
  const trailerResult = await queryFixedCostMonetaryTotals(pool, new AnalyticsGate(1, 1, 100),
    { allocationScope: 'trailer', representation: 'locked', periodMonth: '2025-03-01', trailerId }, truckFixedCostPilotDeletedRowPolicy, now);
  assert.equal(trailerResult.meta.allocationScope, 'trailer');
  assert.throws(() => pilotIncludedGroup(trailerResult, 'locked', '2025-03-01', trailerId), InvalidFixedCostMonetaryResult);
  assert.throws(() => pilotIncludedGroup(trailerResult, 'locked', '2025-03-01'), InvalidFixedCostMonetaryResult);
});

// --- 10. Breakdown -----------------------------------------------------------------

test('single-trailer breakdown: current and locked are read separately from their own trailer sources', async () => {
  const current = driverRow({ records: 2, authoritativeTotal: '910.00', componentTotal: '909.10', components: { amortizacija: '900.00', user_fee: '9.10' } });
  const locked = driverRow({ records: 2, authoritativeTotal: '905.25', componentTotal: '905.00', components: { lizingas: '905.00' } });
  await withApp(perRepresentation([current], [locked]), async (app, calls) => {
    const response = await app.inject(breakdownUrl(trailerQuery));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /a\.kastaiPriekabos, a\.locked_kastaiPriekabos_data/);
    assert.match(calls[0].sql, /FROM kastai_fiksuoti_priekabos_det d/);
    assert.doesNotMatch(calls[0].sql, /priekabos_det_locked/, 'The current read never touches the locked detail table');
    assert.match(calls[1].sql, /a\.locked_kastaiPriekabos, a\.locked_kastaiPriekabos_data/);
    assert.match(calls[1].sql, /FROM kastai_fiksuoti_priekabos_det_locked d/);
    assert.doesNotMatch(calls[1].sql, /priekabos_det d/, 'The locked read never touches the current detail table');
    for (const call of calls) {
      assert.doesNotMatch(call.sql, /Vilkiko|vilkikai|uzdavinio_masina/);
      for (const field of fixedCostTrailerComponentFields) assert.ok(call.sql.includes(`SUM(d.${field})`), field);
      assert.doesNotMatch(call.sql, /vairuotojuDU|general_administrative_expenses/, 'No truck-only component column');
    }

    assert.deepEqual(Object.keys(data), ['allocationScope', 'dateFrom', 'dateTo', 'currency', 'groups']);
    assert.equal(data.allocationScope, 'trailer');
    assert.equal(data.groups.length, 1, 'Exactly one trailer');
    const [group] = data.groups;
    assert.deepEqual(Object.keys(group), ['trailerId', 'currentAmount', 'lockedAmount', 'taskCount', 'lockStates', 'reconciliation']);
    assert.equal(group.trailerId, trailerId);
    assert.equal(group.currentAmount, '910.00', 'Stored current total, never a component sum');
    assert.equal(group.lockedAmount, '905.25', 'Stored locked total, never a component sum');
    assert.equal(group.taskCount, 2);
    assert.deepEqual(group.lockStates, { locked: 2, unlocked: 0, unknown: 0 });
    // The mismatch between component sums and stored totals is preserved, not fixed.
    assert.equal(group.reconciliation.current.componentTotal, '909.10');
    assert.equal(group.reconciliation.locked.componentTotal, '905.00');
    for (const representation of ['current', 'locked']) {
      assert.deepEqual(Object.keys(group.reconciliation[representation].components), [...fixedCostTrailerComponentFields], 'Raw ERP column names');
    }
    assert.equal(group.reconciliation.current.components.user_fee, '9.10');
    assert.equal(group.reconciliation.current.components.lizingas, '0.00');
    assert.equal(group.reconciliation.locked.components.lizingas, '905.00');

    assert.equal(meta.sourceFamily, 'fixed_cost_trailer_allocation');
    assert.equal(meta.authoritativeSource, 'kastai_fiksuoti_ataskaita');
    assert.deepEqual(meta.breakdownSources, { current: 'kastai_fiksuoti_priekabos_det', locked: 'kastai_fiksuoti_priekabos_det_locked' });
    assert.equal(meta.componentInventory.independentlyAdditive, false);
    assert.deepEqual(meta.componentInventory.fields, [...fixedCostTrailerComponentFields].sort());
    assert.deepEqual(meta.periodMonths, ['2025-03-01']);
    assert.equal(meta.complete, true);
    assert.deepEqual(meta.limitations, [...trailerFixedCostPilotBreakdownLimitations]);
  });
});

test('single-trailer breakdown: missing components, null-without-comparables and population drift are handled fail-closed', async () => {
  // Component columns absent from the driver row: never zero-filled.
  await withApp(() => [driverRow({ fields: [] })], async app => {
    const response = await app.inject(breakdownUrl(trailerQuery));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
  // Current and locked disagree on the task population.
  await withApp(perRepresentation([driverRow({ records: 2 })], [driverRow({ records: 3 })]), async app => {
    const response = await app.inject(breakdownUrl(trailerQuery));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
  // No comparable record: components stay null and the stored total is still reported.
  const noDetail = { ...driverRow({ records: 1, missingTotal: 1 }), authoritativeTotal: '12.00', missingTotalRecords: 0, noDetailRecords: 1 };
  await withApp(() => [noDetail], async app => {
    const response = await app.inject(breakdownUrl(trailerQuery));
    assert.equal(response.statusCode, 200);
    const [group] = response.json().data.groups;
    assert.equal(group.lockedAmount, '12.00');
    assert.equal(group.reconciliation.locked.components, null);
    assert.equal(group.reconciliation.locked.componentTotal, null);
    assert.equal(group.reconciliation.locked.status, 'structurally_non_comparable');
  });
});
