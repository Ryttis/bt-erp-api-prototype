import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { ConfigurationError, loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import {
  fixedCostEndpoints, fixedCostSemanticCapabilities, resolveFixedCostCapability,
} from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes } from '../../src/fixed-costs/contracts.js';
import {
  fixedCostAuthoritativeSource, fixedCostBreakdownSources, fixedCostMonetaryLimitations, fixedCostMonetaryMaxRecords,
  fixedCostMonetaryPendingApprovals, InvalidFixedCostMonetaryResult,
  type FixedCostMonetaryGroup, type FixedCostMonetaryResult,
} from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostComponentFields, queryFixedCostMonetaryTotals } from '../../src/fixed-costs/monetary-repository.js';
import {
  projectTruckFixedCostPilotSummary, resolveTruckFixedCostPilotMonth, runTruckFixedCostPilotSummary,
  truckFixedCostPilotDeletedRowPolicy, truckFixedCostPilotLimitations, truckFixedCostPilotSemanticsVersion,
  truckFixedCostPilotSingleTruckLimitations,
  TruckFixedCostPilotRefused, type TruckFixedCostPilotSummaryResponse,
} from '../../src/fixed-costs/pilot-summary.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';

const baseEnvironment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
  ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};
const pilotFlag = 'ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED';
const enabledConfig = loadConfig({ ...baseEnvironment, [pilotFlag]: 'true' });
const disabledConfig = loadConfig(baseEnvironment);
const auth = { authorization: `Bearer ${enabledConfig.auth.serviceToken}` };
const month = '2025-03-01';
const validQuery = 'allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31';
const summaryUrl = (query: string) => `/expense-analytics/fixed-costs/summary?${query}`;
const now = new Date('2026-09-23T10:00:00Z');

