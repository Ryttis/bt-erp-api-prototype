import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import {
  FixedCostDeletedPolicyUnapproved, InvalidFixedCostMonetaryQuery, parseFixedCostMonetaryQuery,
} from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostComponentFields, fixedCostMonetaryStatement, fixedCostTrailerComponentFields } from '../../src/fixed-costs/monetary-repository.js';
import { trailerFixedCostPilotDeletedRowPolicy } from '../../src/fixed-costs/pilot-trailer.js';
import {
  trailerFleetFixedCostPilotBreakdownLimitations, trailerFleetFixedCostPilotSummaryLimitations,
} from '../../src/fixed-costs/pilot-trailer-fleet.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';
import {
  queryTrailerFleetGroups, queryTrailerFleetTotals, trailerFleetGroupsStatement, trailerFleetMaxGroups,
  trailerFleetTotalsStatement,
} from '../../src/fixed-costs/trailer-fleet-repository.js';

const baseEnvironment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
  ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};
const truckFlag = 'ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED';
const trailerFlag = 'ERP_FIXED_COST_TRAILER_PILOT_ENABLED';
const bothConfig = loadConfig({ ...baseEnvironment, [truckFlag]: 'true', [trailerFlag]: 'true' });
const truckOnlyConfig = loadConfig({ ...baseEnvironment, [truckFlag]: 'true' });
const auth = { authorization: `Bearer ${bothConfig.auth.serviceToken}` };
const now = new Date('2026-09-30T10:00:00Z');

const period = 'dateFrom=2025-03-01&dateTo=2025-03-31';
const fleetQuery = `allocationScope=trailer&${period}`;
const summaryUrl = (query: string) => `/expense-analytics/fixed-costs/summary?${query}`;
const breakdownUrl = (query: string) => `/expense-analytics/fixed-costs/breakdown?${query}`;
const periodValues = ['2025-03-01', '2025-04-01'];

// Synthetic identifiers only; none is a real trailer.
const groupRows = [
  { trailerId: 900000003, taskCount: 4, lockedAmount: '500.00' },
  { trailerId: 900000001, taskCount: 3, lockedAmount: '250.05' },
  { trailerId: 900000002, taskCount: 3, lockedAmount: '250.05' },
];

type Bucket = { records?: number; nonZero?: number; total?: string };

/** One driver row as the fleet totals statement returns a declared-state group. */
function totalsRow(options: {
  deletedState?: string; total?: unknown; unlocked?: number; unknown?: number; missingTotal?: number;
  attributedRecords?: number; attributedTrailers?: number; attributedTotal?: unknown;
  missingTask?: Bucket; missingAssignment?: Bucket; invalidMasterId?: Bucket; unattributedTotal?: string;
  reconciles?: unknown;
} = {}) {
  const attributedRecords = options.attributedRecords ?? 10;
  const categories = {
    missing_task: options.missingTask ?? { records: 1, nonZero: 1, total: '-5.00' },
    missing_assignment: options.missingAssignment ?? { records: 3, nonZero: 2, total: '104.90' },
    invalid_master_id: options.invalidMasterId ?? {},
  };
  const unattributedRecords = Object.values(categories).reduce((total, entry) => total + (entry.records ?? 0), 0);
  const records = attributedRecords + unattributedRecords;
  const unlocked = options.unlocked ?? 0;
  const unknown = options.unknown ?? 0;
  return {
    deletedState: options.deletedState ?? 'zero',
    authoritativeRecords: records,
    authoritativeTotal: options.total !== undefined ? options.total : '1100.00',
    missingTotalRecords: options.missingTotal ?? 0,
    unlockedRecords: unlocked,
    lockedRecords: records - unlocked - unknown,
    unknownLockRecords: unknown,
    attributedRecords,
    attributedTrailers: options.attributedTrailers ?? (attributedRecords > 0 ? 3 : 0),
    attributedTotal: options.attributedTotal !== undefined ? options.attributedTotal : '1000.10',
    unattributedRecords,
    unattributedNonZeroRecords: Object.values(categories).reduce((total, entry) => total + (entry.nonZero ?? 0), 0),
    unattributedTotal: options.unattributedTotal ?? '99.90',
    ...Object.fromEntries(Object.entries(categories).flatMap(([name, entry]) => [
      [`${name}Records`, entry.records ?? 0], [`${name}NonZeroRecords`, entry.nonZero ?? 0], [`${name}Total`, entry.total ?? '0.00'],
    ])),
    reconciles: options.reconciles !== undefined ? options.reconciles : 1,
  };
}

