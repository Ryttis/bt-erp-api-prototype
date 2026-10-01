import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { fixedCostMonetaryStatement } from '../../src/fixed-costs/monetary-repository.js';
import { parseFixedCostMonetaryQuery } from '../../src/fixed-costs/monetary-contract.js';
import {
  parseTrailerAvailablePeriodsRequest, runTrailerAvailablePeriods, trailerAvailablePeriodCandidateMonths,
} from '../../src/fixed-costs/pilot-trailer-available-periods.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';
import { trailerAvailablePeriodsStatement } from '../../src/fixed-costs/trailer-available-periods-repository.js';

const baseEnvironment = {
  ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
  ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
};
const bothConfig = loadConfig({ ...baseEnvironment, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'true', ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'true' });
const truckOnlyConfig = loadConfig({ ...baseEnvironment, ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED: 'true' });
const now = new Date('2026-09-30T10:00:00Z');

// Synthetic identifiers, distinctive enough to detect interpolation. Not real trailers.
const trailerId = 987654321;
const noMasterTrailerId = 876543219;
const otherTrailerId = 765432198;
const availableUrl = (query: string) => `/expense-analytics/fixed-costs/available-periods?${query}`;
const trailerQuery = (year = '2025', id = trailerId) => `allocationScope=trailer&trailerId=${id}&year=${year}`;
const invalidQueryBody = { error: { code: 'INVALID_QUERY', message: 'Invalid fixed-cost query' } };

// --- In-memory source rows and a fake replica answering both statements ---------

type LockState = 'locked' | 'unlocked' | 'unknown';

/** One `kastai_fiksuoti_ataskaita` row as the trailer statements see it. */
interface SourceRow {
  month: string;
  trailer: number;
  /** Whether the task-trailer identifier exists in priekabos. */
  master?: boolean;
  /** Whether the uzdaviniai row exists. */
  task?: boolean;
  deleted?: number | null;
  lock?: LockState;
  /** Stored locked total in cents; null is a missing stored total. */
  cents?: number | null;
}

const decimal = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const stateOf = (row: SourceRow) => row.deleted === 0 || row.deleted === undefined ? 'zero' : row.deleted === 1 ? 'one' : 'other';

/** The population both statements share: period bounds, task trailer and trailer master. */
const population = (rows: readonly SourceRow[], from: string, to: string, id: number) => rows.filter(row =>
  row.month >= from && row.month < to && (row.task ?? true) && row.trailer === id && (row.master ?? true));

function stateCounters(rows: readonly SourceRow[]) {
  const totals = rows.map(row => row.cents === undefined ? 1000 : row.cents);
  const present = totals.filter((value): value is number => value !== null);
  return {
    authoritativeRecords: rows.length,
    authoritativeTotal: present.length === 0 ? null : decimal(present.reduce((sum, value) => sum + value, 0)),
    missingTotalRecords: totals.length - present.length,
    lockedRecords: rows.filter(row => (row.lock ?? 'locked') === 'locked').length,
    unlockedRecords: rows.filter(row => row.lock === 'unlocked').length,
    unknownLockRecords: rows.filter(row => row.lock === 'unknown').length,
  };
}

const byState = (rows: readonly SourceRow[]) => (['one', 'other', 'zero'] as const)
  .map(state => [state, rows.filter(row => stateOf(row) === state)] as const)
  .filter(([, members]) => members.length > 0);