/** One driver row exactly as the repository statement returns a declared-state group. */
function driverRow(options: {
  deletedState?: string;
  records?: number;
  locked?: number;
  unlocked?: number;
  unknown?: number;
  missingTotal?: number;
  authoritativeTotal?: unknown;
  componentTotal?: string;
} = {}) {
  const records = options.records ?? 3;
  const missingTotal = options.missingTotal ?? 0;
  const comparable = records - missingTotal;
  const unlocked = options.unlocked ?? 0;
  const unknown = options.unknown ?? 0;
  return {
    deletedState: options.deletedState ?? 'zero',
    authoritativeRecords: records,
    authoritativeTotal: options.authoritativeTotal !== undefined ? options.authoritativeTotal : comparable > 0 ? '1234567.10' : null,
    comparableRecords: comparable,
    comparableAuthoritativeTotal: comparable > 0 ? '1234567.10' : null,
    componentTotal: comparable > 0 ? options.componentTotal ?? '1234566.95' : null,
    netDifference: comparable > 0 ? '0.15' : null,
    grossAbsoluteDifference: comparable > 0 ? '0.15' : null,
    affectedRecords: comparable > 0 ? 1 : 0,
    ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`,
      name === 'exact' ? Math.max(comparable - 1, 0) : name === 'rounding' && comparable > 0 ? 1 : 0])),
    noDetailRecords: 0,
    multipleDetailRecords: 0,
    missingTotalRecords: missingTotal,
    missingTaskCount: 0,
    lockedRecords: options.locked ?? records - unlocked - unknown,
    unlockedRecords: unlocked,
    unknownLockRecords: unknown,
  };
}

function fakePool(respond: () => unknown) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      await setImmediate();
      return respond();
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls };
}

async function withApp<T>(
  respond: () => unknown,
  body: (app: ReturnType<typeof buildApp>, calls: { sql: string; values: unknown[] }[]) => Promise<T>,
  config = enabledConfig,
  authenticate = false,
) {
  const { pool, calls } = fakePool(respond);
  const app = buildApp(config, () => pool, { authenticate });
  try { return await body(app, calls); } finally { await app.close(); }
}

/** Repository-shaped result for projection-level and mutation tests. */
function lockedResult(groups: Partial<FixedCostMonetaryGroup>[] = [{}], meta: Partial<FixedCostMonetaryResult['meta']> = {}): FixedCostMonetaryResult {
  return {
    groups: groups.map(group => ({
      deletedState: 'zero', reconciliationStatus: 'unreconciled',
      authoritativeRecords: 3, authoritativeTotal: '1234567.10', comparableRecords: 3,
      comparableAuthoritativeTotal: '1234567.10', componentTotal: '1234566.95', netDifference: '0.15', grossAbsoluteDifference: '0.15',
      affectedRecords: 1, buckets: { exact: 2, rounding: 1, small: 0, moderate: 0, material: 0, large: 0 },
      noDetailRecords: 0, multipleDetailRecords: 0, missingTotalRecords: 0, missingTaskCount: 0,
      lockedRecords: 3, unlockedRecords: 0, unknownLockRecords: 0,
      ...group,
    })),
    meta: {
      allocationScope: 'truck', representation: 'locked', periodMonth: month, dateBasis: 'kastai_data', currency: 'EUR',
      authoritativeSource: fixedCostAuthoritativeSource, breakdownSource: fixedCostBreakdownSources.locked,
      componentFields: [], classificationApplied: false, classificationVersion: null, semanticsVersion: null,
      recordLimit: fixedCostMonetaryMaxRecords, recordsRead: 3, missingTaskCount: 0, truckFilterApplied: false,
      truncated: false, complete: true, deletedRowPolicy: truckFixedCostPilotDeletedRowPolicy,
      reconciliationStatus: 'unreconciled', pendingApprovals: fixedCostMonetaryPendingApprovals,
      limitations: fixedCostMonetaryLimitations,
      ...meta,
    },
  };
}

const refusedWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof TruckFixedCostPilotRefused, String(error));
  assert.equal(error.code, code);
  return true;
};

const requiredLimitations = [
  /provisional internal pilot/i,
  /deleted = 1 are excluded under a temporary MP-8 pilot policy/,
  /not reconciled against an accepted official ERP report/i,
  /exactly one settled complete calendar month/,
];

const expectedSuccess = {
  data: {
    allocationScope: 'truck', periodMonth: month, amount: '1234567.10', currency: 'EUR', representation: 'locked',
    totalTaskCount: 3, lockedTaskCount: 3,
  },
  meta: {
    sourceFamily: 'truck_fixed_costs',
    amountSemantics: 'authoritative_locked_task_total_excluding_deleted',
    dateBasis: 'kastai_data',
    semanticsVersion: 'truck-fixed-cost-summary-pilot-v1',
    reconciliationStatus: 'provisional_unreconciled_erp_reference',
    complete: true,
    pilot: true,
    limitations: [...truckFixedCostPilotLimitations],
  },
};

const monthOffset = (offset: number) => {
  const current = new Date();
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return `allocationScope=truck&dateFrom=${start.toISOString().slice(0, 10)}&dateTo=${end.toISOString().slice(0, 10)}`;
};

// --- 1, 2: feature flag -------------------------------------------------------

test('the pilot flag is false by default, strictly parsed, and invalid values fail configuration', () => {
  assert.equal(disabledConfig.fixedCosts.truckSummaryPilotEnabled, false);
  assert.equal(loadConfig({ ...baseEnvironment, [pilotFlag]: 'false' }).fixedCosts.truckSummaryPilotEnabled, false);
  assert.equal(enabledConfig.fixedCosts.truckSummaryPilotEnabled, true);
  for (const value of ['TRUE', 'True', '1', '0', 'yes', 'on', '', ' true', 'true ', 'enabled']) {
    assert.throws(() => loadConfig({ ...baseEnvironment, [pilotFlag]: value }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.message, `${pilotFlag} must be true or false`);
      return true;
    }, JSON.stringify(value));
  }
});

test('flag off: the exact pilot request returns 422 SEMANTICS_UNVERIFIED with zero replica access', async () => {
  for (const config of [disabledConfig, loadConfig({ ...baseEnvironment, [pilotFlag]: 'false' })]) {
    await withApp(() => [driverRow()], async (app, calls) => {
      let gateRuns = 0;
      const run = app.analyticsGate.run.bind(app.analyticsGate);
      app.analyticsGate.run = (operation => { gateRuns++; return run(operation); }) as typeof app.analyticsGate.run;
      const response = await app.inject({ url: summaryUrl(validQuery), headers: auth });
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), {
        error: {
          code: 'SEMANTICS_UNVERIFIED',
          message: 'The requested fixed-cost allocation scope has not passed source, amount, currency, date, lock/status, and reconciliation validation.',
        },
      });
      // Pilot period rules are not evaluated either: disabled behaviour is unchanged.
      assert.equal((await app.inject({ url: summaryUrl(monthOffset(0)), headers: auth })).json().error.code, 'SEMANTICS_UNVERIFIED');
      assert.equal(calls.length, 0);
      assert.equal(gateRuns, 0, 'The analytics gate is never entered');
    }, config, true);
  }
});

test('the capability resolver enables only the truck summary and only for a strict true flag', () => {
  for (const endpoint of fixedCostEndpoints) {
    for (const scope of fixedCostAllocationScopes) {
      const on = resolveFixedCostCapability(endpoint, scope, { truckSummaryPilotEnabled: true });
      assert.equal(on.enabled, endpoint === 'summary' && scope === 'truck', `${endpoint}/${scope}`);
      assert.equal(resolveFixedCostCapability(endpoint, scope, { truckSummaryPilotEnabled: false }).enabled, false);
      // A truthy non-boolean cannot open the gate.
      assert.equal(resolveFixedCostCapability(endpoint, scope, { truckSummaryPilotEnabled: 'true' as unknown as boolean }).enabled, false);
    }
  }
  // The static registry stays disabled and cannot be mutated per request.
  assert.ok(Object.isFrozen(fixedCostSemanticCapabilities) && Object.isFrozen(fixedCostSemanticCapabilities.truck));
  assert.throws(() => { (fixedCostSemanticCapabilities.truck as { enabled: boolean }).enabled = true; }, TypeError);
  assert.ok(Object.values(fixedCostSemanticCapabilities).every(entry => entry.enabled === false));
});

// --- 3, 4, 12, 18, 19, 20, 21: success ---------------------------------------

test('flag on: a settled full month returns the locked total with pilot metadata', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    const response = await app.inject({ url: summaryUrl(validQuery), headers: auth });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), expectedSuccess);
    assert.equal(response.headers['cache-control'], 'no-store', 'The pilot response is never cacheable');
    assert.deepEqual(Object.keys(response.json().data), Object.keys(expectedSuccess.data), 'Deterministic key order');
    assert.equal(calls.length, 1, 'Exactly one read');
    // Only the locked representation is read, with bound month values only.
    assert.deepEqual(calls[0].values, ['2025-03-01', '2025-04-01']);
    assert.match(calls[0].sql, /a\.locked_kastaiVilkiko,/);
    assert.doesNotMatch(calls[0].sql, /\ba\.kastaiVilkiko\b/, 'The current amount column is never read');
    assert.ok(calls[0].sql.includes(`LIMIT ${fixedCostMonetaryMaxRecords + 1}`), 'Hard bound plus truncation sentinel');
    assert.doesNotMatch(calls[0].sql, /infot_2\./, 'Unqualified identifiers');
  });
});

test('authentication is still required when the pilot is enabled', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token-that-is-longer-than-thirty-two-chars' }]) {
      const response = await app.inject({ url: summaryUrl(validQuery), headers });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'UNAUTHORIZED');
    }
    assert.equal(calls.length, 0);
    assert.equal((await app.inject({ url: summaryUrl(validQuery), headers: auth })).statusCode, 200);
  }, enabledConfig, true);
});

test('canonical decimal strings survive exactly, including values beyond float precision', async () => {
  for (const amount of ['1234567.10', '-12.50', '0.00', '90071992547409.93', '123456789012345678.99']) {
    await withApp(() => [driverRow({ authoritativeTotal: amount })], async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 200, amount);
      assert.equal(response.json().data.amount, amount);
      assert.ok(response.body.includes(`"amount":"${amount}"`), 'Serialized as text, never as a JSON number');
    });
  }
  // A numeric or non-canonical driver value is refused rather than coerced.
  for (const amount of [1234567.1, '1.2e6', '1234567', ' 1.00', 'NaN']) {
    await withApp(() => [driverRow({ authoritativeTotal: amount })], async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 422, String(amount));
      assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
    });
  }
});

test('absence of included records is NO_DATA_FOR_PERIOD, never a zero amount', async () => {
  const noData = {
    error: {
      code: 'NO_DATA_FOR_PERIOD',
      message: 'No included fixed-cost records exist for the selected month; absence of records is not reported as a zero amount.',
    },
  };
  // No summary rows at all, and rows only in the excluded deleted = 1 population.
  for (const rows of [[], [driverRow({ deletedState: 'one', unlocked: 3, authoritativeTotal: '0.00' })], [driverRow({ deletedState: 'one', locked: 3 })]]) {
    await withApp(() => rows, async (app, calls) => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 422, JSON.stringify(rows));
      assert.deepEqual(response.json(), noData);
      assert.equal(response.headers['cache-control'], 'no-store');
      // No amount, count, metadata or diagnostic is claimed.
      assert.doesNotMatch(response.body, /"amount"|"data"|"meta"|0\.00|1234567|Count|diagnostic|SELECT|ER_/);
      assert.equal(calls.length, 1);
    });
  }
  // A missing group is never read as zero at projection level either.
  assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([]), month), refusedWith('NO_DATA_FOR_PERIOD'));
  assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([{ deletedState: 'one' }]), month), refusedWith('NO_DATA_FOR_PERIOD'));
  assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([{ authoritativeRecords: 0, lockedRecords: 0 }]), month), refusedWith('NO_DATA_FOR_PERIOD'));
});

test('real fully locked deleted = 0 records whose stored total is "0.00" are a legitimate zero', async () => {
  for (const records of [1, 4]) {
    const rows = [driverRow({ records, authoritativeTotal: '0.00' }), driverRow({ deletedState: 'one', unlocked: 2 })];
    await withApp(() => rows, async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 200, String(records));
      assert.deepEqual(response.json(), {
        ...expectedSuccess, data: { ...expectedSuccess.data, amount: '0.00', totalTaskCount: records, lockedTaskCount: records },
      });
    });
  }
  // A zero total is still refused when the included population is not fully locked.
  await withApp(() => [driverRow({ authoritativeTotal: '0.00', unlocked: 1 })], async app => {
    assert.equal((await app.inject(summaryUrl(validQuery))).json().error.code, 'PERIOD_NOT_FULLY_LOCKED');
  });
});

test('missing, null or malformed driver results are INCOMPLETE_RESULT, never zero or a 500', async () => {
  const malformed: unknown[] = [
    [null], [undefined], [driverRow(), null], ['row'], [42], [[]], null, undefined, 'rows', {}, [{}],
    [{ ...driverRow(), authoritativeTotal: null }],
    [{ ...driverRow({ missingTotal: 3 }) }],
  ];
  for (const rows of malformed) {
    await withApp(() => rows, async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 422, JSON.stringify(rows) ?? String(rows));
      assert.deepEqual(response.json(), {
        error: { code: 'INCOMPLETE_RESULT', message: 'The fixed-cost result could not be proven complete, so no amount is reported.' },
      });
      assert.doesNotMatch(response.body, /amount"|0\.00|TypeError|Cannot read|diagnostic/);
    });
  }
});

test('metadata, exact semanticsVersion and required limitations are always present and sorted', async () => {
  assert.equal(truckFixedCostPilotSemanticsVersion, 'truck-fixed-cost-summary-pilot-v1');
  for (const rows of [[driverRow()], [driverRow({ authoritativeTotal: '0.00' })]]) {
    await withApp(() => rows, async app => {
      const { meta } = (await app.inject(summaryUrl(validQuery))).json();
      assert.equal(meta.semanticsVersion, 'truck-fixed-cost-summary-pilot-v1');
      assert.equal(meta.pilot, true);
      assert.equal(meta.complete, true);
      assert.equal(meta.reconciliationStatus, 'provisional_unreconciled_erp_reference');
      for (const pattern of requiredLimitations) assert.ok(meta.limitations.some((entry: string) => pattern.test(entry)), String(pattern));
      assert.deepEqual(meta.limitations, [...meta.limitations].sort());
      assert.equal(new Set(meta.limitations).size, meta.limitations.length);
      assert.ok(!meta.limitations.some((entry: string) => /production-ready\.$/.test(entry) && !/not production-ready/.test(entry)));
    });
  }
});

// --- 5, 6, 7, 8, 9, 11: request validation before replica access -------------

test('partial months, multi-month ranges and unsettled months are refused before replica access', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    const cases: [string, number, string][] = [
      ['allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-30', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-03-02&dateTo=2025-03-31', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-01', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2024-02-01&dateTo=2024-02-28', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-04-30', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-01-01&dateTo=2025-12-31', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      ['allocationScope=truck&dateFrom=2025-02-15&dateTo=2025-03-14', 422, 'PERIOD_NOT_COMPLETE_MONTH'],
      [monthOffset(0), 422, 'PERIOD_NOT_SETTLED'],
      [monthOffset(-5), 422, 'PERIOD_NOT_SETTLED'],
      [monthOffset(3), 422, 'PERIOD_NOT_SETTLED'],
      ['allocationScope=truck&dateFrom=2025-03-31&dateTo=2025-03-01', 400, 'INVALID_QUERY'],
      ['allocationScope=truck&dateFrom=2025-02-01&dateTo=2025-02-29', 400, 'INVALID_QUERY'],
      ['allocationScope=truck&dateFrom=2025-3-01&dateTo=2025-03-31', 400, 'INVALID_QUERY'],
      ['allocationScope=truck&dateFrom=20250301&dateTo=20250331', 400, 'INVALID_QUERY'],
      ['allocationScope=truck&dateFrom=2025-03-01', 400, 'INVALID_QUERY'],
      ['allocationScope=truck', 400, 'INVALID_QUERY'],
    ];
    for (const [query, status, code] of cases) {
      const response = await app.inject(summaryUrl(query));
      assert.equal(response.statusCode, status, query);
      assert.equal(response.json().error.code, code, query);
    }
    assert.equal(calls.length, 0, 'No replica access for any refused period');
    // Boundaries: February in a leap year and the oldest-allowed settled month succeed.
    for (const query of ['allocationScope=truck&dateFrom=2024-02-01&dateTo=2024-02-29', monthOffset(-6)]) {
      assert.equal((await app.inject(summaryUrl(query))).statusCode, 200, query);
    }
  });
});

test('the period resolver is exact and settlement reuses the six-month rule', () => {
  const request = (dateFrom: string, dateTo: string) => ({ allocationScope: 'truck', dateFrom, dateTo }) as const;
  assert.equal(resolveTruckFixedCostPilotMonth(request('2025-03-01', '2025-03-31'), now), month);
  assert.equal(resolveTruckFixedCostPilotMonth(request('2026-03-01', '2026-03-31'), now), '2026-03-01');
  assert.throws(() => resolveTruckFixedCostPilotMonth(request('2026-04-01', '2026-04-30'), now), refusedWith('PERIOD_NOT_SETTLED'));
  assert.throws(() => resolveTruckFixedCostPilotMonth(request('2025-04-01', '2025-04-31'), now), refusedWith('PERIOD_NOT_COMPLETE_MONTH'));
  assert.throws(() => resolveTruckFixedCostPilotMonth(request('2025-12-01', '2026-01-31'), now), refusedWith('PERIOD_NOT_COMPLETE_MONTH'));
});

test('unsupported, repeated, SQL-shaped and policy-controlling parameters fail before replica access', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    const extras = [
      'representation=current', 'representation=locked', 'deleted=1', 'deleted=0', 'deletedPolicy=include_all',
      'includeDeleted=true', 'policy=exclude_deleted', 'tolerance=1.00', 'fields=amount', 'measures=currentAmount',
      'groupBy=truck', 'sortBy=amount', 'sortDirection=desc', 'page=1', 'per_page=10', 'limit=5', 'recordLimit=50000',
      'table=kastai_fiksuoti_ataskaita', 'column=kastaiVilkiko', 'schema=infot_2', 'truckIds=1',
      'pilot=true', `${pilotFlag}=true`, 'currency=USD', 'allocationScope=trailer', 'dateFrom=2025-04-01',
    ];
    for (const extra of extras) {
      const response = await app.inject(summaryUrl(`${validQuery}&${extra}`));
      assert.equal(response.statusCode, 400, extra);
      assert.equal(response.json().error.code, 'INVALID_QUERY', extra);
    }
    for (const query of [
      "allocationScope=truck&dateFrom=2025-03-01'%20OR%201=1--&dateTo=2025-03-31",
      'allocationScope=truck;DROP%20TABLE%20x&dateFrom=2025-03-01&dateTo=2025-03-31',
      'allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31%20UNION%20SELECT%201',
    ]) {
      assert.equal((await app.inject(summaryUrl(query))).statusCode, 400, query);
    }
    assert.equal(calls.length, 0);
  });
});

// --- 10, 13, 14, 15, 16, 17: population rules --------------------------------

test('the deleted = 1 group is excluded and cannot influence the amount or counts', async () => {
  const rows = [driverRow(), driverRow({ deletedState: 'one', records: 7, unlocked: 7, authoritativeTotal: '999.99' })];
  await withApp(() => rows, async app => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, expectedSuccess.data);
    assert.doesNotMatch(response.body, /999\.99/);
  });
  // An undeclared deleted value makes the included population unprovable.
  await withApp(() => [driverRow(), driverRow({ deletedState: 'other', records: 1 })], async app => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
});

test('the pilot policy is a frozen internal constant, not request input', async () => {
  assert.ok(Object.isFrozen(truckFixedCostPilotDeletedRowPolicy));
  assert.equal(truckFixedCostPilotDeletedRowPolicy.treatment, 'exclude_deleted');
  assert.match(truckFixedCostPilotDeletedRowPolicy.approvedBy!, /temporary pilot policy \(not Finance approval\)/);
  // The runner takes no policy parameter at all.
  assert.equal(runTruckFixedCostPilotSummary.length, 3, 'pool, gate, request; now is optional');
});

test('the locked amount is the answer; a current-representation result is refused', () => {
  const projected = projectTruckFixedCostPilotSummary(lockedResult(), month);
  assert.equal(projected.data.amount, '1234567.10');
  assert.equal(projected.data.representation, 'locked');
  assert.ok(!('currentAmount' in projected.data) && !('lockedAmount' in projected.data));
  assert.throws(
    () => projectTruckFixedCostPilotSummary(lockedResult([{}], { representation: 'current', breakdownSource: fixedCostBreakdownSources.current }), month),
    InvalidFixedCostMonetaryResult,
  );
  for (const meta of [{ periodMonth: '2025-04-01' }, { truckFilterApplied: true }, { dateBasis: 'lock_date' as 'kastai_data' }]) {
    assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([{}], meta), month), InvalidFixedCostMonetaryResult);
  }
});

test('the stored total is reported even when the component sum differs; a missing total is refused', async () => {
  const projected = projectTruckFixedCostPilotSummary(lockedResult([{ componentTotal: '1.00' }]), month);
  assert.equal(projected.data.amount, '1234567.10');
  assert.doesNotMatch(JSON.stringify(projected), /componentTotal|1234566\.95/);
  // A null stored total would silently drop from SUM, even with components present.
  await withApp(() => [driverRow({ missingTotal: 1 })], async app => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
});

test('every included task must be locked; unlocked or unknown lock state refuses the month', async () => {
  for (const options of [{ unlocked: 1 }, { unknown: 1 }, { unlocked: 3 }, { unlocked: 1, unknown: 1 }]) {
    await withApp(() => [driverRow(options)], async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 422, JSON.stringify(options));
      assert.deepEqual(response.json(), {
        error: {
          code: 'PERIOD_NOT_FULLY_LOCKED',
          message: 'The selected month contains included tasks that are not locked, so no authoritative locked total can be reported.',
        },
      });
      assert.doesNotMatch(response.body, /1234567/);
    });
  }
  // Unlocked deleted = 1 rows are excluded, so they do not block the month.
  await withApp(() => [driverRow(), driverRow({ deletedState: 'one', unlocked: 3 })], async app => {
    assert.equal((await app.inject(summaryUrl(validQuery))).statusCode, 200);
  });
});

test('truncated, incomplete or inconsistent results never become an amount', async () => {
  // Truncation sentinel: one record beyond the hard bound.
  await withApp(() => [driverRow({ records: fixedCostMonetaryMaxRecords + 1 })], async app => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
  });
  // Lock states that do not cover the population, duplicate groups, junk driver output.
  for (const rows of [
    [{ ...driverRow(), lockedRecords: 1 }],
    [driverRow(), driverRow()],
    'not rows',
    [{ ...driverRow(), deletedState: 'maybe' }],
  ]) {
    await withApp(() => rows, async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 422, JSON.stringify(rows));
      assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
    });
  }
  for (const meta of [{ complete: false }, { truncated: true as false }]) {
    assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([{}], meta), month), refusedWith('INCOMPLETE_RESULT'));
  }
});

// --- 22, 23: timeout, busy, unavailable ---------------------------------------

test('timeout stays 504, gate saturation stays 503 SERVICE_BUSY, driver errors are sanitized', async () => {
  const secret = Object.assign(new Error('SELECT locked_kastaiVilkiko FROM kastai_fiksuoti_ataskaita WHERE uzdavinys=810000001'), {
    code: 'ER_STATEMENT_TIMEOUT', sql: 'SELECT private', parameters: ['2025-03-01'],
  });
  await withApp(() => { throw secret; }, async app => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.json(), { error: { code: 'QUERY_TIMEOUT', message: 'Fixed-cost query timed out' } });
  });
  await withApp(() => { throw Object.assign(new Error('connect ECONNREFUSED private-host:3306'), { code: 'ECONNREFUSED' }); }, async app => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Fixed-cost data temporarily unavailable' } });
    assert.doesNotMatch(response.body, /private|ECONNREFUSED|SELECT/);
  });

  // Connection acquisition failed before any statement ran: unavailable, not a query timeout.
  const acquisition = Object.assign(new Error('pool timeout private-host'), {
    code: 'ER_GET_CONNECTION_TIMEOUT', errno: 45028,
    cause: Object.assign(new Error('connect timeout private-host'), { code: 'ER_CONNECTION_TIMEOUT', errno: 45012, fatal: true }),
  });
  for (const failure of [acquisition, acquisition.cause]) {
    await withApp(() => { throw failure; }, async app => {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Fixed-cost data temporarily unavailable' } });
    });
  }

  const busyConfig = loadConfig({
    ...baseEnvironment, [pilotFlag]: 'true',
    ERP_ANALYTICS_CONCURRENCY: '1', ERP_ANALYTICS_QUEUE_LIMIT: '1', ERP_ANALYTICS_QUEUE_TIMEOUT_MS: '1',
  });
  await withApp(() => [driverRow()], async (app, calls) => {
    let release!: () => void;
    const held = app.analyticsGate.run(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const response = await app.inject(summaryUrl(validQuery));
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: 'SERVICE_BUSY', message: 'Analytical service is busy' } });
      assert.equal(calls.length, 0);
    } finally { release(); await held; }
  }, busyConfig);
});

test('pilot telemetry records duration and outcome without amounts, identifiers or rows', async () => {
  const events: Record<string, unknown>[] = [];
  const cases = [[[driverRow({ authoritativeTotal: '7654321.98' })], 'success'], [[driverRow({ unlocked: 1 })], 'refused']] as const;
  for (const [rows, outcome] of cases) {
    await withApp(() => rows, async app => {
      app.addHook('onRequest', async request => {
        const capture = (event: Record<string, unknown>, message: string) => { events.push({ ...event, message }); };
        request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
      });
      await app.inject(summaryUrl(validQuery));
    });
    const pilot = events.filter(event => event.operation === 'fixed_cost.truck_summary_pilot' && event.outcome === outcome);
    assert.equal(pilot.length, 1, outcome);
    assert.equal(typeof pilot[0].duration_ms, 'number');
  }
  assert.doesNotMatch(JSON.stringify(events), /7654321|1234567|2025-03|uzdavinys|masin|kastai|SELECT/);

  // Replica failures log a classification only, never driver codes, errno or messages.
  const failures: Record<string, unknown>[] = [];
  const driverErrors = [
    Object.assign(new Error('pool timeout'), { code: 'ER_GET_CONNECTION_TIMEOUT', errno: 45028 }),
    Object.assign(new Error('statement timeout'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }),
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', errno: -111 }),
  ];
  for (const failure of driverErrors) {
    await withApp(() => { throw failure; }, async app => {
      app.addHook('onRequest', async request => {
        const capture = (event: Record<string, unknown>) => { failures.push(event); };
        request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
      });
      await app.inject(summaryUrl(validQuery));
    });
  }
  assert.deepEqual(failures.filter(event => event.operation === 'fixed_cost.truck_summary_pilot').map(event => event.failure),
    ['connection', 'statement_timeout', 'replica']);
  assert.doesNotMatch(JSON.stringify(failures), /diagnostics|ER_|errno|45028|1969|ECONNREFUSED|pool|statement timeout/);
});

// --- 24, 25, 26, 27: surface unchanged -----------------------------------------

test('flag on: breakdown, dimensions and every other scope remain 422 with zero replica access', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    for (const endpoint of fixedCostEndpoints) {
      for (const scope of fixedCostAllocationScopes) {
        if (endpoint === 'summary' && scope === 'truck') continue;
        for (const query of [`allocationScope=${scope}`, `allocationScope=${scope}&dateFrom=2025-03-01&dateTo=2025-03-31`]) {
          const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?${query}`);
          assert.equal(response.statusCode, 422, `${endpoint}?${query}`);
          assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
        }
      }
    }
    assert.equal(calls.length, 0);
  });
});