/** A single-trailer / truck repository row, for the unchanged-behaviour checks. */
function monetaryRow(fields: readonly string[]) {
  return {
    deletedState: 'zero', authoritativeRecords: 3, authoritativeTotal: '4321.10', comparableRecords: 3,
    comparableAuthoritativeTotal: '4321.10', componentTotal: '4320.95', netDifference: '0.15', grossAbsoluteDifference: '0.15',
    affectedRecords: 1,
    ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`, name === 'exact' ? 2 : name === 'rounding' ? 1 : 0])),
    noDetailRecords: 0, multipleDetailRecords: 0, missingTotalRecords: 0, missingTaskCount: 0,
    lockedRecords: 3, unlockedRecords: 0, unknownLockRecords: 0,
    ...Object.fromEntries(fields.map(field => [`component_${field}`, field === 'amortizacija' ? '4320.95' : '0.00'])),
  };
}

type Call = { sql: string; values: unknown[] };
const isGroups = (call: Call) => call.sql === trailerFleetGroupsStatement;
const isTotals = (call: Call) => call.sql === trailerFleetTotalsStatement;

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

const fleet = (totals: unknown = [totalsRow()], groups: unknown = groupRows) => (call: Call) => isGroups(call) ? groups : totals;

const expectedCategories = {
  missingAssignment: { amount: '104.90', taskCount: 3, nonZeroTaskCount: 2 },
  missingTask: { amount: '-5.00', taskCount: 1, nonZeroTaskCount: 1 },
  invalidMasterId: { amount: '0.00', taskCount: 0, nonZeroTaskCount: 0 },
};
const expectedAttribution = {
  amount: '1100.00',
  attributedAmount: '1000.10', attributedTaskCount: 10, attributedTrailerCount: 3,
  unattributedAmount: '99.90', unattributedTaskCount: 4, unattributedNonZeroTaskCount: 3,
  unattributedCategories: expectedCategories,
};
const expectedMeta = {
  sourceFamily: 'trailer_fixed_costs',
  amountSemantics: 'authoritative_locked_task_total_excluding_deleted',
  dateBasis: 'kastai_data',
  semanticsVersion: 'trailer-fleet-fixed-cost-pilot-v1',
  reconciliationStatus: 'provisional_unreconciled_erp_reference',
  attribution: { basis: 'uzdaviniai.uzdavinio_priekaba', invariant: 'amount = attributedAmount + unattributedAmount', invariantVerified: true },
  complete: true,
  pilot: true,
};

// --- 1, 3. Fleet summary -----------------------------------------------------------

test('fleet trailer summary succeeds for a valid locked month and keeps the unattributed amount', async () => {
  await withApp(fleet(), async (app, calls) => {
    const response = await app.inject(summaryUrl(fleetQuery));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: {
        allocationScope: 'trailer', periodMonth: '2025-03-01', currency: 'EUR', representation: 'locked',
        totalTaskCount: 14, lockedTaskCount: 14, ...expectedAttribution,
      },
      meta: { ...expectedMeta, limitations: [...trailerFleetFixedCostPilotSummaryLimitations] },
    });
    assert.equal(Object.hasOwn(response.json().data, 'trailerId'), false, 'A fleet response names no trailer');
    const { limitations } = response.json().meta;
    assert.deepEqual(limitations, [...limitations].sort());
    for (const pattern of [/uzdavinio_priekaba/, /not redistributed/, /FC-03/, /FC-11/, /FCB-05/, /never recomputed/]) {
      assert.ok(limitations.some((entry: string) => pattern.test(entry)), String(pattern));
    }
    assert.equal(calls.length, 1, 'The summary is one totals read');
    assert.ok(isTotals(calls[0]));
    assert.deepEqual(calls[0].values, periodValues);
  });
});

test('flag off: the fleet trailer request is 422 SEMANTICS_UNVERIFIED with zero replica access', async () => {
  for (const config of [truckOnlyConfig, loadConfig(baseEnvironment)]) {
    await withApp(fleet(), async (app, calls) => {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(fleetQuery));
        assert.equal(response.statusCode, 422);
        assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
      assert.equal(calls.length, 0);
    }, config);
  }
});

// --- 2, 11. The invariant is the database's; JavaScript never adds or compares money -

test('total = attributed + unattributed is evaluated in SQL and a read that does not reconcile is refused', async () => {
  assert.match(trailerFleetTotalsStatement,
    /CASE WHEN SUM\(r\.authoritative\) = SUM\(CASE WHEN r\.attribution = 'attributed' THEN r\.authoritative ELSE 0\.00 END\) \+ SUM\(CASE WHEN r\.attribution <> 'attributed' THEN r\.authoritative ELSE 0\.00 END\)/);
  assert.match(trailerFleetTotalsStatement, /THEN 1 ELSE 0 END AS reconciles/);
  // Anything but an exact database 1 is not proof of the invariant.
  for (const reconciles of [0, null, '1.0', 'true', 2]) {
    await withApp(fleet([totalsRow({ reconciles })]), async app => {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(fleetQuery));
        assert.equal(response.statusCode, 422, JSON.stringify(reconciles));
        assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
        assert.equal(Object.hasOwn(response.json(), 'data'), false);
      }
    });
  }
});

test('amounts are stored decimal text copied verbatim: no JavaScript summation, rounding or comparison', async () => {
  // Beyond double precision, and deliberately not adding up: had JavaScript summed or
  // re-derived any amount, these strings could not come back unchanged.
  const total = '12345678901234567890.13';
  const attributedTotal = '12345678901234567890.10';
  const unattributedTotal = '0.30';
  const groups = [
    { trailerId: 900000001, taskCount: 6, lockedAmount: '12345678901234567890.00' },
    { trailerId: 900000002, taskCount: 4, lockedAmount: '-0.10' },
  ];
  const row = totalsRow({
    total, attributedTotal, unattributedTotal, attributedTrailers: 2,
    missingAssignment: { records: 3, nonZero: 3, total: '0.10' }, missingTask: { records: 1, nonZero: 1, total: '0.20' },
  });
  await withApp(fleet([row], groups), async app => {
    const summary = (await app.inject(summaryUrl(fleetQuery))).json().data;
    const breakdown = (await app.inject(breakdownUrl(fleetQuery))).json().data;
    for (const data of [summary, breakdown]) {
      assert.equal(data.amount, total);
      assert.equal(data.attributedAmount, attributedTotal);
      assert.equal(data.unattributedAmount, unattributedTotal);
      for (const field of ['amount', 'attributedAmount', 'unattributedAmount']) assert.equal(typeof data[field], 'string', field);
    }
    assert.deepEqual(breakdown.groups.map((group: { lockedAmount: string }) => group.lockedAmount), ['12345678901234567890.00', '-0.10']);
  });
  // Driver numbers are refused outright rather than formatted.
  for (const bad of [{ total: 1100 }, { attributedTotal: 1000.1 }, { attributedTotal: null }, { total: '1,100.00' }, { total: '1100' }]) {
    await withApp(fleet([totalsRow(bad)]), async app => {
      assert.equal((await app.inject(summaryUrl(fleetQuery))).json().error.code, 'INCOMPLETE_RESULT', JSON.stringify(bad));
    });
  }
  await withApp(fleet([totalsRow()], groupRows.map(group => ({ ...group, lockedAmount: 250.05 }))), async app => {
    assert.equal((await app.inject(breakdownUrl(fleetQuery))).json().error.code, 'INCOMPLETE_RESULT');
  });
  // The pilot and repository sources contain no numeric parsing of amounts at all.
  for (const file of ['pilot-trailer-fleet.ts', 'trailer-fleet-repository.ts']) {
    const source = readFileSync(new URL(`../../src/fixed-costs/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /parseFloat|parseInt|Number\(|toFixed|Math\.|BigInt\(|\.sort\(/, file);
  }
});

// --- 3, 4. Unattributed rows -------------------------------------------------------

test('unattributed non-zero rows are preserved, signed, and never given a trailer identifier', async () => {
  const row = totalsRow({
    total: '-20.00', attributedTotal: '100.00', unattributedTotal: '-120.00',
    missingAssignment: { records: 5, nonZero: 4, total: '-150.00' },
    missingTask: { records: 2, nonZero: 1, total: '25.00' },
    invalidMasterId: { records: 1, nonZero: 1, total: '5.00' },
  });
  await withApp(fleet([row]), async app => {
    const summary = (await app.inject(summaryUrl(fleetQuery))).json().data;
    assert.equal(summary.unattributedAmount, '-120.00', 'Signed amount preserved');
    assert.equal(summary.unattributedTaskCount, 8);
    assert.equal(summary.unattributedNonZeroTaskCount, 6);
    assert.deepEqual(summary.unattributedCategories, {
      missingAssignment: { amount: '-150.00', taskCount: 5, nonZeroTaskCount: 4 },
      missingTask: { amount: '25.00', taskCount: 2, nonZeroTaskCount: 1 },
      invalidMasterId: { amount: '5.00', taskCount: 1, nonZeroTaskCount: 1 },
    });
    assert.equal(summary.totalTaskCount, summary.attributedTaskCount + summary.unattributedTaskCount);

    const breakdown = (await app.inject(breakdownUrl(fleetQuery))).json().data;
    assert.deepEqual(breakdown.unattributed, {
      reason: 'trailer_unattributed', lockedAmount: '-120.00', taskCount: 8, nonZeroTaskCount: 6,
      categories: summary.unattributedCategories,
    });
    assert.equal(JSON.stringify(breakdown.unattributed).includes('trailerId'), false, 'The bucket has no identifier, not even null or 0');
    // Groups are exactly the database's attributed trailers: nothing is added for the unattributed rows.
    assert.deepEqual(breakdown.groups.map((group: { trailerId: number }) => group.trailerId), groupRows.map(group => group.trailerId));
    assert.equal(breakdown.groups.length, breakdown.attributedTrailerCount);
  });
  // No unattributed row: an explicit zero amount, zero counts and a null bucket.
  const clean = totalsRow({ total: '1000.10', unattributedTotal: '0.00', missingTask: {}, missingAssignment: {} });
  await withApp(fleet([clean]), async app => {
    const summary = (await app.inject(summaryUrl(fleetQuery))).json().data;
    assert.equal(summary.unattributedAmount, '0.00');
    assert.equal(summary.unattributedTaskCount, 0);
    assert.equal(summary.unattributedNonZeroTaskCount, 0);
    assert.equal((await app.inject(breakdownUrl(fleetQuery))).json().data.unattributed, null);
  });
});

test('a trailer group without a positive database identifier is refused, never defaulted', async () => {
  for (const trailerId of [0, null, undefined, -1, '', 'AB123', 1.5]) {
    const groups = [{ ...groupRows[0], trailerId }, groupRows[1], groupRows[2]];
    await withApp(fleet([totalsRow()], groups), async app => {
      const response = await app.inject(breakdownUrl(fleetQuery));
      assert.equal(response.statusCode, 422, JSON.stringify(trailerId));
      assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
    });
  }
  // The statements never substitute, coalesce or look up an identifier.
  for (const statement of [trailerFleetTotalsStatement, trailerFleetGroupsStatement]) {
    assert.doesNotMatch(statement, /COALESCE|IFNULL|NULLIF|uzd_pr_vaziavo|masinos_nr|valst|LIKE/i);
    assert.match(statement, /WHEN s\.taskId IS NULL THEN 'missing_task'\s+WHEN s\.assignedTrailer IS NULL OR s\.assignedTrailer <= 0 THEN 'missing_assignment'\s+WHEN s\.masterTrailer IS NULL THEN 'invalid_master_id'\s+ELSE 'attributed' END AS attribution/);
  }
});

// --- 5, 10. Grouping and ordering ---------------------------------------------------

test('fleet breakdown groups by uzdavinio_priekaba and keeps the database order', async () => {
  await withApp(fleet(), async (app, calls) => {
    const response = await app.inject(breakdownUrl(fleetQuery));
    assert.equal(response.statusCode, 200);
    const { data, meta } = response.json();
    assert.deepEqual(data, {
      allocationScope: 'trailer', dateFrom: '2025-03-01', dateTo: '2025-03-31', currency: 'EUR', representation: 'locked',
      totalTaskCount: 14, lockedTaskCount: 14, ...expectedAttribution,
      // Database order, including the equal-amount pair broken by trailerId ascending.
      groups: [
        { trailerId: 900000003, lockedAmount: '500.00', taskCount: 4 },
        { trailerId: 900000001, lockedAmount: '250.05', taskCount: 3 },
        { trailerId: 900000002, lockedAmount: '250.05', taskCount: 3 },
      ],
      unattributed: { reason: 'trailer_unattributed', lockedAmount: '99.90', taskCount: 4, nonZeroTaskCount: 3, categories: expectedCategories },
    });
    assert.deepEqual(meta, {
      ...expectedMeta,
      limitations: [...trailerFleetFixedCostPilotBreakdownLimitations],
      authoritativeSource: 'kastai_fiksuoti_ataskaita',
      sorting: { sortBy: 'lockedAmount', sortDirection: 'desc', tieBreaker: { field: 'trailerId', direction: 'asc' } },
      groupCount: 3,
      maxGroups: trailerFleetMaxGroups,
      periodMonths: ['2025-03-01'],
      deletedRowPolicy: { ...trailerFixedCostPilotDeletedRowPolicy },
    });
    assert.equal(calls.length, 2);
    assert.ok(isTotals(calls[0]) && isGroups(calls[1]), 'Totals are validated before the groups are read');
  });
  assert.match(trailerFleetGroupsStatement, /t\.uzdavinio_priekaba AS assignedTrailer/);
  assert.match(trailerFleetGroupsStatement, /LEFT JOIN uzdaviniai t ON t\.id = a\.uzdavinys/);
  assert.match(trailerFleetGroupsStatement, /SELECT r\.assignedTrailer AS trailerId/);
  assert.match(trailerFleetGroupsStatement, /GROUP BY r\.assignedTrailer\s+ORDER BY SUM\(r\.authoritative\) DESC, r\.assignedTrailer ASC\s+LIMIT 20001$/);
  assert.match(trailerFleetGroupsStatement, /CAST\(SUM\(r\.authoritative\) AS CHAR\) AS lockedAmount/);
});

test('whatever order the database returns is passed through: groups are never re-sorted in JavaScript', async () => {
  const shuffled = [groupRows[2], groupRows[0], groupRows[1]];
  await withApp(fleet([totalsRow()], shuffled), async app => {
    const { data } = (await app.inject(breakdownUrl(fleetQuery))).json();
    assert.deepEqual(data.groups.map((group: { trailerId: number }) => group.trailerId), shuffled.map(group => group.trailerId));
  });
});

// --- 6. Fail closed -------------------------------------------------------------------

test('unlocked, unknown lock state, incomplete, inconsistent and malformed fleet reads are refused', async () => {
  const cases: [unknown, string][] = [
    [[totalsRow({ unlocked: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[totalsRow({ unknown: 1 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[totalsRow({ unknown: 14 })], 'PERIOD_NOT_FULLY_LOCKED'],
    [[totalsRow({ missingTotal: 1 })], 'INCOMPLETE_RESULT'],
    [[totalsRow({ total: null })], 'INCOMPLETE_RESULT'],
    [[totalsRow(), totalsRow({ deletedState: 'other' })], 'INCOMPLETE_RESULT'],
    [[totalsRow(), totalsRow()], 'INCOMPLETE_RESULT'],
    [[totalsRow({ deletedState: 'purged' })], 'INCOMPLETE_RESULT'],
    [[totalsRow({ attributedRecords: 50000 })], 'INCOMPLETE_RESULT'],
    [[{ ...totalsRow(), attributedRecords: 9 }], 'INCOMPLETE_RESULT'],
    [[{ ...totalsRow(), missing_taskRecords: 2 }], 'INCOMPLETE_RESULT'],
    [[{ ...totalsRow(), unattributedNonZeroRecords: 9 }], 'INCOMPLETE_RESULT'],
    [[{ ...totalsRow(), attributedTrailers: 0 }], 'INCOMPLETE_RESULT'],
    [[{ ...totalsRow(), lockedRecords: 13 }], 'INCOMPLETE_RESULT'],
    [[{ ...totalsRow(), unattributedTotal: undefined }], 'INCOMPLETE_RESULT'],
    [[null], 'INCOMPLETE_RESULT'],
    [null, 'INCOMPLETE_RESULT'],
    [[], 'NO_DATA_FOR_PERIOD'],
    [[totalsRow({ deletedState: 'one' })], 'NO_DATA_FOR_PERIOD'],
  ];
  for (const [rows, code] of cases) {
    await withApp(fleet(rows), async (app, calls) => {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(fleetQuery));
        assert.equal(response.statusCode, 422, code);
        assert.equal(response.json().error.code, code);
        assert.equal(Object.hasOwn(response.json(), 'data'), false);
      }
      assert.ok(calls.every(isTotals), 'Groups are never read after a refused totals read');
    });
  }
  // Groups that do not account for the attributed population of the totals read.
  const badGroups: unknown[] = [
    groupRows.slice(0, 2), [...groupRows, { trailerId: 900000004, taskCount: 1, lockedAmount: '1.00' }],
    [groupRows[0], groupRows[1], { ...groupRows[2], taskCount: 2 }], [groupRows[0], groupRows[1], groupRows[1]],
    [groupRows[0], groupRows[1], { ...groupRows[2], taskCount: 0 }], [groupRows[0], groupRows[1], null], null,
    Array.from({ length: trailerFleetMaxGroups + 1 }, (_, index) => ({ trailerId: index + 1, taskCount: 1, lockedAmount: '1.00' })),
  ];
  for (const groups of badGroups) {
    await withApp(fleet([totalsRow()], groups), async app => {
      const response = await app.inject(breakdownUrl(fleetQuery));
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
      assert.equal(Object.hasOwn(response.json(), 'data'), false);
    });
  }
});

test('lock state comes from the trailer lock date with the single-trailer rules, never from the truck lock date', () => {
  for (const statement of [trailerFleetTotalsStatement, trailerFleetGroupsStatement]) {
    assert.match(statement, /a\.locked_kastaiPriekabos AS authoritative, a\.locked_kastaiPriekabos_data AS lockDate/);
    assert.match(statement, /CASE WHEN s\.lockDate IS NULL THEN 'unknown'\s+WHEN CAST\(s\.lockDate AS CHAR\) = '0000-00-00' THEN 'unlocked'/);
    assert.match(statement, /THEN 'locked' ELSE 'unknown' END AS lockState/);
    assert.doesNotMatch(statement, /Vilkiko|vilkikai|uzdavinio_masina|_det\b|_det_locked|a\.kastaiPriekabos/, 'No truck, detail or current source');
  }
});

test('partial, multi-month and unsettled periods are refused before replica access', async () => {
  const current = new Date();
  const recentStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const recentEnd = new Date(Date.UTC(recentStart.getUTCFullYear(), recentStart.getUTCMonth() + 1, 0));
  const recent = `dateFrom=${recentStart.toISOString().slice(0, 10)}&dateTo=${recentEnd.toISOString().slice(0, 10)}`;
  await withApp(fleet(), async (app, calls) => {
    for (const [dates, code] of [
      ['dateFrom=2025-03-01&dateTo=2025-03-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['dateFrom=2025-03-02&dateTo=2025-03-31', 'PERIOD_NOT_COMPLETE_MONTH'],
      ['dateFrom=2025-03-01&dateTo=2025-04-30', 'PERIOD_NOT_COMPLETE_MONTH'],
      [recent, 'PERIOD_NOT_SETTLED'],
    ]) {
      for (const url of [summaryUrl, breakdownUrl]) {
        const response = await app.inject(url(`allocationScope=trailer&${dates}`));
        assert.equal(response.statusCode, 422, dates);
        assert.equal(response.json().error.code, code, dates);
      }
    }
    assert.equal((await app.inject(summaryUrl('allocationScope=trailer'))).statusCode, 400, 'Dates are required');
    assert.equal(calls.length, 0);
  });
});

test('authentication, timeouts, busy and driver errors keep the pilot behaviour', async () => {
  await withApp(fleet(), async (app, calls) => {
    assert.equal((await app.inject(summaryUrl(fleetQuery))).statusCode, 401);
    assert.equal((await app.inject({ url: summaryUrl(fleetQuery), headers: auth })).statusCode, 200);
    assert.equal(calls.length, 1);
  }, bothConfig, true);
  const failures: [Error, number, string][] = [
    [Object.assign(new Error('statement timeout'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }), 504, 'QUERY_TIMEOUT'],
    [Object.assign(new Error('connect ECONNREFUSED 10.0.0.1'), { code: 'ECONNREFUSED' }), 503, 'REPLICA_UNAVAILABLE'],
  ];
  for (const [failure, status, code] of failures) {
    // Fails on the totals read, and on the groups read after a valid totals read.
    for (const failing of [isTotals, isGroups]) {
      await withApp(call => { if (failing(call)) throw failure; return [totalsRow()]; }, async app => {
        const response = await app.inject(breakdownUrl(fleetQuery));
        assert.equal(response.statusCode, status);
        assert.equal(response.json().error.code, code);
        assert.doesNotMatch(response.body, /ECONNREFUSED|10\.0\.0\.1|statement timeout|priekab/);
      });
    }
  }
  // Every read goes through the analytics gate: a saturated gate answers SERVICE_BUSY without a query.
  const { pool, calls } = fakePool(fleet());
  const gate = new AnalyticsGate(1, 0, 10);
  let release = () => {};
  const held = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
  await setImmediate();
  for (const query of [queryTrailerFleetTotals, queryTrailerFleetGroups]) {
    await assert.rejects(query(pool, gate, '2025-03-01', trailerFixedCostPilotDeletedRowPolicy, now),
      (error: unknown) => (error as { code?: string }).code === 'SERVICE_BUSY');
  }
  assert.equal(calls.length, 0);
  release();
  await held;
});

test('telemetry names the fleet operation and carries no amount, identifier or row', async () => {
  const events: Record<string, unknown>[] = [];
  await withApp(fleet([totalsRow({ total: '7654.98' })]), async app => {
    app.addHook('onRequest', async request => {
      const capture = (event: Record<string, unknown>) => { events.push(event); };
      request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
    });
    await app.inject(summaryUrl(fleetQuery));
    await app.inject(breakdownUrl(fleetQuery));
  });
  assert.deepEqual(events.map(event => [event.operation, event.outcome]),
    [['fixed_cost.trailer_fleet_summary_pilot', 'success'], ['fixed_cost.trailer_fleet_breakdown_pilot', 'success']]);
  assert.doesNotMatch(JSON.stringify(events), /7654|1000\.10|99\.90|90000000|2025-03|priekab|kastai|SELECT/);
});

// --- 7. Deleted-row policy ----------------------------------------------------------------

test('the deleted-row policy is preserved: deleted = 1 never reaches an amount, count or group', async () => {
  const deleted = totalsRow({ deletedState: 'one', total: '99999.99', attributedTotal: '99999.99', unattributedTotal: '88888.88', attributedRecords: 40 });
  await withApp(fleet([deleted, totalsRow()]), async app => {
    const summary = (await app.inject(summaryUrl(fleetQuery))).json();
    assert.deepEqual(summary.data, {
      allocationScope: 'trailer', periodMonth: '2025-03-01', currency: 'EUR', representation: 'locked',
      totalTaskCount: 14, lockedTaskCount: 14, ...expectedAttribution,
    });
    const breakdown = (await app.inject(breakdownUrl(fleetQuery))).json();
    assert.doesNotMatch(JSON.stringify(breakdown), /99999|88888/);
    assert.deepEqual(breakdown.meta.deletedRowPolicy, { ...trailerFixedCostPilotDeletedRowPolicy });
  });
  // States are separated by the same declared-state expression as every other fixed-cost read.
  for (const statement of [trailerFleetTotalsStatement, trailerFleetGroupsStatement]) {
    assert.match(statement, /CASE WHEN s\.deleted = 0 THEN 'zero' WHEN s\.deleted = 1 THEN 'one' ELSE 'other' END AS deletedState/);
  }
  assert.match(trailerFleetTotalsStatement, /GROUP BY r\.deletedState\s+ORDER BY r\.deletedState$/);
  assert.match(trailerFleetGroupsStatement, /WHERE r\.deletedState = 'zero' AND r\.attribution = 'attributed'/);

  // The repository refuses to run without an approved policy, before any replica access.
  const { pool, calls } = fakePool(fleet());
  const gate = new AnalyticsGate(1, 1, 100);
  await assert.rejects(queryTrailerFleetTotals(pool, gate, '2025-03-01', undefined, now), FixedCostDeletedPolicyUnapproved);
  await assert.rejects(queryTrailerFleetGroups(pool, gate, '2025-03-01', undefined, now), FixedCostDeletedPolicyUnapproved);
  // The groups statement hard-codes deleted = 0, so no other approved treatment may use it.
  await assert.rejects(queryTrailerFleetGroups(pool, gate, '2025-03-01',
    { ...trailerFixedCostPilotDeletedRowPolicy, treatment: 'include_all' }, now), FixedCostDeletedPolicyUnapproved);
  assert.equal(calls.length, 0);
});

// --- 8, 9. Existing behaviour ----------------------------------------------------------

test('truck statements are byte-identical to before and single-trailer statements differ only by the trailer master check', () => {
  // SHA-256 of every single-trailer statement variant, including the priekabos master check. The
  // truck hashes are the ones recorded before any trailer support.
  const expected: Record<string, string> = {
    'trailer current plain': '847e268848e67868d1390a48639de1103b379f0d5fd2a8ee330fed15a49daa13',
    'trailer current components': '7bb0a35ac7fb797f226a4a32f4e70334d3610ab4a3f801ccf38f4bd1e6b43b19',
    'trailer locked plain': 'e58de009367dcb76a8b0faae7a1c5e6e0b9f4de0c681ebb6f7c88a567a5efc23',
    'trailer locked components': 'c9313a0266746abd35ad065868b051c465e915e634087d1a30ffd1119ea51baf',
    'truck locked fleet plain': '8e3c6d86dfd1a7f7782fbb68aeb7923b19905ca5eff75cd8641627d6061031d5',
    'truck locked one components': '15b0067deb69fd64b1c30f0933883e5db758f388b1791722dc519c4d90e396af',
  };
  const hash = (statement: string) => createHash('sha256').update(statement).digest('hex');
  const base = { periodMonth: '2025-03-01', periodEnd: '2025-04-01', limit: 50000 };
  for (const representation of ['current', 'locked'] as const) {
    for (const includeComponents of [undefined, true as const]) {
      const name = `trailer ${representation} ${includeComponents ? 'components' : 'plain'}`;
      assert.equal(hash(fixedCostMonetaryStatement({
        ...base, allocationScope: 'trailer', representation, trailerId: 1, ...(includeComponents ? { includeComponents } : {}),
      })), expected[name], name);
    }
  }
  assert.equal(hash(fixedCostMonetaryStatement({ ...base, allocationScope: 'truck', representation: 'locked' })), expected['truck locked fleet plain']);
  assert.equal(hash(fixedCostMonetaryStatement({ ...base, allocationScope: 'truck', representation: 'locked', truckIds: [7], includeComponents: true })),
    expected['truck locked one components']);
  // The only change to the single-trailer statement is one static master-existence predicate
  // directly after the bound trailer predicate; the truck statement has no such predicate.
  const masterCheck = '\n        AND EXISTS (SELECT 1 FROM priekabos p WHERE p.id = t.uzdavinio_priekaba)';
  for (const representation of ['current', 'locked'] as const) {
    const trailer = fixedCostMonetaryStatement({ ...base, allocationScope: 'trailer', representation, trailerId: 1 });
    assert.equal(trailer.split(masterCheck).length, 2, 'Exactly one master check');
    assert.ok(trailer.includes(`AND t.uzdavinio_priekaba IN (?)${masterCheck}\n        ORDER BY a.uzdavinys`));
    assert.equal(trailer.split('?').length - 1, 3, 'Still two period markers and one trailer marker');
    for (const truckIds of [undefined, [7]]) {
      assert.doesNotMatch(fixedCostMonetaryStatement({ ...base, allocationScope: 'truck', representation, ...(truckIds ? { truckIds } : {}) }), /EXISTS|priekab/i);
    }
  }
  // The shared monetary query still has no fleet trailer form: that read exists only as the fleet statements.
  assert.throws(() => parseFixedCostMonetaryQuery({ allocationScope: 'trailer', representation: 'locked', periodMonth: '2025-03-01' }, now),
    InvalidFixedCostMonetaryQuery);
});

test('single-trailer and truck requests never run a fleet trailer statement and keep their responses', async () => {
  const trailerQuery = `allocationScope=trailer&trailerId=987654321&${period}`;
  await withApp(() => [monetaryRow(fixedCostTrailerComponentFields)], async (app, calls) => {
    const summary = await app.inject(summaryUrl(trailerQuery));
    const breakdown = await app.inject(breakdownUrl(trailerQuery));
    assert.equal(summary.statusCode, 200);
    assert.equal(breakdown.statusCode, 200);
    assert.deepEqual(summary.json().data, {
      allocationScope: 'trailer', trailerId: 987654321, periodMonth: '2025-03-01', amount: '4321.10', currency: 'EUR',
      representation: 'locked', totalTaskCount: 3, lockedTaskCount: 3,
    });
    assert.equal(summary.json().meta.semanticsVersion, 'trailer-fixed-cost-summary-pilot-v1');
    assert.deepEqual(Object.keys(breakdown.json().data), ['allocationScope', 'dateFrom', 'dateTo', 'currency', 'groups']);
    assert.deepEqual(Object.keys(breakdown.json().data.groups[0]), ['trailerId', 'currentAmount', 'lockedAmount', 'taskCount', 'lockStates', 'reconciliation']);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.deepEqual(call.values, [...periodValues, 987654321]);
      assert.ok(!isTotals(call) && !isGroups(call));
      assert.doesNotMatch(call.sql, /LEFT JOIN priekabos|attribution/);
    }
  });
  await withApp(() => [monetaryRow(fixedCostComponentFields)], async (app, calls) => {
    const truckFleet = await app.inject(summaryUrl(`allocationScope=truck&${period}`));
    const single = await app.inject(summaryUrl(`allocationScope=truck&truckId=12345&${period}`));
    const breakdown = await app.inject(breakdownUrl(`allocationScope=truck&truckId=12345&${period}`));
    for (const response of [truckFleet, single, breakdown]) assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(truckFleet.json().data), ['allocationScope', 'periodMonth', 'amount', 'currency', 'representation', 'totalTaskCount', 'lockedTaskCount']);
    assert.equal(truckFleet.json().meta.semanticsVersion, 'truck-fixed-cost-summary-pilot-v1');
    assert.equal(single.json().data.truckId, 12345);
    // The fleet-wide truck breakdown stays refused.
    assert.equal((await app.inject(breakdownUrl(`allocationScope=truck&${period}`))).statusCode, 422);
    assert.equal(calls.length, 4);
    for (const call of calls) assert.doesNotMatch(call.sql, /priekab|attribution/i, 'A truck request never reads a trailer source');
  });
});

test('a trailerId absent from the trailer master is refused as NO_DATA_FOR_PERIOD, consistent with fleet invalidMasterId', async () => {
  // The master check makes such an identifier match no summary row, so the replica answers with
  // no groups. That is refused; it is never a zero amount and never remapped to another trailer.
  const invalidTrailerQuery = `allocationScope=trailer&trailerId=987654321&${period}`;
  await withApp(() => [], async (app, calls) => {
    for (const url of [summaryUrl, breakdownUrl]) {
      const response = await app.inject(url(invalidTrailerQuery));
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), { error: { code: 'NO_DATA_FOR_PERIOD',
        message: 'No included fixed-cost records exist for the selected month; absence of records is not reported as a zero amount.' } });
    }
    assert.equal(calls.length, 2, 'The breakdown stops at its first empty read');
    for (const call of calls) {
      assert.match(call.sql, /AND t\.uzdavinio_priekaba IN \(\?\)\s+AND EXISTS \(SELECT 1 FROM priekabos p WHERE p\.id = t\.uzdavinio_priekaba\)/);
      assert.deepEqual(call.values, [...periodValues, 987654321], 'The requested identifier is bound unchanged');
    }
  });
  // Fleet mode classifies the same condition with the same master table and key.
  assert.match(trailerFleetTotalsStatement, /LEFT JOIN priekabos p ON p\.id = t\.uzdavinio_priekaba/);
  assert.match(trailerFleetTotalsStatement, /WHEN s\.masterTrailer IS NULL THEN 'invalid_master_id'/);
});

// --- 12. Static, allowlisted, parameterized SQL ---------------------------------------------

test('fleet SQL is two static read-only statements whose only bound values are the period', async () => {
  for (const statement of [trailerFleetTotalsStatement, trailerFleetGroupsStatement]) {
    assert.match(statement, /^SELECT /);
    assert.equal(statement.split('?').length - 1, 2, 'Exactly the two period markers');
    assert.match(statement, /WHERE a\.kastai_data >= \? AND a\.kastai_data < \?\s+ORDER BY a\.uzdavinys\s+LIMIT 50001/);
    assert.doesNotMatch(statement, /;|\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE|GRANT|CALL|INTO|SLEEP|BENCHMARK)\b|undefined|\[object|\$\{|2025/i);
    // Only the three allowlisted tables are read; both joins are on a primary key.
    assert.deepEqual([...statement.matchAll(/(?:FROM|JOIN) ([a-z_]+) [atp]\b/g)].map(match => match[1]),
      ['kastai_fiksuoti_ataskaita', 'uzdaviniai', 'priekabos']);
    assert.match(statement, /LEFT JOIN priekabos p ON p\.id = t\.uzdavinio_priekaba/);
  }
  // The statement text is the same for every request: nothing from a request reaches it.
  const seen = new Set<string>();
  await withApp(fleet(), async (app, calls) => {
    await app.inject(breakdownUrl(fleetQuery));
    await app.inject(breakdownUrl('allocationScope=trailer&dateFrom=2025-11-01&dateTo=2025-11-30'));
    await app.inject(summaryUrl('allocationScope=trailer&dateFrom=2024-02-01&dateTo=2024-02-29'));
    assert.deepEqual(calls.map(call => call.values), [
      periodValues, periodValues, ['2025-11-01', '2025-12-01'], ['2025-11-01', '2025-12-01'], ['2024-02-01', '2024-03-01'],
    ]);
    for (const call of calls) seen.add(call.sql);
  });
  assert.deepEqual([...seen], [trailerFleetTotalsStatement, trailerFleetGroupsStatement]);

  // The repository accepts only a canonical settled month; nothing else is an input.
  const { pool, calls } = fakePool(fleet());
  const gate = new AnalyticsGate(1, 1, 100);
  for (const month of ['2025-03', '2025-03-02', "2025-03-01' OR '1'='1", '2026-09-01', 20250301, null, undefined, ['2025-03-01'], {}]) {
    await assert.rejects(queryTrailerFleetTotals(pool, gate, month, trailerFixedCostPilotDeletedRowPolicy, now), InvalidFixedCostMonetaryQuery);
    await assert.rejects(queryTrailerFleetGroups(pool, gate, month, trailerFixedCostPilotDeletedRowPolicy, now), InvalidFixedCostMonetaryQuery);
  }
  assert.equal(calls.length, 0);
});

test('the fleet request accepts no grouping, sorting, paging, selector list or representation input', async () => {
  await withApp(fleet(), async (app, calls) => {
    for (const url of [summaryUrl, breakdownUrl]) {
      for (const extra of ['groupBy=trailer', 'sortBy=lockedAmount', 'sortDirection=asc', 'page=2', 'perPage=10', 'limit=5', 'trailerIds=1,2',
        'representation=current', 'includeUnattributed=false', 'plateNumber=AB123', 'trailerId=', 'trailerId=0', 'dateFrom=2025-03-01',
        "orderBy=1;DROP%20TABLE%20priekabos"]) {
        const response = await app.inject(url(`${fleetQuery}&${extra}`));
        assert.equal(response.statusCode, 400, extra);
        assert.equal(response.json().error.code, 'INVALID_QUERY', extra);
      }
      // A truck selector never resolves a trailer read.
      assert.equal((await app.inject(url(`${fleetQuery}&truckId=12345`))).statusCode, 422);
    }
    assert.equal((await app.inject(`/expense-analytics/fixed-costs/dimensions?${fleetQuery}`)).statusCode, 422, 'dimensions stays disabled');
    assert.equal(calls.length, 0);
  });
});
