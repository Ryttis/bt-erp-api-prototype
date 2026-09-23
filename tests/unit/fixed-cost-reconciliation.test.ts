import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes } from '../../src/fixed-costs/contracts.js';
import {
  aggregateFixedCostDifferences, classifyFixedCostDifferenceCents, combineFixedCostDifferenceCounts,
  describeFixedCostDifferences, emptyFixedCostDifferenceCounts, eurStringToCents, fixedCostDifferenceBuckets,
  fixedCostDifferenceLadder, fixedCostDifferenceNonComparable, fixedCostPeriodKey, fixedCostReconciliationCategories,
  fixedCostReconciliationSettlementMonths, fixedCostReconciliationTaskLimit, fixedCostReconciliationToleranceEur,
  InvalidFixedCostReconciliationMonth, parseFixedCostReconciliationMonth, percentageOf,
  type FixedCostDifferenceCounts,
} from '../../src/fixed-costs/reconciliation-contract.js';
import {
  explainFixedCostReconciliation, fixedCostReconciliationStatement, FixedCostReconciliationError,
  reconcileFixedCostMonth,
} from '../../src/fixed-costs/reconciliation-repository.js';

// Fixed reference clock so settlement bounds are deterministic and clock-independent.
const now = new Date('2026-09-23T10:00:00Z');
const settledMonth = '2025-03-01';
const limit = fixedCostReconciliationTaskLimit;
const categoryKeys = Object.keys(fixedCostReconciliationCategories) as (keyof typeof fixedCostReconciliationCategories)[];
const differenceClasses = [...fixedCostDifferenceBuckets, ...fixedCostDifferenceNonComparable];

const gate = () => new AnalyticsGate(3, 6, 1000);

function fixture(respond?: (index: number) => unknown, failure: unknown = new Error('Unexpected pool call')) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let active = 0;
  let peak = 0;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      const index = calls.length;
      calls.push({ sql, values });
      peak = Math.max(peak, ++active);
      try {
        await setImmediate();
        if (!respond) throw failure;
        return respond(index);
      } finally { active--; }
    },
    end: async () => {},
  } as ReplicaPool;
  return { pool, calls, peak: () => peak };
}

const counts = (partial: Partial<FixedCostDifferenceCounts>): FixedCostDifferenceCounts =>
  ({ ...emptyFixedCostDifferenceCounts(), ...partial });

const total = (values: FixedCostDifferenceCounts) => differenceClasses.reduce((sum, name) => sum + values[name], 0);

/** Builds one driver aggregate row for a sampled window, with optional sentinel overflow. */
function aggregateRow(options: {
  sampled: number;
  fetched?: number;
  categories?: Partial<Record<keyof typeof fixedCostReconciliationCategories, string>>;
  current?: Partial<FixedCostDifferenceCounts>;
  locked?: Partial<FixedCostDifferenceCounts>;
}) {
  const { sampled, fetched = sampled, categories = {} } = options;
  const current = options.current ? counts(options.current) : counts({ exact: sampled });
  const locked = options.locked ? counts(options.locked) : counts({ exact: sampled });
  assert.equal(total(current), sampled, 'Test current counts cover the sample');
  assert.equal(total(locked), sampled, 'Test locked counts cover the sample');
  const row: Record<string, unknown> = { fetchedTaskCount: fetched, sampledTaskCount: sampled };
  for (const key of categoryKeys) {
    const values = fixedCostReconciliationCategories[key] as readonly string[];
    const selected = categories[key] ?? values[0];
    assert.ok(values.includes(selected), 'Test bucket is allowlisted');
    for (const value of values) row[`${key}__${value}`] = value === selected ? sampled : 0;
  }
  for (const name of differenceClasses) {
    row[`currentDifference__${name}`] = current[name];
    row[`lockedDifference__${name}`] = locked[name];
  }
  return row;
}

const runWith = (row: Record<string, unknown>) => reconcileFixedCostMonth(fixture(() => [row]).pool, gate(), settledMonth, now);

test('reconciliation months must be canonical, real and older than the settlement bound', () => {
  assert.deepEqual(parseFixedCostReconciliationMonth(settledMonth, now), { month: '2025-03-01', monthEnd: '2025-04-01' });
  assert.deepEqual(parseFixedCostReconciliationMonth('2025-12-01', now), { month: '2025-12-01', monthEnd: '2026-01-01' });
  assert.equal(parseFixedCostReconciliationMonth('2026-03-01', now).month, '2026-03-01');
  for (const value of [
    undefined, null, '', ' ', 1, {}, [], new Date('2025-03-01'),
    '2025-3-01', '2025-03-1', '2025-03-02', '2025-03-31', '2025-13-01', '2025-00-01', '0000-01-01',
    '2025-03', '2025-03-01T00:00:00Z', '2025-03-01 ', ' 2025-03-01', '2025-03-01Z', '25-03-01',
    '2026-04-01', '2026-08-01', '2026-09-01', '2026-10-01', '2027-01-01',
    "2025-03-01'; DROP TABLE kastai_fiksuoti_ataskaita --", '2025-03-01 OR 1=1',
  ]) {
    assert.throws(() => parseFixedCostReconciliationMonth(value, now), InvalidFixedCostReconciliationMonth, String(value));
  }
});