test('the pilot adds no route and leaves existing routes identical', async () => {
  const collect = async (config: typeof enabledConfig) => {
    const { pool } = fakePool(() => []);
    const app = buildApp(config, () => pool, { authenticate: false });
    const routes = new Set<string>();
    app.addHook('onRoute', route => { routes.add(`${route.method} ${route.url}`); });
    try {
      await app.ready();
      for (const path of [
        '/expense-analytics/fixed-costs/summary/truck', '/expense-analytics/fixed-costs/pilot',
        '/expense-analytics/fixed-costs/totals', '/expense-analytics/fixed-costs/monetary',
        '/expense-analytics/fixed-costs/reconciliation', '/expense-analytics/fixed-costs/diagnostics',
      ]) {
        for (const method of ['GET', 'POST'] as const) assert.equal((await app.inject({ method, url: path })).statusCode, 404, path);
      }
      assert.equal((await app.inject({ method: 'POST', url: summaryUrl(validQuery) })).statusCode, 404);
    } finally { await app.close(); }
    return [...routes].sort();
  };
  const enabled = await collect(enabledConfig);
  assert.deepEqual(enabled, await collect(disabledConfig));
  assert.deepEqual(enabled.filter(route => route.includes('fixed-costs')), [
    'GET /expense-analytics/fixed-costs/breakdown',
    'GET /expense-analytics/fixed-costs/dimensions',
    'GET /expense-analytics/fixed-costs/summary',
  ].flatMap(route => [route.replace('GET', 'GET'), route.replace('GET', 'HEAD')]).sort());
  for (const path of ['/vehicles', '/invoices', '/schema/tables']) {
    assert.ok(enabled.some(route => route === `GET ${path}` || route.startsWith(`GET ${path}/`)), path);
  }
});