/** The monthly summary statement's driver rows: every member has exactly one detail row. */
function summaryRows(rows: readonly SourceRow[]) {
  return byState(rows).map(([deletedState, members]) => {
    const counters = stateCounters(members);
    const comparable = counters.authoritativeRecords - counters.missingTotalRecords;
    const comparableTotal = comparable > 0 ? counters.authoritativeTotal : null;
    return {
      deletedState, ...counters,
      comparableRecords: comparable, comparableAuthoritativeTotal: comparableTotal, componentTotal: comparableTotal,
      netDifference: comparable > 0 ? '0.00' : null, grossAbsoluteDifference: comparable > 0 ? '0.00' : null,
      affectedRecords: 0,
      ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`, name === 'exact' ? comparable : 0])),
      noDetailRecords: 0, multipleDetailRecords: 0, missingTaskCount: 0,
    };
  });
}

/** The available-periods statement's driver rows, ordered by month then state. */
function availableRows(rows: readonly SourceRow[]) {
  const months = [...new Set(rows.map(row => row.month))].sort();
  return months.flatMap(month => byState(rows.filter(row => row.month === month))
    .map(([deletedState, members]) => ({ periodMonth: month, deletedState, ...stateCounters(members) })));
}

type Call = { sql: string; values: unknown[] };

function fixturePool(rows: readonly SourceRow[]) {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      await setImmediate();
      const [from, to, id] = values as [string, string, number];
      const selected = population(rows, from, to, id);
      if (sql === trailerAvailablePeriodsStatement) return availableRows(selected);
      if (/FROM kastai_fiksuoti_ataskaita a/.test(sql) && /a\.locked_kastaiPriekabos,/.test(sql)) return summaryRows(selected);
      throw new Error('Unexpected statement');
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls };
}

async function withApp<T>(rows: readonly SourceRow[], body: (app: ReturnType<typeof buildApp>, calls: Call[]) => Promise<T>, config = bothConfig) {
  const { pool, calls } = fixturePool(rows);
  const app = buildApp(config, () => pool, { authenticate: false });
  try { return await body(app, calls); } finally { await app.close(); }
}

const gate = () => new AnalyticsGate(3, 6, 1000);
const run = (rows: readonly SourceRow[], year = 2025, id = trailerId, at = now) => {
  const fixture = fixturePool(rows);
  return runTrailerAvailablePeriods(fixture.pool, gate(), { allocationScope: 'trailer', trailerId: id, year }, at)
    .then(result => ({ result, calls: fixture.calls }));
};

const month = (value: string) => `${value}-01`;
const lastDay = (value: string) => {
  const [year, monthNumber] = value.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
};

/**
 * A year of mixed months for one trailer. Each comment states the summary outcome
 * the existing single-trailer pilot gives that month.
 */
const mixedYear: SourceRow[] = [
  // 2025-02: two locked tasks → 200
  { month: month('2025-02'), trailer: trailerId }, { month: month('2025-02'), trailer: trailerId, cents: 0 },
  // 2025-03: deleted-only → NO_DATA_FOR_PERIOD
  { month: month('2025-03'), trailer: trailerId, deleted: 1 },
  // 2025-04: one unlocked included task → PERIOD_NOT_FULLY_LOCKED
  { month: month('2025-04'), trailer: trailerId }, { month: month('2025-04'), trailer: trailerId, lock: 'unlocked' },
  // 2025-05: unknown lock state → PERIOD_NOT_FULLY_LOCKED
  { month: month('2025-05'), trailer: trailerId, lock: 'unknown' },
  // 2025-06: included missing stored total → INCOMPLETE_RESULT
  { month: month('2025-06'), trailer: trailerId, cents: null },
  // 2025-07: undeclared deleted state next to a valid row → INCOMPLETE_RESULT
  { month: month('2025-07'), trailer: trailerId }, { month: month('2025-07'), trailer: trailerId, deleted: null },
  // 2025-08: locked included row plus an unlocked deleted row → 200 (deleted rows never decide lock state)
  { month: month('2025-08'), trailer: trailerId }, { month: month('2025-08'), trailer: trailerId, deleted: 1, lock: 'unlocked' },
  // 2025-09: only another trailer and an orphan task → NO_DATA_FOR_PERIOD for this trailer
  { month: month('2025-09'), trailer: otherTrailerId }, { month: month('2025-09'), trailer: trailerId, task: false },
  // 2025-10 .. 2025-12: three locked months, the first with many duplicate-looking rows → 200
  ...Array.from({ length: 5 }, () => ({ month: month('2025-10'), trailer: trailerId })),
  { month: month('2025-11'), trailer: trailerId, cents: -250 },
  { month: month('2025-12'), trailer: trailerId },
  // Neighbouring years are outside the read.
  { month: month('2024-12'), trailer: trailerId }, { month: month('2026-01'), trailer: trailerId },
  // A trailer number with no priekabos row: every month would otherwise be valid.
  { month: month('2025-02'), trailer: noMasterTrailerId, master: false },
  { month: month('2025-10'), trailer: noMasterTrailerId, master: false },
];
const mixedYearAvailable = ['2025-02', '2025-08', '2025-10', '2025-11', '2025-12'];

// --- Contract and SQL ------------------------------------------------------------

test('one trailer with multiple available months: exact response shape, one read, ascending unique months', async () => {
  await withApp(mixedYear, async (app, calls) => {
    const response = await app.inject(availableUrl(trailerQuery()));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: { allocationScope: 'trailer', trailerId, year: 2025, availableMonths: mixedYearAvailable },
      meta: { sourceFamily: 'trailer_fixed_costs', semanticsVersion: 'trailer-fixed-cost-available-periods-pilot-v1', pilot: true },
    });
    assert.equal(calls.length, 1, 'One deterministic read for the whole year, never one per month');
    assert.deepEqual(calls[0].values, ['2025-01-01', '2026-01-01', trailerId]);
  });
});

test('the statement is static, parameterized and reads the summary population with the summary predicates', () => {
  const sql = trailerAvailablePeriodsStatement;
  assert.equal(sql.split('?').length - 1, 3, 'Two period markers and one trailer marker');
  assert.doesNotMatch(sql, /[0-9]{5,}/, 'No identifier is interpolated');
  const summary = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(
    { allocationScope: 'trailer', representation: 'locked', periodMonth: '2025-03-01', trailerId, limit: 50000 }, now));
  // Every population predicate of the monthly single-trailer summary appears verbatim.
  for (const fragment of [
    'FROM kastai_fiksuoti_ataskaita a',
    'LEFT JOIN uzdaviniai t ON t.id = a.uzdavinys',
    'WHERE a.kastai_data >= ? AND a.kastai_data < ?',
    'AND t.uzdavinio_priekaba IN (?)',
    'AND EXISTS (SELECT 1 FROM priekabos p WHERE p.id = t.uzdavinio_priekaba)',
    "CASE WHEN j.deleted = 0 THEN 'zero' WHEN j.deleted = 1 THEN 'one' ELSE 'other' END".replaceAll('j.', 's.'),
    "WHEN CAST(s.lockDate AS CHAR) = '0000-00-00' THEN 'unlocked'",
  ]) {
    assert.ok(sql.includes(fragment), fragment);
    assert.ok(summary.replaceAll('j.', 's.').includes(fragment), `summary: ${fragment}`);
  }
  assert.match(sql, /a\.locked_kastaiPriekabos AS authoritative,\s+a\.locked_kastaiPriekabos_data AS lockDate/);
  assert.match(sql, /GROUP BY r\.periodMonth, r\.deletedState\s+ORDER BY r\.periodMonth, r\.deletedState$/);
  assert.doesNotMatch(sql, /Vilkiko|vilkikai|uzdavinio_masina|(?<!locked_)kastaiPriekabos\b|_det|uzd_pr_vaziavo|INSERT|UPDATE|DELETE/,
    'No truck source, no current amount, no detail table and no write');
});

test('an empty year is [] and not an error', async () => {
  for (const rows of [[], [{ month: month('2024-05'), trailer: trailerId }]]) {
    await withApp(rows, async (app, calls) => {
      const response = await app.inject(availableUrl(trailerQuery()));
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data.availableMonths, []);
      assert.equal(calls.length, 1);
    });
  }
});

test('a year without any settled month is [] with zero replica access', async () => {
  // On 2026-03-15 the latest settled month is 2025-09, so no month of 2026 is settled.
  const { result, calls } = await run([{ month: month('2026-01'), trailer: trailerId }], 2026, trailerId, new Date('2026-03-15T00:00:00Z'));
  assert.deepEqual(result.data.availableMonths, []);
  assert.equal(calls.length, 0);
});

test('the current year reads only its settled months, using the summary period rule', async () => {
  assert.deepEqual(trailerAvailablePeriodCandidateMonths(2026, now), ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.equal(trailerAvailablePeriodCandidateMonths(2025, now).length, 12);
  const rows = ['2026-01', '2026-03', '2026-04', '2026-06'].map(value => ({ month: month(value), trailer: trailerId }));
  const { result, calls } = await run(rows, 2026);
  assert.deepEqual(result.data.availableMonths, ['2026-01', '2026-03']);
  assert.deepEqual(calls[0].values, ['2026-01-01', '2026-04-01', trailerId], 'Unsettled months are never read');
});

test('months are ascending and unique whatever the driver row order or duplication', async () => {
  const rows = [
    { periodMonth: '2025-12-01', deletedState: 'zero', authoritativeRecords: 3, authoritativeTotal: '3.00', missingTotalRecords: 0, lockedRecords: 3, unlockedRecords: 0, unknownLockRecords: 0 },
    { periodMonth: '2025-01-01', deletedState: 'one', authoritativeRecords: 2, authoritativeTotal: '2.00', missingTotalRecords: 0, lockedRecords: 0, unlockedRecords: 2, unknownLockRecords: 0 },
    { periodMonth: '2025-01-01', deletedState: 'zero', authoritativeRecords: 7, authoritativeTotal: '7.00', missingTotalRecords: 0, lockedRecords: 7, unlockedRecords: 0, unknownLockRecords: 0 },
    { periodMonth: '2025-06-01', deletedState: 'zero', authoritativeRecords: 1, authoritativeTotal: '1.00', missingTotalRecords: 0, lockedRecords: 1, unlockedRecords: 0, unknownLockRecords: 0 },
  ];
  const pool = { query: async () => rows, end: async () => {} } as unknown as ReplicaPool;
  const result = await runTrailerAvailablePeriods(pool, gate(), { allocationScope: 'trailer', trailerId, year: 2025 }, now);
  assert.deepEqual(result.data.availableMonths, ['2025-01', '2025-06', '2025-12']);

  // Many source rows in one month (duplicate-looking rows) still yield the month once.
  const duplicated = Array.from({ length: 40 }, () => ({ month: month('2025-04'), trailer: trailerId }));
  assert.deepEqual((await run(duplicated)).result.data.availableMonths, ['2025-04']);
});

test('excluded months: deleted-only, unlocked, unknown lock, missing total, undeclared state, invalid master, orphan', async () => {
  const { result } = await run(mixedYear);
  for (const excluded of ['2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-09']) {
    assert.ok(!result.data.availableMonths.includes(excluded), excluded);
  }
  // A trailer number without a priekabos row has no available month at all.
  assert.deepEqual((await run(mixedYear, 2025, noMasterTrailerId)).result.data.availableMonths, []);
});

test('a month above the monthly record bound is excluded, as the summary refuses it as truncated', async () => {
  const counters = (records: number) => ({
    deletedState: 'zero', authoritativeRecords: records, authoritativeTotal: '1.00', missingTotalRecords: 0,
    lockedRecords: records, unlockedRecords: 0, unknownLockRecords: 0,
  });
  const rows = [
    { periodMonth: '2025-01-01', ...counters(50000) },
    { periodMonth: '2025-02-01', ...counters(49999) }, { periodMonth: '2025-02-01', ...counters(2), deletedState: 'one' },
  ];
  const pool = { query: async () => rows, end: async () => {} } as unknown as ReplicaPool;
  const result = await runTrailerAvailablePeriods(pool, gate(), { allocationScope: 'trailer', trailerId, year: 2025 }, now);
  assert.deepEqual(result.data.availableMonths, ['2025-01'], 'The bound counts every declared state, as the monthly LIMIT does');
});

test('malformed driver output fails the whole request closed as INCOMPLETE_RESULT', async () => {
  const valid = { periodMonth: '2025-01-01', deletedState: 'zero', authoritativeRecords: 1, authoritativeTotal: '1.00', missingTotalRecords: 0, lockedRecords: 1, unlockedRecords: 0, unknownLockRecords: 0 };
  const cases: unknown[] = [
    null, [null], [{ ...valid, periodMonth: '2024-12-01' }], [{ ...valid, periodMonth: '2025-01' }],
    [{ ...valid, deletedState: 'maybe' }], [valid, valid], [{ ...valid, lockedRecords: 0 }],
    [{ ...valid, authoritativeTotal: null }], [{ ...valid, authoritativeTotal: 1 }], [{ ...valid, missingTotalRecords: 2 }],
    [{ ...valid, authoritativeRecords: -1 }],
    Array.from({ length: 37 }, (_, index) => ({ ...valid, periodMonth: `2025-${String((index % 12) + 1).padStart(2, '0')}-01` })),
  ];
  for (const rows of cases) {
    const pool = { query: async () => rows, end: async () => {} } as unknown as ReplicaPool;
    const app = buildApp(bothConfig, () => pool, { authenticate: false });
    try {
      const response = await app.inject(availableUrl(trailerQuery()));
      assert.equal(response.statusCode, 422, JSON.stringify(rows));
      assert.equal(response.json().error.code, 'INCOMPLETE_RESULT');
      assert.equal(Object.hasOwn(response.json(), 'data'), false);
    } finally { await app.close(); }
  }
});

test('replica failures map exactly as the summary pilot maps them', async () => {
  const failing = (error: unknown) => ({ query: async () => { throw error; }, end: async () => {} }) as unknown as ReplicaPool;
  const cases: [unknown, number, string][] = [
    [Object.assign(new Error('timeout'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }), 504, 'QUERY_TIMEOUT'],
    [Object.assign(new Error('down'), { code: 'ECONNREFUSED' }), 503, 'REPLICA_UNAVAILABLE'],
  ];
  for (const [error, status, code] of cases) {
    const app = buildApp(bothConfig, () => failing(error), { authenticate: false });
    try {
      const response = await app.inject(availableUrl(trailerQuery()));
      assert.equal(response.statusCode, status, code);
      assert.equal(response.json().error.code, code);
    } finally { await app.close(); }
  }
});

// --- Validation and gating ---------------------------------------------------------

test('invalid trailerId, year, scope and parameters fail with 400 INVALID_QUERY before replica access', async () => {
  for (const config of [bothConfig, truckOnlyConfig]) {
    await withApp(mixedYear, async (app, calls) => {
      const rejected: string[] = [
        // trailerId
        'allocationScope=trailer&year=2025',
        ...['', '0', '00', '-1', '+5', '05', '1.5', '1.0', '1e3', '0x10', 'abc', '%205', '9007199254740992', '1%20OR%201=1', 'AI376', '1,2']
          .map(value => `allocationScope=trailer&trailerId=${value}&year=2025`),
        // year
        `allocationScope=trailer&trailerId=${trailerId}`,
        ...['', '25', '02025', '2025.0', '2025-01', '-2025', '+2025', 'abcd', '1999', '0999', '3000', '9999', '2025%20', '2025,2024']
          .map(value => `allocationScope=trailer&trailerId=${trailerId}&year=${value}`),
        // scope
        `trailerId=${trailerId}&year=2025`,
        ...['truck', 'department', 'TRAILER', 'trailers', ''].map(scope => `allocationScope=${scope}&trailerId=${trailerId}&year=2025`),
        // repeated and unknown parameters, incompatible selectors
        `${trailerQuery()}&year=2024`, `${trailerQuery()}&trailerId=1`, `${trailerQuery()}&allocationScope=trailer`,
        ...['truckId=1', 'trailerIds=1', 'trailerId[]=1', 'month=2025-01', 'dateFrom=2025-01-01&dateTo=2025-01-31',
          'representation=current', 'plateNumber=AI376', 'limit=5', 'sort=asc'].map(extra => `${trailerQuery()}&${extra}`),
      ];
      for (const query of rejected) {
        const response = await app.inject(availableUrl(query));
        assert.equal(response.statusCode, 400, query);
        assert.deepEqual(response.json(), invalidQueryBody, query);
      }
      assert.equal(calls.length, 0, 'Validation runs before any replica access');
    }, config);
  }
});

test('year bounds: 2000 through the current UTC year are accepted', () => {
  const parse = (year: string, at = now) => parseTrailerAvailablePeriodsRequest({ allocationScope: 'trailer', trailerId: '7', year }, at);
  assert.deepEqual(parse('2000'), { allocationScope: 'trailer', trailerId: 7, year: 2000 });
  assert.equal(parse('2026').year, 2026);
  assert.throws(() => parse('1999'));
  assert.throws(() => parse('2027'));
  assert.equal(parse('2027', new Date('2027-01-01T00:00:00Z')).year, 2027);
});

test('flag off: a valid request is 422 SEMANTICS_UNVERIFIED with zero replica access', async () => {
  await withApp(mixedYear, async (app, calls) => {
    const response = await app.inject(availableUrl(trailerQuery()));
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
    assert.equal(calls.length, 0);
  }, truckOnlyConfig);
});

test('authentication is still required', async () => {
  const { pool, calls } = fixturePool(mixedYear);
  const app = buildApp(bothConfig, () => pool);
  try {
    assert.equal((await app.inject(availableUrl(trailerQuery()))).statusCode, 401);
    const headers = { authorization: `Bearer ${bothConfig.auth.serviceToken}` };
    assert.equal((await app.inject({ method: 'POST', url: availableUrl(trailerQuery()), headers })).statusCode, 404, 'GET only');
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('telemetry names the operation and carries no identifier, month or row', async () => {
  const events: unknown[] = [];
  await withApp(mixedYear, async app => {
    app.addHook('onRequest', async request => {
      const capture = (event: unknown) => { events.push(event); };
      request.log = Object.assign(Object.create(request.log), { info: capture, warn: capture });
    });
    await app.inject(availableUrl(trailerQuery()));
  });
  const event = events.find(entry => (entry as Record<string, unknown>)?.operation === 'fixed_cost.trailer_available_periods_pilot') as Record<string, unknown>;
  assert.ok(event);
  assert.equal(event.outcome, 'success');
  assert.equal(event.month_count, mixedYearAvailable.length);
  assert.equal(event.endpoint, '/expense-analytics/fixed-costs/available-periods');
  const text = JSON.stringify(events);
  assert.ok(!text.includes(String(trailerId)) && !text.includes('2025-'), 'No identifier or month in telemetry');
});

// --- Cross-check against the existing single-trailer summary ------------------------

test('cross-check: month in availableMonths <=> the single-trailer summary for that month returns data', async () => {
  const fixtures: [string, SourceRow[], number][] = [
    ['mixed year', mixedYear, trailerId],
    ['invalid master trailer', mixedYear, noMasterTrailerId],
    ['other trailer', mixedYear, otherTrailerId],
    ['empty', [], trailerId],
    ['all months locked', Array.from({ length: 12 }, (_, index) => ({ month: `2025-${String(index + 1).padStart(2, '0')}-01`, trailer: trailerId })), trailerId],
  ];
  for (const [name, rows, id] of fixtures) {
    await withApp(rows, async app => {
      const available = (await app.inject(availableUrl(trailerQuery('2025', id)))).json().data.availableMonths as string[];
      const summaryEligible: string[] = [];
      for (let index = 1; index <= 12; index += 1) {
        const value = `2025-${String(index).padStart(2, '0')}`;
        const response = await app.inject(`/expense-analytics/fixed-costs/summary?allocationScope=trailer&trailerId=${id}&dateFrom=${month(value)}&dateTo=${lastDay(value)}`);
        assert.ok(response.statusCode === 200 || response.statusCode === 422, `${name} ${value}: ${response.statusCode}`);
        if (response.statusCode === 200) summaryEligible.push(value);
      }
      assert.deepEqual(available, summaryEligible, name);
    });
  }
});