test('validation failures reject before any replica access', async () => {
  const { pool, calls } = fixture();
  for (const value of [undefined, '2026-09-01', '2025-03-15', 'not-a-month']) {
    await assert.rejects(reconcileFixedCostMonth(pool, gate(), value, now), InvalidFixedCostReconciliationMonth);
    await assert.rejects(explainFixedCostReconciliation(pool, gate(), value, now), InvalidFixedCostReconciliationMonth);
  }
  assert.equal(calls.length, 0);
});

test('the statement is static, unqualified, parameterized only by month bounds and strictly bounded', async () => {
  const { pool, calls } = fixture(() => [aggregateRow({ sampled: 3 })]);
  await reconcileFixedCostMonth(pool, gate(), settledMonth, now);
  await explainFixedCostReconciliation(pool, gate(), settledMonth, now);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sql, fixedCostReconciliationStatement);
  assert.equal(calls[1].sql, `EXPLAIN ${fixedCostReconciliationStatement}`);
  for (const call of calls) {
    const { sql } = call;
    assert.deepEqual(call.values, ['2025-03-01', '2025-04-01'], 'Only month bounds are bound');
    assert.equal((sql.match(/\?/g) ?? []).length, 2);
    assert.ok(!sql.includes('infot_2'), 'No hardcoded schema qualifier');
    assert.doesNotMatch(sql, /`?\w+`?\s*\.\s*`?(kastai_fiksuoti_ataskaita|kastai_fiksuoti_vilkikai_det|kastai_fiksuoti_vilkikai_det_locked|uzdaviniai|masinos)\b/);
    assert.ok(!sql.includes('2025-03') && !sql.includes('2025-04'), 'The month never reaches the statement text');
    assert.match(sql, new RegExp(`LIMIT ${limit + 1}\\b`), 'Hard sentinel-bounded task prefix preserved');
    const referenced = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]);
    assert.deepEqual([...new Set(referenced)].sort(), [
      'kastai_fiksuoti_ataskaita', 'kastai_fiksuoti_vilkikai_det', 'kastai_fiksuoti_vilkikai_det_locked', 'masinos', 'uzdaviniai',
    ]);
  }
});

test('current and locked calculations never cross and never combine', () => {
  const sql = fixedCostReconciliationStatement;
  assert.match(sql, /j\.kastaiVilkiko = j\.currentComponentSum/);
  assert.match(sql, /j\.locked_kastaiVilkiko = j\.lockedComponentSum/);
  assert.match(sql, /ABS\(j\.kastaiVilkiko - j\.currentComponentSum\)/);
  assert.match(sql, /ABS\(j\.locked_kastaiVilkiko - j\.lockedComponentSum\)/);
  assert.ok(!/j\.kastaiVilkiko\s*-\s*j\.lockedComponentSum/.test(sql), 'Current total never meets locked components');
  assert.ok(!/j\.locked_kastaiVilkiko\s*-\s*j\.currentComponentSum/.test(sql), 'Locked total never meets current components');
  assert.ok(!/kastaiVilkiko\s*\+\s*j\.locked_kastaiVilkiko/.test(sql), 'Current and locked are never added');
  assert.match(sql, /FROM kastai_fiksuoti_vilkikai_det_locked l WHERE l\.uzdavinys = s\.uzdavinys\)\s*AS lockedComponentSum/);
  assert.match(sql, /FROM kastai_fiksuoti_vilkikai_det d WHERE d\.uzdavinys = s\.uzdavinys\)\s*AS currentComponentSum/);
  // Each difference column is derived from its own detail cardinality.
  assert.match(sql, /j\.currentDetailRows > 1 THEN 'multiple_details'[^]*?END AS currentDifference/);
  assert.match(sql, /j\.lockedDetailRows > 1 THEN 'multiple_details'[^]*?END AS lockedDifference/);
});

test('all fifteen confirmed components are summed identically on both sides', () => {
  const components = [
    'amortizacija', 'remontas', 'padangos', 'draudimai', 'lizingas', 'vairuotojuDU', 'administracijaDU',
    'kitiMokesciai', 'vairuotojoTelefonas', 'CMRdraudimas', 'papildomosIslaidos', 'vairuotojuDUPL',
    'ruosimasGrazinimui', 'draudiminiuRemontuDedamoji', 'general_administrative_expenses',
  ];
  for (const alias of ['d', 'l']) {
    const expected = components.map(column => `${alias}.${column}`).join(' + ');
    assert.ok(fixedCostReconciliationStatement.includes(`SUM(${expected})`), `${alias} component sum`);
  }
});

test('the documented tolerance is applied as exact decimal SQL and reported in metadata', async () => {
  assert.equal(fixedCostReconciliationToleranceEur, '0.01');
  const sql = fixedCostReconciliationStatement;
  assert.match(sql, /ABS\(j\.kastaiVilkiko - j\.currentComponentSum\) <= 0\.01 THEN 'within_tolerance'/);
  assert.match(sql, /ABS\(j\.locked_kastaiVilkiko - j\.lockedComponentSum\) <= 0\.01 THEN 'within_tolerance'/);
  const result = await runWith(aggregateRow({ sampled: 2 }));
  assert.equal(result.meta.toleranceEur, '0.01');
  assert.equal(result.meta.settlementMonths, fixedCostReconciliationSettlementMonths);
  assert.equal(result.meta.reconciliationStatus, 'unreconciled_pending_erp_reference');
});

// --- difference buckets -------------------------------------------------------

test('EUR decimal text converts to integer cents without floating point', () => {
  assert.equal(eurStringToCents('0.00'), 0);
  assert.equal(eurStringToCents('0.01'), 1);
  assert.equal(eurStringToCents('1.00'), 100);
  assert.equal(eurStringToCents('10.00'), 1000);
  assert.equal(eurStringToCents('100.00'), 10000);
  for (const bad of ['0.1', '0.001', '.01', '1', '1.005', '-1.00', '01.00', 'NaN', '1e2', '']) {
    assert.throws(() => eurStringToCents(bad), /decimal\(13,2\)/, bad);
  }
});

test('every documented bucket boundary classifies exactly as specified', () => {
  const cases: [string, string][] = [
    ['0.00', 'exact'],
    ['0.01', 'rounding'],
    ['0.02', 'small'], ['1.00', 'small'],
    ['1.01', 'moderate'], ['10.00', 'moderate'],
    ['10.01', 'material'], ['100.00', 'material'],
    ['100.01', 'large'], ['999999.99', 'large'],
  ];
  for (const [amount, expected] of cases) {
    assert.equal(classifyFixedCostDifferenceCents(eurStringToCents(amount)), expected, `${amount} is ${expected}`);
  }
});

test('negative raw differences classify by magnitude through ABS', () => {
  const cases: [string, string][] = [
    ['0.01', 'rounding'], ['0.02', 'small'], ['1.00', 'small'],
    ['1.01', 'moderate'], ['10.00', 'moderate'], ['10.01', 'material'], ['100.01', 'large'],
  ];
  for (const [amount, expected] of cases) {
    const cents = eurStringToCents(amount);
    assert.equal(classifyFixedCostDifferenceCents(-cents), expected, `-${amount} is ${expected}`);
    assert.equal(classifyFixedCostDifferenceCents(-cents), classifyFixedCostDifferenceCents(cents), `-${amount} matches +${amount}`);
  }
  assert.equal(classifyFixedCostDifferenceCents(-0), 'exact');
  for (const bad of [1.5, NaN, Infinity]) assert.throws(() => classifyFixedCostDifferenceCents(bad), /integer cents/);
});

test('the SQL ladder is generated from the shared bounds in the documented order', () => {
  const sql = fixedCostReconciliationStatement;
  assert.deepEqual(fixedCostDifferenceLadder.map(entry => entry.bucket), [...fixedCostDifferenceBuckets]);
  assert.deepEqual(fixedCostDifferenceLadder.map(entry => entry.maxEur), ['0.00', '0.01', '1.00', '10.00', '100.00', null]);
  for (const key of ['currentDifference', 'lockedDifference']) {
    const end = sql.indexOf(`END AS ${key}`);
    const expression = sql.slice(sql.lastIndexOf('CASE WHEN', end), end);
    // Structural exclusions are decided before any monetary bucket is reachable.
    const order = ["'missing_total'", "'no_details'", "'multiple_details'", "'other'",
      ...fixedCostDifferenceBuckets.map(bucket => `'${bucket}'`)].map(part => expression.indexOf(part));
    assert.ok(order.every(index => index >= 0), `${key} branches present`);
    assert.deepEqual(order, [...order].sort((left, right) => left - right), `${key} branch order`);
    for (const { maxEur, bucket } of fixedCostDifferenceLadder) {
      if (maxEur !== null) assert.ok(expression.includes(`<= ${maxEur} THEN '${bucket}'`), `${key} ${bucket} bound`);
    }
  }
});

test('structurally non-comparable rows stay out of every monetary bucket', async () => {
  const result = await runWith(aggregateRow({
    sampled: 10,
    current: { exact: 4, large: 1, no_details: 3, multiple_details: 1, missing_total: 1 },
    locked: { exact: 10 },
  }));
  const current = result.differences.current;
  assert.equal(current.comparableCount, 5, 'Only single-detail comparable rows');
  assert.equal(current.sampledCount, 10);
  assert.deepEqual(current.nonComparable, { no_details: 3, multiple_details: 1, missing_total: 1, other: 0 });
  // Comparable percentages use the comparable denominator, not the sample.
  assert.equal(current.buckets.exact.percentageOfComparable, 80);
  assert.equal(current.buckets.exact.percentageOfAllSampled, 40);
  assert.equal(current.buckets.large.percentageOfComparable, 20);
  assert.equal(current.buckets.large.percentageOfAllSampled, 10);
  // Non-comparable rows carry no bucket share at all.
  assert.ok(!Object.keys(current.buckets).some(name => (fixedCostDifferenceNonComparable as readonly string[]).includes(name)));
});

test('percentage denominators follow the documented rules', () => {
  const distribution = describeFixedCostDifferences(counts({
    exact: 50, rounding: 10, small: 20, moderate: 15, material: 4, large: 1, no_details: 100,
  }));
  assert.equal(distribution.comparableCount, 100);
  assert.equal(distribution.sampledCount, 200);
  assert.equal(distribution.buckets.exact.percentageOfComparable, 50);
  assert.equal(distribution.buckets.exact.percentageOfAllSampled, 25);
  assert.equal(distribution.buckets.exact.relativeToExactPercentage, 100, 'exact is always 100 relative to itself');
  assert.equal(distribution.buckets.rounding.relativeToExactPercentage, 20);
  assert.equal(distribution.buckets.small.relativeToExactPercentage, 40);
  assert.equal(distribution.buckets.large.relativeToExactPercentage, 2);
  // Half-up to two decimals, derived from integer counts.
  assert.equal(percentageOf(1, 3), 33.33);
  assert.equal(percentageOf(2, 3), 66.67);
  assert.equal(percentageOf(1, 8), 12.5);
  assert.equal(percentageOf(0, 7), 0);
  assert.equal(percentageOf(7, 7), 100);
});

test('a zero denominator returns null rather than dividing by zero', () => {
  assert.equal(percentageOf(0, 0), null);
  assert.equal(percentageOf(5, 0), null);
  const noExact = describeFixedCostDifferences(counts({ small: 3, large: 1 }));
  assert.equal(noExact.buckets.exact.count, 0);
  assert.equal(noExact.buckets.exact.relativeToExactPercentage, null, 'no exact match yields null, never 0 or Infinity');
  assert.equal(noExact.buckets.small.relativeToExactPercentage, null);
  assert.equal(noExact.buckets.small.percentageOfComparable, 75);
  const empty = describeFixedCostDifferences(emptyFixedCostDifferenceCounts());
  assert.equal(empty.comparableCount, 0);
  assert.equal(empty.sampledCount, 0);
  for (const bucket of fixedCostDifferenceBuckets) {
    assert.deepEqual(empty.buckets[bucket], {
      count: 0, percentageOfComparable: null, percentageOfAllSampled: null, relativeToExactPercentage: null,
    });
  }
  const onlyNonComparable = describeFixedCostDifferences(counts({ no_details: 4 }));
  assert.equal(onlyNonComparable.buckets.exact.percentageOfComparable, null);
  assert.equal(onlyNonComparable.buckets.exact.percentageOfAllSampled, 0);
});

test('current and locked distributions are projected independently', async () => {
  const result = await runWith(aggregateRow({
    sampled: 6,
    current: { exact: 6 },
    locked: { large: 4, no_details: 2 },
  }));
  assert.equal(result.differences.current.buckets.exact.count, 6);
  assert.equal(result.differences.current.buckets.large.count, 0);
  assert.equal(result.differences.locked.buckets.exact.count, 0);
  assert.equal(result.differences.locked.buckets.large.count, 4);
  assert.equal(result.differences.locked.comparableCount, 4);
  assert.equal(result.differences.locked.buckets.large.percentageOfComparable, 100);
  assert.equal(result.differences.locked.buckets.large.relativeToExactPercentage, null);
  assert.notDeepEqual(result.counts.current, result.counts.locked);
});

// --- sentinel correction ------------------------------------------------------

test('the truncation sentinel sets completeness but is excluded from every counter', async () => {
  const sql = fixedCostReconciliationStatement;
  assert.match(sql, new RegExp(`LIMIT ${limit + 1}\\b`), 'Hard query bound preserved');
  assert.match(sql, /ROW_NUMBER\(\) OVER \(ORDER BY j\.uzdavinys\) AS rowNumber/);
  // Every counter column is gated on the sampled window.
  const counterColumns = [...sql.matchAll(/SUM\(CASE WHEN ([^)]*?) THEN 1 ELSE 0 END\) AS (\w+)/g)];
  assert.ok(counterColumns.length > 0);
  for (const [, condition, column] of counterColumns) {
    if (column === 'sampledTaskCount') continue;
    assert.ok(condition.startsWith(`c.rowNumber <= ${limit} AND `), `${column} is sentinel-gated`);
  }

  // A full month: 5001 fetched, only 5000 counted.
  const truncated = await runWith(aggregateRow({ sampled: limit, fetched: limit + 1 }));
  assert.equal(truncated.meta.fetchedTaskCount, limit + 1);
  assert.equal(truncated.meta.sampledTaskCount, limit);
  assert.equal(truncated.meta.taskLimit, limit);
  assert.equal(truncated.meta.truncated, true);
  assert.equal(truncated.meta.complete, false);
  assert.equal(truncated.differences.current.sampledCount, limit, 'Percentages cover the sample, not the sentinel');
  assert.equal(total(truncated.counts.current), limit);
  for (const key of categoryKeys) {
    const values = Object.values(truncated.data[key]).reduce((left, right) => left + right, 0);
    assert.equal(values, limit, `${key} excludes the sentinel`);
  }

  // A month within the bound reports no truncation.
  const whole = await runWith(aggregateRow({ sampled: 4321 }));
  assert.equal(whole.meta.fetchedTaskCount, 4321);
  assert.equal(whole.meta.sampledTaskCount, 4321);
  assert.equal(whole.meta.truncated, false);
  assert.equal(whole.meta.complete, true);
});

test('inconsistent sentinel accounting fails closed', async () => {
  // Counters claiming the sentinel row, or a fetch beyond the hard bound.
  for (const row of [
    aggregateRow({ sampled: limit, fetched: limit }) && { ...aggregateRow({ sampled: limit, fetched: limit + 1 }), sampledTaskCount: limit + 1 },
    { ...aggregateRow({ sampled: 10, fetched: 10 }), fetchedTaskCount: limit + 2 },
    { ...aggregateRow({ sampled: 10, fetched: 10 }), sampledTaskCount: 9 },
    { ...aggregateRow({ sampled: 10, fetched: 20 }), sampledTaskCount: 10, fetchedTaskCount: 5 },
  ]) {
    await assert.rejects(runWith(row), FixedCostReconciliationError);
  }
});

// --- aggregation --------------------------------------------------------------

test('period keys group months into quarters, years and a combined total', () => {
  assert.equal(fixedCostPeriodKey('2025-03-01', 'month'), '2025-03');
  assert.equal(fixedCostPeriodKey('2025-01-01', 'quarter'), '2025-Q1');
  assert.equal(fixedCostPeriodKey('2025-03-01', 'quarter'), '2025-Q1');
  assert.equal(fixedCostPeriodKey('2025-04-01', 'quarter'), '2025-Q2');
  assert.equal(fixedCostPeriodKey('2025-09-01', 'quarter'), '2025-Q3');
  assert.equal(fixedCostPeriodKey('2025-10-01', 'quarter'), '2025-Q4');
  assert.equal(fixedCostPeriodKey('2025-12-01', 'quarter'), '2025-Q4');
  assert.equal(fixedCostPeriodKey('2024-07-01', 'year'), '2024');
  assert.equal(fixedCostPeriodKey('2024-07-01', 'total'), 'total');
  for (const bad of ['2025-03', '2025-03-02', 'total', '']) assert.throws(() => fixedCostPeriodKey(bad, 'year'), /YYYY-MM-01/);
});

test('quarterly and yearly aggregation sums counts and never averages monthly percentages', () => {
  // A tiny month at 100% exact must not outweigh a large month at 0% exact.
  const entries = [
    { month: '2025-01-01', counts: counts({ exact: 1 }) },
    { month: '2025-02-01', counts: counts({ large: 999 }) },
    { month: '2025-03-01', counts: counts({ exact: 0 }) },
  ];
  const [quarter] = aggregateFixedCostDifferences(entries, 'quarter');
  assert.equal(quarter.period, '2025-Q1');
  assert.equal(quarter.months, 3);
  assert.equal(quarter.counts.exact, 1);
  assert.equal(quarter.counts.large, 999);
  assert.equal(quarter.distribution.comparableCount, 1000);
  assert.equal(quarter.distribution.buckets.exact.percentageOfComparable, 0.1);
  assert.equal(quarter.distribution.buckets.large.percentageOfComparable, 99.9);
  // The average of the monthly percentages would have been ~33.3 and ~33.3.
  const averaged = (100 + 0 + 0) / 3;
  assert.notEqual(quarter.distribution.buckets.exact.percentageOfComparable, Math.round(averaged * 100) / 100);

  const years = aggregateFixedCostDifferences([
    ...entries,
    { month: '2024-11-01', counts: counts({ exact: 5, small: 5 }) },
  ], 'year');
  assert.deepEqual(years.map(entry => entry.period), ['2024', '2025']);
  assert.equal(years[0].counts.exact, 5);
  assert.equal(years[1].counts.large, 999);

  const [combined] = aggregateFixedCostDifferences([...entries, { month: '2024-11-01', counts: counts({ exact: 5, small: 5 }) }], 'total');
  assert.equal(combined.period, 'total');
  assert.equal(combined.months, 4);
  assert.equal(combined.counts.exact, 6);
  assert.equal(combined.counts.small, 5);
  assert.equal(combined.counts.large, 999);
  assert.equal(combined.distribution.sampledCount, 1010);

  // Aggregating monthly counts equals aggregating quarterly counts.
  const viaQuarters = aggregateFixedCostDifferences(
    aggregateFixedCostDifferences(entries, 'quarter').map(entry => ({ month: '2025-01-01', counts: entry.counts })), 'total');
  const viaMonths = aggregateFixedCostDifferences(entries, 'total');
  assert.deepEqual(viaQuarters[0].counts, viaMonths[0].counts, 'Aggregation is associative over counts');
});

test('count combination rejects malformed counters and starts from zero', () => {
  assert.deepEqual(combineFixedCostDifferenceCounts([]), emptyFixedCostDifferenceCounts());
  assert.equal(combineFixedCostDifferenceCounts([counts({ exact: 2 }), counts({ exact: 3 })]).exact, 5);
  for (const bad of [{ ...emptyFixedCostDifferenceCounts(), exact: -1 }, { ...emptyFixedCostDifferenceCounts(), exact: 1.5 }]) {
    assert.throws(() => combineFixedCostDifferenceCounts([bad as FixedCostDifferenceCounts]), /non-negative integers/);
  }
  assert.throws(() => percentageOf(-1, 5), /non-negative integer counts/);
});

// --- mutation checks ----------------------------------------------------------

test('mutation: the guards fail when ABS, a boundary, the sources or the sentinel gate change', () => {
  const sql = fixedCostReconciliationStatement;

  const absGuard = (text: string) => {
    assert.match(text, /ABS\(j\.kastaiVilkiko - j\.currentComponentSum\) <= 1\.00 THEN 'small'/);
    assert.match(text, /ABS\(j\.locked_kastaiVilkiko - j\.lockedComponentSum\) <= 1\.00 THEN 'small'/);
  };
  absGuard(sql);
  assert.throws(() => absGuard(sql.replaceAll('ABS(', '(')), assert.AssertionError, 'removing ABS must fail the guard');

  const boundaryGuard = (text: string) => {
    for (const { bucket, maxEur } of fixedCostDifferenceLadder) {
      if (maxEur !== null) assert.ok(text.includes(`<= ${maxEur} THEN '${bucket}'`), `${bucket} bound`);
    }
  };
  boundaryGuard(sql);
  assert.throws(() => boundaryGuard(sql.replaceAll("<= 1.00 THEN 'small'", "<= 2.00 THEN 'small'")), assert.AssertionError, 'changing a boundary must fail the guard');
  assert.throws(() => boundaryGuard(sql.replaceAll("<= 0.01 THEN 'rounding'", "<= 0.05 THEN 'rounding'")), assert.AssertionError);

  const crossGuard = (text: string) => {
    assert.ok(!/j\.kastaiVilkiko\s*-\s*j\.lockedComponentSum/.test(text), 'current total vs locked components');
    assert.ok(!/j\.locked_kastaiVilkiko\s*-\s*j\.currentComponentSum/.test(text), 'locked total vs current components');
  };
  crossGuard(sql);
  assert.throws(() => crossGuard(sql.replace('ABS(j.kastaiVilkiko - j.currentComponentSum)', 'ABS(j.kastaiVilkiko - j.lockedComponentSum)')), assert.AssertionError, 'crossing sources must fail the guard');
  assert.throws(() => crossGuard(sql.replace('ABS(j.locked_kastaiVilkiko - j.lockedComponentSum)', 'ABS(j.locked_kastaiVilkiko - j.currentComponentSum)')), assert.AssertionError);

  const sentinelGuard = (text: string) => {
    for (const [, condition, column] of text.matchAll(/SUM\(CASE WHEN ([^)]*?) THEN 1 ELSE 0 END\) AS (\w+)/g)) {
      if (column === 'sampledTaskCount') continue;
      assert.ok(condition.startsWith(`c.rowNumber <= ${limit} AND `), `${column} sentinel gate`);
    }
  };
  sentinelGuard(sql);
  assert.throws(() => sentinelGuard(sql.replaceAll(`c.rowNumber <= ${limit} AND `, '')), assert.AssertionError, 'counting the sentinel must fail the guard');
});

test('mutation: the runtime rejects counts that include the sentinel row', async () => {
  // Honest accounting passes.
  await runWith(aggregateRow({ sampled: limit, fetched: limit + 1 }));
  // The same month with counters covering 5001 rows must fail closed.
  const inflated = aggregateRow({ sampled: limit + 1, fetched: limit + 1 });
  await assert.rejects(runWith(inflated), FixedCostReconciliationError, 'sentinel-inclusive counters must fail');
});

// --- existing guarantees ------------------------------------------------------

test('every allowlisted category value survives projection, including mismatch and duplicate grain', async () => {
  for (const key of categoryKeys) {
    for (const value of fixedCostReconciliationCategories[key] as readonly string[]) {
      const result = await runWith(aggregateRow({ sampled: 7, categories: { [key]: value } }));
      assert.equal(result.data[key][value as never], 7, `${key}=${value}`);
      const others = Object.entries(result.data[key]).filter(([name]) => name !== value);
      assert.ok(others.every(([, count]) => count === 0), `${key}=${value} is exclusive`);
    }
  }
  const result = await runWith(aggregateRow({
    sampled: 4,
    categories: {
      task: 'missing', currentDetail: 'none', lockedDetail: 'multiple',
      currentComponents: 'outside_tolerance', lockedComponents: 'no_details',
    },
    current: { no_details: 4 },
    locked: { multiple_details: 4 },
  }));
  assert.equal(result.data.task.missing, 4);
  assert.equal(result.data.currentDetail.none, 4);
  assert.equal(result.data.lockedDetail.multiple, 4);
  assert.equal(result.differences.current.nonComparable.no_details, 4);
  assert.equal(result.differences.locked.nonComparable.multiple_details, 4);
  assert.equal(result.differences.locked.comparableCount, 0);
});

test('inconsistent, non-numeric or incomplete aggregates fail closed without exposing payloads', async () => {
  const valid = aggregateRow({ sampled: 5 });
  const broken: Record<string, unknown>[] = [
    { ...valid, task__present: 4 },
    { ...valid, task__present: '3', task__missing: '1' },
    { ...valid, currentDifference__exact: 4 },
    { ...valid, lockedDifference__large: 1 },
    { ...valid, currentDifference__exact: -1 },
    { ...valid, currentDifference__exact: 1.5 },
    { ...valid, lockedDifference__exact: '123.45' },
    { ...valid, lockedDetail__none: null },
    { ...valid, fetchedTaskCount: 'PRIVATE' },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'assignedTruck__zero')),
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'currentDifference__large')),
  ];
  for (const row of broken) {
    await assert.rejects(runWith(row), (error: unknown) => {
      assert.ok(error instanceof FixedCostReconciliationError);
      assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /123\.45|PRIVATE/);
      return true;
    });
  }
  for (const rows of [[], [valid, valid]]) {
    const { pool } = fixture(() => rows);
    await assert.rejects(reconcileFixedCostMonth(pool, gate(), settledMonth, now), FixedCostReconciliationError);
  }
});

test('results carry no task IDs, truck identifiers, dates or monetary amounts', async () => {
  const contaminated = {
    ...aggregateRow({ sampled: 3, current: { exact: 1, small: 1, large: 1 }, locked: { exact: 3 } }),
    uzdavinys: 810000001, taskId: 810000001, truckId: 4242, masinos_nr: 'PRIVATE',
    kastaiVilkiko: '1234.56', locked_kastaiVilkiko: '-99.99', currentComponentSum: '1234.55',
    kastai_data: new Date('2025-03-01T00:00:00Z'), locked_kastaiVilkiko_data: '0000-00-00',
  };
  const result = await runWith(contaminated);
  assert.doesNotMatch(JSON.stringify(result), /810000001|4242|PRIVATE|1234\.5|99\.99|0000-00-00/);
  assert.deepEqual(Object.keys(result).sort(), ['counts', 'data', 'differences', 'meta']);
  assert.deepEqual(Object.keys(result.meta).sort(), [
    'complete', 'fetchedTaskCount', 'month', 'reconciliationStatus', 'sampledTaskCount',
    'settlementMonths', 'taskLimit', 'toleranceEur', 'truncated',
  ]);
  assert.deepEqual(Object.keys(result.data).sort(), [...categoryKeys].sort());
  assert.deepEqual(Object.keys(result.differences).sort(), ['current', 'locked']);
  for (const side of ['current', 'locked'] as const) {
    assert.deepEqual(Object.keys(result.differences[side].buckets).sort(), [...fixedCostDifferenceBuckets].sort());
    assert.deepEqual(Object.keys(result.counts[side]).sort(), [...differenceClasses].sort());
    assert.ok(Object.values(result.counts[side]).every(count => Number.isSafeInteger(count) && count >= 0));
    for (const bucket of fixedCostDifferenceBuckets) {
      const share = result.differences[side].buckets[bucket];
      assert.deepEqual(Object.keys(share).sort(), ['count', 'percentageOfAllSampled', 'percentageOfComparable', 'relativeToExactPercentage']);
      assert.ok(Number.isSafeInteger(share.count));
    }
  }
  // The only decimals anywhere are derived percentages and the documented tolerance.
  assert.doesNotMatch(JSON.stringify(result.counts), /\d+\.\d/);
  assert.doesNotMatch(JSON.stringify(result.data), /\d+\.\d/);
});

test('driver failures and timeouts are sanitized through the repository error', async () => {
  for (const [driverCode, timeout] of [['ER_PARSE_ERROR', false], ['ER_STATEMENT_TIMEOUT', true], ['ER_QUERY_INTERRUPTED', true]] as const) {
    const secret = Object.assign(new Error('SELECT kastaiVilkiko WHERE uzdavinys=810000001 AND masinos_nr=PRIVATE'), {
      code: driverCode, sql: 'SELECT private_sql', parameters: ['2025-03-01'], amount: '1234.56', registration: 'PRIVATE',
    });
    const { pool } = fixture(() => { throw new Error('private wrapper', { cause: secret }); });
    await assert.rejects(reconcileFixedCostMonth(pool, gate(), settledMonth, now), (error: unknown) => {
      assert.ok(error instanceof FixedCostReconciliationError);
      assert.equal(error.code, timeout ? 'QUERY_TIMEOUT' : 'REPLICA_UNAVAILABLE');
      assert.equal(error.statusCode, timeout ? 504 : 503);
      assert.equal(error.cause, undefined);
      assert.ok(error.diagnostics.some(entry => entry.code === driverCode));
      assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /SELECT|private|PRIVATE|810000001|1234\.56/);
      return true;
    });
  }
});

test('reconciliation runs through the shared analytics gate and respects its concurrency', async () => {
  const shared = new AnalyticsGate(1, 6, 1000);
  const { pool, peak } = fixture(() => [aggregateRow({ sampled: 1 })]);
  await Promise.all(Array.from({ length: 4 }, () => reconcileFixedCostMonth(pool, shared, settledMonth, now)));
  assert.equal(peak(), 1, 'Gate serialized the bounded statements');
  assert.equal(shared.active, 0);
  assert.equal(shared.waiting, 0);
  const busy = new AnalyticsGate(1, 0, 1000);
  const blocker = fixture(async () => { await setImmediate(); return [aggregateRow({ sampled: 1 })]; });
  const held = busy.run(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await assert.rejects(reconcileFixedCostMonth(blocker.pool, busy, settledMonth, now), FixedCostReconciliationError);
  await held;
});

test('reconciliation adds no HTTP surface and public fixed-cost endpoints stay unverified', async () => {
  const config = loadConfig({
    ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
    ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
  });
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  const routes = new Set<string>();
  app.addHook('onRoute', route => { routes.add(route.url); });
  try {
    await app.ready();
    assert.ok([...routes].every(path => !/reconcil|difference|bucket/i.test(path)), 'No reconciliation route');
    for (const path of [
      '/expense-analytics/fixed-costs/reconciliation', '/expense-analytics/fixed-costs/reconcile',
      '/fixed-costs/reconciliation', '/expense-analytics/fixed-costs/explain',
      '/expense-analytics/fixed-costs/differences',
    ]) {
      for (const method of ['GET', 'POST'] as const) assert.equal((await app.inject({ method, url: path })).statusCode, 404, path);
    }
    for (const scope of fixedCostAllocationScopes) {
      assert.equal(fixedCostSemanticCapabilities[scope].enabled, false);
      for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
        const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?allocationScope=${scope}`);
        assert.equal(response.statusCode, 422);
        assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
    }
    assert.equal(calls.length, 0, 'No replica access from public endpoints');
  } finally { await app.close(); }
});