// --- mutation guards ----------------------------------------------------------

test('mutation: bypassing the feature flag fails the resolver guard', () => {
  type Resolver = typeof resolveFixedCostCapability;
  const guard = (resolver: Resolver) => {
    for (const endpoint of fixedCostEndpoints) {
      for (const scope of fixedCostAllocationScopes) {
        assert.equal(resolver(endpoint, scope, { truckSummaryPilotEnabled: false }).enabled, false, `${endpoint}/${scope} off`);
        assert.equal(resolver(endpoint, scope, { truckSummaryPilotEnabled: true }).enabled, endpoint === 'summary' && scope === 'truck');
      }
    }
  };
  guard(resolveFixedCostCapability);
  const alwaysOn: Resolver = (endpoint, scope) => endpoint === 'summary' && scope === 'truck'
    ? { enabled: true, mode: 'truck_summary_pilot' } : { enabled: false };
  const everyScope: Resolver = (endpoint, _scope, config) => endpoint === 'summary' && config.truckSummaryPilotEnabled
    ? { enabled: true, mode: 'truck_summary_pilot' } : { enabled: false };
  const everyEndpoint: Resolver = (_endpoint, scope, config) => scope === 'truck' && config.truckSummaryPilotEnabled
    ? { enabled: true, mode: 'truck_summary_pilot' } : { enabled: false };
  for (const mutant of [alwaysOn, everyScope, everyEndpoint]) assert.throws(() => guard(mutant), assert.AssertionError);
});

test('mutation: executing before the period and policy gates fails the zero-access guard', async () => {
  type Runner = (pool: ReplicaPool, gate: AnalyticsGate, request: { allocationScope: 'truck'; dateFrom: string; dateTo: string }, at: Date) => Promise<unknown>;
  const guard = async (runner: Runner) => {
    for (const [dateFrom, dateTo] of [['2026-09-01', '2026-09-30'], ['2025-03-01', '2025-03-30']]) {
      const { pool, calls } = fakePool(() => [driverRow()]);
      await assert.rejects(runner(pool, new AnalyticsGate(3, 6, 1000), { allocationScope: 'truck', dateFrom, dateTo }, now), TruckFixedCostPilotRefused);
      assert.equal(calls.length, 0, 'Refused before replica access');
    }
  };
  await guard(runTruckFixedCostPilotSummary);
  const queryFirst: Runner = async (pool, gate, request, at) => {
    await queryFixedCostMonetaryTotals(pool, gate, { allocationScope: 'truck', representation: 'locked', periodMonth: month }, truckFixedCostPilotDeletedRowPolicy, at);
    return runTruckFixedCostPilotSummary(pool, gate, request, at);
  };
  await assert.rejects(guard(queryFirst), assert.AssertionError);
});

type Projector = typeof projectTruckFixedCostPilotSummary;
const withGroups = (project: Projector, map: (group: FixedCostMonetaryGroup) => FixedCostMonetaryGroup): Projector =>
  (result, periodMonth) => project({ ...result, groups: result.groups.map(map) }, periodMonth);

test('mutation: selecting current instead of locked fails the representation guards', () => {
  const statementGuard = (sql: string) => {
    assert.match(sql, /a\.locked_kastaiVilkiko,/);
    assert.doesNotMatch(sql, /\ba\.kastaiVilkiko\b/);
  };
  const projectionGuard = (project: Projector) => {
    assert.throws(() => project(lockedResult([{}], { representation: 'current', breakdownSource: fixedCostBreakdownSources.current }), month));
  };
  return withApp(() => [driverRow()], async (app, calls) => {
    await app.inject(summaryUrl(validQuery));
    statementGuard(calls[0].sql);
    assert.throws(() => statementGuard(calls[0].sql.replace('a.locked_kastaiVilkiko,', 'a.kastaiVilkiko,')), assert.AssertionError);
    projectionGuard(projectTruckFixedCostPilotSummary);
    const relabel: Projector = (result, periodMonth) => projectTruckFixedCostPilotSummary(
      { ...result, meta: { ...result.meta, representation: 'locked', breakdownSource: fixedCostBreakdownSources.locked } }, periodMonth);
    assert.throws(() => projectionGuard(relabel), assert.AssertionError);
  });
});

test('mutation: including deleted = 1 fails the exclusion guard', () => {
  const guard = (project: Projector) => {
    const result = lockedResult([{}, { deletedState: 'one', authoritativeTotal: '999.99', authoritativeRecords: 7, lockedRecords: 7 }]);
    const projected = project(result, month);
    assert.equal(projected.data.amount, '1234567.10');
    assert.equal(projected.data.totalTaskCount, 3);
  };
  guard(projectTruckFixedCostPilotSummary);
  const selectDeleted = withGroups(projectTruckFixedCostPilotSummary, group => ({ ...group, deletedState: group.deletedState === 'one' ? 'zero' : 'one' }));
  assert.throws(() => guard(selectDeleted), assert.AssertionError);
});

test('mutation: accepting an unlocked population fails the lock guard', () => {
  const guard = (project: Projector) => {
    for (const group of [{ lockedRecords: 2, unlockedRecords: 1 }, { lockedRecords: 2, unknownLockRecords: 1 }]) {
      assert.throws(() => project(lockedResult([group]), month), refusedWith('PERIOD_NOT_FULLY_LOCKED'));
    }
  };
  guard(projectTruckFixedCostPilotSummary);
  const ignoreLocks = withGroups(projectTruckFixedCostPilotSummary, group => ({
    ...group, lockedRecords: group.authoritativeRecords, unlockedRecords: 0, unknownLockRecords: 0,
  }));
  assert.throws(() => guard(ignoreLocks), assert.AssertionError);
});

test('mutation: removing completeness enforcement fails the completeness guard', () => {
  const guard = (project: Projector) => {
    for (const meta of [{ complete: false }, { truncated: true as false }]) {
      assert.throws(() => project(lockedResult([{}], meta), month), refusedWith('INCOMPLETE_RESULT'));
    }
    assert.throws(() => project(lockedResult([{ missingTotalRecords: 1, comparableRecords: 2 }]), month), refusedWith('INCOMPLETE_RESULT'));
  };
  guard(projectTruckFixedCostPilotSummary);
  const forceComplete: Projector = (result, periodMonth) => projectTruckFixedCostPilotSummary(
    { ...result, meta: { ...result.meta, complete: true, truncated: false }, groups: result.groups.map(group => ({ ...group, missingTotalRecords: 0 })) },
    periodMonth,
  );
  assert.throws(() => guard(forceComplete), assert.AssertionError);
});

test('mutation: replacing the authoritative total with component sums fails the source guard', () => {
  const guard = (project: Projector) => {
    assert.equal(project(lockedResult([{ componentTotal: '1.00' }]), month).data.amount, '1234567.10');
  };
  guard(projectTruckFixedCostPilotSummary);
  const componentSum = withGroups(projectTruckFixedCostPilotSummary, group => ({ ...group, authoritativeTotal: group.componentTotal }));
  assert.throws(() => guard(componentSum), assert.AssertionError);
});

test('mutation: dropping provisional limitations fails the metadata guard', () => {
  const guard = (response: TruckFixedCostPilotSummaryResponse) => {
    assert.equal(response.meta.pilot, true);
    assert.equal(response.meta.semanticsVersion, 'truck-fixed-cost-summary-pilot-v1');
    for (const pattern of requiredLimitations) assert.ok(response.meta.limitations.some(entry => pattern.test(entry)), String(pattern));
  };
  const projected = projectTruckFixedCostPilotSummary(lockedResult(), month);
  guard(projected);
  for (const pattern of requiredLimitations) {
    const dropped = { ...projected, meta: { ...projected.meta, limitations: projected.meta.limitations.filter(entry => !pattern.test(entry)) } };
    assert.throws(() => guard(dropped), assert.AssertionError, String(pattern));
  }
  assert.throws(() => guard({ ...projected, meta: { ...projected.meta, semanticsVersion: null as unknown as 'truck-fixed-cost-summary-pilot-v1' } }), assert.AssertionError);
});

// --- single-truck summary (truckId) --------------------------------------------

const truckQuery = `${validQuery}&truckId=12345`;
const truckFilterSql = 'AND t.uzdavinio_masina IN (?)';

test('truckId absent: the fleet-wide read, SQL and response are unchanged', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    const response = await app.inject(summaryUrl(validQuery));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), expectedSuccess);
    assert.equal(Object.hasOwn(response.json().data, 'truckId'), false);
    assert.deepEqual(calls[0].values, ['2025-03-01', '2025-04-01']);
    assert.doesNotMatch(calls[0].sql, /uzdavinio_masina/);
  });
});

test('truckId: one bound placeholder on the verified task-truck column filters the same read', async () => {
  let fleetSql = '';
  await withApp(() => [driverRow()], async (_app, calls) => {
    await _app.inject(summaryUrl(validQuery));
    fleetSql = calls[0].sql;
  });
  await withApp(() => [driverRow()], async (app, calls) => {
    const truckId = 987654321;
    const response = await app.inject(summaryUrl(`${validQuery}&truckId=${truckId}`));
    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, ['2025-03-01', '2025-04-01', truckId], 'truckId is a bound number');
    assert.equal(calls[0].sql.split(truckFilterSql).length, 2, 'Exactly one truck predicate');
    assert.ok(!calls[0].sql.includes(String(truckId)), 'truckId is never interpolated');
    // Identical statement apart from the one bound predicate: same locked source, deleted grouping and bound.
    assert.equal(calls[0].sql.replace(`\n        ${truckFilterSql}`, ''), fleetSql);
  });
});

test('invalid truckId variants and plate numbers fail with 400 before replica access', async () => {
  for (const config of [enabledConfig, disabledConfig]) {
    await withApp(() => [driverRow()], async (app, calls) => {
      for (const value of ['', '0', '00', '-1', '+5', '05', '1.5', '1.0', '1e3', '0x10', 'abc', '%205', '5%20', '9007199254740992',
        '1%20OR%201=1', "1'%20OR%20'1'='1", '1;DROP%20TABLE%20uzdaviniai', '1)--', 'HOO756', 'null', 'true']) {
        const response = await app.inject(summaryUrl(`${validQuery}&truckId=${value}`));
        assert.equal(response.statusCode, 400, value);
        assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid fixed-cost query' } }, value);
      }
      for (const extra of ['truckId=1&truckId=2', 'truckId=1&truckId=1', 'truckIds=1', 'truckId[]=1', 'plateNumber=HOO756', 'plate_number=HOO756', 'truck=1', 'truckId=1,2']) {
        assert.equal((await app.inject(summaryUrl(`${validQuery}&${extra}`))).statusCode, 400, extra);
      }
      assert.equal(calls.length, 0);
    }, config);
  }
});

test('truckId stays unknown on dimensions and unlocks nothing without the flag or outside truck scope', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    assert.equal((await app.inject(`/expense-analytics/fixed-costs/dimensions?${truckQuery}`)).statusCode, 400, 'dimensions');
    const otherScope = await app.inject(summaryUrl('allocationScope=trailer&dateFrom=2025-03-01&dateTo=2025-03-31&truckId=1'));
    assert.equal(otherScope.statusCode, 422);
    assert.equal(otherScope.json().error.code, 'SEMANTICS_UNVERIFIED');
    assert.equal(calls.length, 0);
  });
  await withApp(() => [driverRow()], async (app, calls) => {
    for (const endpoint of ['summary', 'breakdown']) {
      const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?${truckQuery}`);
      assert.equal(response.statusCode, 422, `Flag off still refuses a valid truck ${endpoint} request`);
      assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
    }
    assert.equal(calls.length, 0);
  }, disabledConfig);
});

test('single truck: the stored locked total is returned with the truck echoed and truck limitations', async () => {
  await withApp(() => [driverRow({ records: 2, authoritativeTotal: '8123.45' })], async app => {
    const response = await app.inject(summaryUrl(truckQuery));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: { ...expectedSuccess.data, truckId: 12345, amount: '8123.45', totalTaskCount: 2, lockedTaskCount: 2 },
      meta: { ...expectedSuccess.meta, limitations: [...truckFixedCostPilotSingleTruckLimitations] },
    });
    assert.deepEqual(Object.keys(response.json().data), ['allocationScope', 'truckId', 'periodMonth', 'amount', 'currency', 'representation', 'totalTaskCount', 'lockedTaskCount']);
    const { limitations } = response.json().meta;
    for (const pattern of requiredLimitations) assert.ok(limitations.some((entry: string) => pattern.test(entry)), String(pattern));
    assert.ok(limitations.some((entry: string) => /uzdavinio_masina.*absent from uzdaviniai.*excluded/.test(entry)));
    assert.ok(!limitations.some((entry: string) => /remain in the included population/.test(entry)), 'Orphan rows cannot be in a single-truck population');
    assert.deepEqual(limitations, [...limitations].sort());
  });
});

test('single truck: a real fully locked stored zero is 0.00', async () => {
  await withApp(() => [driverRow({ records: 1, authoritativeTotal: '0.00' })], async app => {
    const response = await app.inject(summaryUrl(truckQuery));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.amount, '0.00');
    assert.equal(response.json().data.totalTaskCount, 1);
  });
});

test('single truck: no included records, or only deleted = 1 records, is NO_DATA_FOR_PERIOD', async () => {
  for (const rows of [[], [driverRow({ deletedState: 'one', records: 4 })], [driverRow({ records: 0 })]]) {
    await withApp(() => rows, async (app, calls) => {
      const response = await app.inject(summaryUrl(truckQuery));
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'NO_DATA_FOR_PERIOD');
      assert.doesNotMatch(response.body, /"amount":|0\.00/);
      assert.equal(calls.length, 1);
    });
  }
});

test('single truck: unlocked, unknown lock, missing total, truncation and period refusals are unchanged', async () => {
  const cases: [unknown[], string][] = [
    [[driverRow({ unlocked: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[driverRow({ unknown: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[driverRow({ missingTotal: 1 })], 'INCOMPLETE_RESULT'],
    [[driverRow({ deletedState: 'other', records: 1 }), driverRow()], 'INCOMPLETE_RESULT'],
    [[driverRow({ records: fixedCostMonetaryMaxRecords + 1 })], 'INCOMPLETE_RESULT'],
  ];
  for (const [rows, code] of cases) {
    await withApp(() => rows, async app => {
      const response = await app.inject(summaryUrl(truckQuery));
      assert.equal(response.statusCode, 422, code);
      assert.equal(response.json().error.code, code);
      assert.doesNotMatch(response.body, /1234567|"amount":/);
    });
  }
  await withApp(() => [driverRow()], async (app, calls) => {
    assert.equal((await app.inject(summaryUrl('allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-30&truckId=12345'))).json().error.code, 'PERIOD_NOT_COMPLETE_MONTH');
    assert.equal((await app.inject(summaryUrl(`${monthOffset(-1)}&truckId=12345`))).json().error.code, 'PERIOD_NOT_SETTLED');
    assert.equal(calls.length, 0, 'Period refusals still happen before replica access');
  });
});

test('single truck: deleted = 1 is still excluded from the amount and counts', async () => {
  await withApp(() => [driverRow({ deletedState: 'one', records: 9, authoritativeTotal: '999999.99' }), driverRow({ records: 2, authoritativeTotal: '10.50' })], async (app, calls) => {
    const response = await app.inject(summaryUrl(truckQuery));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.amount, '10.50');
    assert.equal(response.json().data.totalTaskCount, 2);
    assert.match(calls[0].sql, /GROUP BY r\.deletedState/, 'Deleted states are still separated before the pilot policy');
  });
});

test('single truck: the projection requires the repository truck filter to match the request', () => {
  assert.equal(projectTruckFixedCostPilotSummary(lockedResult([{}], { truckFilterApplied: true }), month, 12345).data.truckId, 12345);
  assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([{}], { truckFilterApplied: false }), month, 12345), InvalidFixedCostMonetaryResult,
    'A fleet read must never be reported as one truck');
  assert.throws(() => projectTruckFixedCostPilotSummary(lockedResult([{}], { truckFilterApplied: true }), month), InvalidFixedCostMonetaryResult,
    'A filtered read must never be reported as the fleet');
});

test('single truck: authentication, timeout, busy, sanitized errors and value-free telemetry are unchanged', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token-that-is-longer-than-thirty-two-chars' }]) {
      const response = await app.inject({ url: summaryUrl(truckQuery), headers });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'UNAUTHORIZED');
    }
    assert.equal(calls.length, 0);
    assert.equal((await app.inject({ url: summaryUrl(truckQuery), headers: auth })).statusCode, 200);
  }, enabledConfig, true);

  await withApp(() => { throw Object.assign(new Error('SELECT secret WHERE uzdavinio_masina = 12345'), { code: 'ER_STATEMENT_TIMEOUT' }); }, async app => {
    const response = await app.inject(summaryUrl(truckQuery));
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.json(), { error: { code: 'QUERY_TIMEOUT', message: 'Fixed-cost query timed out' } });
  });
  await withApp(() => { throw Object.assign(new Error('connect ECONNREFUSED private-host truck 12345'), { code: 'ECONNREFUSED' }); }, async app => {
    const response = await app.inject(summaryUrl(truckQuery));
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: { code: 'REPLICA_UNAVAILABLE', message: 'Fixed-cost data temporarily unavailable' } });
  });
  const busyConfig = loadConfig({
    ...baseEnvironment, [pilotFlag]: 'true',
    ERP_ANALYTICS_CONCURRENCY: '1', ERP_ANALYTICS_QUEUE_LIMIT: '1', ERP_ANALYTICS_QUEUE_TIMEOUT_MS: '1',
  });
  await withApp(() => [driverRow()], async (app, calls) => {
    let release!: () => void;
    const held = app.analyticsGate.run(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const response = await app.inject(summaryUrl(truckQuery));
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: { code: 'SERVICE_BUSY', message: 'Analytical service is busy' } });
      assert.equal(calls.length, 0);
    } finally { release(); await held; }
  }, busyConfig);

  const events: Record<string, unknown>[] = [];
  for (const rows of [[driverRow({ authoritativeTotal: '7654321.98' })], [], [driverRow({ unlocked: 1 })]]) {
    await withApp(() => rows, async app => {
      app.addHook('onRequest', async request => {
        const capture = (event: Record<string, unknown>) => { events.push(event); };
        request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
      });
      await app.inject(summaryUrl(truckQuery));
    });
  }
  const pilot = events.filter(event => event.operation === 'fixed_cost.truck_summary_pilot');
  assert.deepEqual(pilot.map(event => event.outcome), ['success', 'refused', 'refused']);
  assert.doesNotMatch(JSON.stringify(events), /12345|truckId|truck_id|7654321|2025-03|uzdavinio_masina/, 'No truck identifier, amount or period in telemetry');
});

// --- single-truck breakdown (truckId) ------------------------------------------

const breakdownUrl = (query: string) => `/expense-analytics/fixed-costs/breakdown?${query}`;

/** Current read first, then locked, exactly as the 7A orchestration calls its executor. */
const perRepresentation = (current: unknown[], locked: unknown[]) => {
  let call = 0;
  return () => (call++ === 0 ? current : locked);
};

test('breakdown without truckId is unchanged: fleet-wide stays 422 and 7A parameters stay 400', async () => {
  for (const config of [enabledConfig, disabledConfig]) {
    await withApp(() => [driverRow()], async (app, calls) => {
      for (const query of ['allocationScope=truck', validQuery]) {
        const response = await app.inject(breakdownUrl(query));
        assert.equal(response.statusCode, 422, query);
        assert.deepEqual(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
      for (const extra of ['groupBy=truck', 'truckIds=1', 'page=1', 'perPage=10', 'sortBy=truckId', 'groupBy=costComponent']) {
        assert.equal((await app.inject(breakdownUrl(`${truckQuery}&${extra}`))).statusCode, 400, extra);
      }
      assert.equal(calls.length, 0);
    }, config);
  }
});

test('single-truck breakdown: two bound reads return the unchanged 7A shape for exactly one truck', async () => {
  const current = driverRow({ records: 2, authoritativeTotal: '9100.00', componentTotal: '9099.10' });
  const locked = driverRow({ records: 2, authoritativeTotal: '9050.25', componentTotal: '9050.00' });
  await withApp(perRepresentation([current], [locked]), async (app, calls) => {
    const response = await app.inject(breakdownUrl(truckQuery));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();

    // Two independent reads, current then locked, each with the one bound truck predicate.
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /a\.kastaiVilkiko,/);
    assert.match(calls[1].sql, /a\.locked_kastaiVilkiko,/);
    for (const call of calls) {
      assert.deepEqual(call.values, ['2025-03-01', '2025-04-01', 12345]);
      assert.equal(call.sql.split(truckFilterSql).length, 2);
      assert.ok(!call.sql.includes('12345'), 'truckId is never interpolated');
    }

    assert.deepEqual(Object.keys(data), ['allocationScope', 'dateFrom', 'dateTo', 'currency', 'groups', 'unresolved']);
    assert.deepEqual({ ...data, groups: undefined }, { allocationScope: 'truck', dateFrom: '2025-03-01', dateTo: '2025-03-31', currency: 'EUR', groups: undefined, unresolved: null });
    assert.equal(data.groups.length, 1);
    const [group] = data.groups;
    assert.deepEqual(Object.keys(group), ['truckId', 'currentAmount', 'lockedAmount', 'taskCount', 'lockStates', 'reconciliation']);
    assert.equal(group.truckId, 12345);
    assert.equal(group.currentAmount, '9100.00', 'Stored current total, never a component sum');
    assert.equal(group.lockedAmount, '9050.25', 'Stored locked total, never a component sum');
    assert.equal(group.taskCount, 2);
    assert.deepEqual(group.lockStates, { locked: 2, unlocked: 0, unknown: 0 });
    // Components are explanatory only: their total may differ from the stored total and is not forced to match.
    assert.equal(group.reconciliation.current.componentTotal, '9099.10');
    assert.equal(group.reconciliation.locked.componentTotal, '9050.00');
    assert.equal(group.reconciliation.locked.netDifference, '0.15');
    for (const representation of ['current', 'locked']) {
      assert.deepEqual(Object.keys(group.reconciliation[representation]), ['status', 'comparableRecords', 'affectedRecords', 'componentTotal',
        'netDifference', 'grossAbsoluteDifference', 'buckets', 'noDetailRecords', 'multipleDetailRecords'], 'Aggregate reconciliation only');
    }
    const serialized = JSON.stringify(data);
    for (const field of fixedCostComponentFields) assert.ok(!serialized.includes(field), `No per-component amount: ${field}`);

    assert.equal(meta.groupBy, 'truck');
    assert.equal(meta.complete, true);
    assert.equal(meta.reconciliationStatus, 'unreconciled');
    assert.deepEqual(meta.periodMonths, ['2025-03-01']);
    assert.deepEqual(meta.pagination, { page: 1, perPage: 50, groupCount: 1, pageCount: 1, maxGroups: 1000 });
    assert.deepEqual(meta.deletedRowPolicy, { ...truckFixedCostPilotDeletedRowPolicy });
    assert.equal(meta.componentInventory.independentlyAdditive, false);
    assert.equal(meta.groupingAvailability.costComponent.status, 'blocked');
  });
});

test('single-truck breakdown: invalid truckId is 400 before replica access', async () => {
  for (const config of [enabledConfig, disabledConfig]) {
    await withApp(() => [driverRow()], async (app, calls) => {
      for (const value of ['', '0', '-1', '05', '1.5', '1e3', 'abc', 'HOO756', '1%20OR%201=1', '9007199254740992']) {
        const response = await app.inject(breakdownUrl(`${validQuery}&truckId=${value}`));
        assert.equal(response.statusCode, 400, value);
        assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid fixed-cost query' } });
      }
      for (const extra of ['truckId=1&truckId=2', 'truckId=1,2', 'plateNumber=HOO756']) {
        assert.equal((await app.inject(breakdownUrl(`${validQuery}&${extra}`))).statusCode, 400, extra);
      }
      assert.equal(calls.length, 0);
    }, config);
  }
});

test('single-truck breakdown: no included records is NO_DATA_FOR_PERIOD, never an empty or zero group', async () => {
  for (const rows of [[], [driverRow({ deletedState: 'one', records: 4 })]]) {
    await withApp(() => rows, async (app, calls) => {
      const response = await app.inject(breakdownUrl(truckQuery));
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'NO_DATA_FOR_PERIOD');
      assert.doesNotMatch(response.body, /"groups"|"currentAmount"|"lockedAmount"/);
      assert.equal(calls.length, 1, 'The first read already refuses');
    });
  }
});

test('single-truck breakdown: deleted = 1 is excluded under the unchanged pilot policy', async () => {
  const withDeleted = (total: string) => [driverRow({ deletedState: 'one', records: 7, authoritativeTotal: '999999.99' }), driverRow({ records: 2, authoritativeTotal: total })];
  await withApp(perRepresentation(withDeleted('20.00'), withDeleted('10.50')), async app => {
    const response = await app.inject(breakdownUrl(truckQuery));
    assert.equal(response.statusCode, 200);
    const [group] = response.json().data.groups;
    assert.equal(group.currentAmount, '20.00');
    assert.equal(group.lockedAmount, '10.50');
    assert.equal(group.taskCount, 2);
    assert.ok(response.json().meta.limitations.some((entry: string) => /non-zero deleted flag are excluded/.test(entry)));
  });
});

test('single-truck breakdown: unlocked, incomplete, truncated and period refusals match the summary', async () => {
  const cases: [unknown[], string][] = [
    [[driverRow({ unlocked: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[driverRow({ unknown: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[driverRow({ missingTotal: 1 })], 'INCOMPLETE_RESULT'],
    [[driverRow({ deletedState: 'other', records: 1 }), driverRow()], 'INCOMPLETE_RESULT'],
    [[driverRow({ records: fixedCostMonetaryMaxRecords + 1 })], 'INCOMPLETE_RESULT'],
  ];
  for (const [rows, code] of cases) {
    await withApp(() => rows, async app => {
      const response = await app.inject(breakdownUrl(truckQuery));
      assert.equal(response.statusCode, 422, code);
      assert.equal(response.json().error.code, code);
    });
  }
  // A locked read that disagrees with the current read's population is never presented.
  await withApp(perRepresentation([driverRow({ records: 3 })], [driverRow({ records: 2 })]), async app => {
    assert.equal((await app.inject(breakdownUrl(truckQuery))).json().error.code, 'INCOMPLETE_RESULT');
  });
  await withApp(() => [driverRow()], async (app, calls) => {
    assert.equal((await app.inject(breakdownUrl('allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-30&truckId=12345'))).json().error.code, 'PERIOD_NOT_COMPLETE_MONTH');
    assert.equal((await app.inject(breakdownUrl(`${monthOffset(-1)}&truckId=12345`))).json().error.code, 'PERIOD_NOT_SETTLED');
    assert.equal(calls.length, 0);
  });
});

test('single-truck breakdown keeps auth, sanitized errors and value-free telemetry; summary is unaffected', async () => {
  await withApp(() => [driverRow()], async (app, calls) => {
    assert.equal((await app.inject(breakdownUrl(truckQuery))).statusCode, 401);
    assert.equal(calls.length, 0);
    assert.equal((await app.inject({ url: breakdownUrl(truckQuery), headers: auth })).statusCode, 200);
  }, enabledConfig, true);
  await withApp(() => { throw Object.assign(new Error('SELECT secret uzdavinio_masina = 12345'), { code: 'ER_STATEMENT_TIMEOUT' }); }, async app => {
    const response = await app.inject(breakdownUrl(truckQuery));
    assert.equal(response.statusCode, 504);
    assert.doesNotMatch(response.body, /SELECT|12345/);
  });
  const events: Record<string, unknown>[] = [];
  await withApp(() => [driverRow({ authoritativeTotal: '7654321.98' })], async app => {
    app.addHook('onRequest', async request => {
      const capture = (event: Record<string, unknown>) => { events.push(event); };
      request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
    });
    await app.inject(breakdownUrl(truckQuery));
  });
  const pilot = events.filter(event => event.operation === 'fixed_cost.truck_breakdown_pilot');
  assert.deepEqual(pilot.map(event => [event.outcome, event.endpoint, event.group_count]), [['success', '/expense-analytics/fixed-costs/breakdown', 1]]);
  assert.doesNotMatch(JSON.stringify(events), /12345|7654321|2025-03|uzdavinio_masina/);

  await withApp(() => [driverRow()], async app => {
    assert.deepEqual((await app.inject(summaryUrl(validQuery))).json(), expectedSuccess, 'Fleet summary unchanged');
    assert.equal((await app.inject(summaryUrl(truckQuery))).json().data.truckId, 12345, 'Single-truck summary unchanged');
  });
});

test('mutation: breakdown resolves only for truck scope, the flag and one truckId', () => {
  const on = { truckSummaryPilotEnabled: true };
  assert.deepEqual(resolveFixedCostCapability('breakdown', 'truck', on, { truckId: 1 }), { enabled: true, mode: 'truck_breakdown_pilot' });
  assert.deepEqual(resolveFixedCostCapability('breakdown', 'truck', on), { enabled: false });
  assert.deepEqual(resolveFixedCostCapability('breakdown', 'truck', { truckSummaryPilotEnabled: false }, { truckId: 1 }), { enabled: false });
  assert.deepEqual(resolveFixedCostCapability('breakdown', 'trailer', on, { truckId: 1 }), { enabled: false });
  assert.deepEqual(resolveFixedCostCapability('dimensions', 'truck', on, { truckId: 1 }), { enabled: false });
  assert.deepEqual(resolveFixedCostCapability('summary', 'truck', on), { enabled: true, mode: 'truck_summary_pilot' });
  assert.equal(Object.values(fixedCostSemanticCapabilities).every(entry => entry.enabled === false), true, 'Static registry stays all-disabled');
});
