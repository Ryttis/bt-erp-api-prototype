import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { ApiError } from '../../src/errors.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes } from '../../src/fixed-costs/contracts.js';
import {
  assertApprovedDeletedRowPolicy, assertDecimalString, fixedCostAuthoritativeSource, fixedCostBreakdownSources,
  fixedCostMonetaryMaxRecords, fixedCostMonetaryMaxTruckIds, FixedCostDeletedPolicyUnapproved,
  InvalidFixedCostMonetaryQuery, InvalidFixedCostMonetaryResult, parseFixedCostMonetaryQuery,
  unapprovedFixedCostDeletedRowPolicy, type FixedCostDeletedRowPolicy,
} from '../../src/fixed-costs/monetary-contract.js';
import {
  fixedCostComponentFields, fixedCostMonetaryStatement, FixedCostMonetaryError, FixedCostMonetaryTruncated,
  queryFixedCostMonetaryTotals,
} from '../../src/fixed-costs/monetary-repository.js';
import { fixedCostDifferenceBuckets, fixedCostDifferenceLadder } from '../../src/fixed-costs/reconciliation-contract.js';

const now = new Date('2026-09-23T10:00:00Z');
const month = '2025-03-01';
const approved: FixedCostDeletedRowPolicy = Object.freeze({
  treatment: 'separate_by_state', approved: true, approvedBy: 'internal-test-owner', reference: 'FC-03',
});
const baseQuery = { allocationScope: 'truck', representation: 'current', periodMonth: month, limit: 100 } as const;

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

/**
 * One driver group row. Monetary fields stay decimal text exactly as SQL rendered
 * them, and a group with no comparable record carries SQL NULL in every comparison
 * column, exactly as `SUM(CASE WHEN comparable = 1 ... ELSE NULL END)` produces.
 */
function groupRow(options: {
  deletedState?: string;
  comparable?: number;
  noDetail?: number;
  multipleDetail?: number;
  missingTotal?: number;
  missingTask?: number;
  locked?: number;
  unlockedCount?: number;
  unknownLock?: number;
  buckets?: Partial<Record<typeof fixedCostDifferenceBuckets[number], number>>;
  authoritativeTotal?: string | null;
  comparableAuthoritativeTotal?: string | null;
  componentTotal?: string | null;
  netDifference?: string | null;
  grossAbsoluteDifference?: string | null;
} = {}) {
  const comparable = options.comparable ?? 4;
  const noDetail = options.noDetail ?? 0;
  const multipleDetail = options.multipleDetail ?? 0;
  const missingTotal = options.missingTotal ?? 0;
  const buckets = { exact: comparable, rounding: 0, small: 0, moderate: 0, material: 0, large: 0, ...options.buckets };
  const bucketed = fixedCostDifferenceBuckets.reduce((sum, name) => sum + buckets[name], 0);
  assert.equal(bucketed, comparable, 'Test buckets cover the comparable records');
  const authoritativeRecords = comparable + noDetail + multipleDetail + missingTotal;
  const pick = <T>(supplied: T | undefined, whenComparable: T, whenEmpty: T) =>
    supplied !== undefined ? supplied : comparable > 0 ? whenComparable : whenEmpty;
  return {
    deletedState: options.deletedState ?? 'zero',
    authoritativeRecords,
    authoritativeTotal: options.authoritativeTotal !== undefined ? options.authoritativeTotal
      : authoritativeRecords > missingTotal ? '125430.20' : null,
    comparableRecords: comparable,
    comparableAuthoritativeTotal: pick(options.comparableAuthoritativeTotal, '124000.00', null),
    componentTotal: pick(options.componentTotal, '124980.10', null),
    netDifference: pick(options.netDifference, '450.10', null),
    grossAbsoluteDifference: pick(options.grossAbsoluteDifference, '470.10', null),
    affectedRecords: comparable - buckets.exact,
    ...Object.fromEntries(fixedCostDifferenceBuckets.map(name => [`bucket_${name}`, buckets[name]])),
    noDetailRecords: noDetail,
    multipleDetailRecords: multipleDetail,
    missingTotalRecords: missingTotal,
    missingTaskCount: options.missingTask ?? 0,
    // Lock states must always cover the authoritative population (FCB-05).
    lockedRecords: options.locked ?? 0,
    unlockedRecords: options.unlockedCount ?? (authoritativeRecords - (options.locked ?? 0) - (options.unknownLock ?? 0)),
    unknownLockRecords: options.unknownLock ?? 0,
  };
}

const run = (rows: unknown[], query: unknown = baseQuery, policy: FixedCostDeletedRowPolicy = approved) =>
  queryFixedCostMonetaryTotals(fixture(() => rows).pool, gate(), query, policy, now);

// --- query contract -----------------------------------------------------------

test('the internal query contract accepts only the declared fields', () => {
  const parsed = parseFixedCostMonetaryQuery(baseQuery, now);
  assert.deepEqual(parsed, {
    allocationScope: 'truck', representation: 'current', periodMonth: '2025-03-01', periodEnd: '2025-04-01', limit: 100,
  });
  assert.equal(parseFixedCostMonetaryQuery({ ...baseQuery, representation: 'locked' }, now).representation, 'locked');
  assert.deepEqual(parseFixedCostMonetaryQuery({ ...baseQuery, truckIds: [7, 9] }, now).truckIds, [7, 9]);
  // Defaulted limit stays within the hard maximum.
  const { limit } = parseFixedCostMonetaryQuery({ allocationScope: 'truck', representation: 'current', periodMonth: month }, now);
  assert.ok(limit > 0 && limit <= fixedCostMonetaryMaxRecords);
});

test('strict validation rejects unsupported scopes, representations, periods, bounds and shapes', () => {
  const invalid: unknown[] = [
    null, undefined, [], 'truck', 42, Object.create({ allocationScope: 'truck' }),
    {}, { allocationScope: 'trailer', representation: 'current', periodMonth: month },
    { allocationScope: 'department', representation: 'current', periodMonth: month },
    { allocationScope: 'truck', periodMonth: month },
    { allocationScope: 'truck', representation: 'CURRENT', periodMonth: month },
    { allocationScope: 'truck', representation: 'both', periodMonth: month },
    { allocationScope: 'truck', representation: 'current' },
    { ...baseQuery, periodMonth: '2026-09-01' },
    { ...baseQuery, periodMonth: '2025-03-15' },
    { ...baseQuery, periodMonth: '2025-3-01' },
    { ...baseQuery, limit: 0 }, { ...baseQuery, limit: -1 }, { ...baseQuery, limit: 1.5 },
    { ...baseQuery, limit: fixedCostMonetaryMaxRecords + 1 }, { ...baseQuery, limit: '100' },
    { ...baseQuery, truckIds: [] }, { ...baseQuery, truckIds: [0] }, { ...baseQuery, truckIds: [1, 1] },
    { ...baseQuery, truckIds: [1.5] }, { ...baseQuery, truckIds: ['1'] }, { ...baseQuery, truckIds: 5 },
    { ...baseQuery, truckIds: Array.from({ length: fixedCostMonetaryMaxTruckIds + 1 }, (_, i) => i + 1) },
    // No field, filter, grouping, sorting, measure, table, column or expression input exists.
    { ...baseQuery, fields: ['amount'] }, { ...baseQuery, groupBy: 'truck' }, { ...baseQuery, sortBy: 'amount' },
    { ...baseQuery, table: 'kastai_fiksuoti_ataskaita' }, { ...baseQuery, column: 'kastaiVilkiko' },
    { ...baseQuery, expression: 'SUM(kastaiVilkiko)' }, { ...baseQuery, where: '1=1' },
    { ...baseQuery, deletedPolicy: 'include_all' }, { ...baseQuery, includeDeleted: true },
  ];
  for (const input of invalid) {
    assert.throws(() => parseFixedCostMonetaryQuery(input, now), InvalidFixedCostMonetaryQuery, JSON.stringify(input));
  }
});

test('SQL-shaped and prototype-polluting input never reaches the statement', async () => {
  const { pool, calls } = fixture();
  for (const periodMonth of ["2025-03-01'; DROP TABLE kastai_fiksuoti_ataskaita --", '2025-03-01 OR 1=1', '2025-03-01 UNION SELECT 1']) {
    await assert.rejects(queryFixedCostMonetaryTotals(pool, gate(), { ...baseQuery, periodMonth }, approved, now), InvalidFixedCostMonetaryQuery);
  }
  for (const truckIds of [["1) OR 1=1 --"], ['1; DROP TABLE masinos'], [Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(queryFixedCostMonetaryTotals(pool, gate(), { ...baseQuery, truckIds }, approved, now), InvalidFixedCostMonetaryQuery);
  }
  assert.equal(calls.length, 0, 'No replica access after validation failure');
});

// --- deleted-row policy -------------------------------------------------------

test('the unresolved deleted-row policy fails closed before any replica access', async () => {
  const { pool, calls } = fixture(() => [groupRow()]);
  // The module default is unapproved, so the default call path cannot execute.
  await assert.rejects(queryFixedCostMonetaryTotals(pool, gate(), baseQuery, undefined, now), FixedCostDeletedPolicyUnapproved);
  await assert.rejects(queryFixedCostMonetaryTotals(pool, gate(), baseQuery, unapprovedFixedCostDeletedRowPolicy, now), FixedCostDeletedPolicyUnapproved);
  assert.equal(unapprovedFixedCostDeletedRowPolicy.approved, false);
  assert.equal(unapprovedFixedCostDeletedRowPolicy.reference, 'FC-03');
  for (const policy of [
    null, undefined, {}, { approved: true }, { approved: true, approvedBy: '', treatment: 'include_all' },
    { approved: true, approvedBy: '   ', treatment: 'include_all' },
    { approved: 'yes', approvedBy: 'x', treatment: 'include_all' },
    { approved: true, approvedBy: 'x', treatment: 'invent_a_rule' },
  ]) {
    assert.throws(() => assertApprovedDeletedRowPolicy(policy as FixedCostDeletedRowPolicy), FixedCostDeletedPolicyUnapproved, JSON.stringify(policy));
  }
  assert.equal(calls.length, 0, 'The policy gate runs before the replica');
});

test('results are always separated by declared row state, whatever the policy says', async () => {
  const result = await run([
    groupRow({ deletedState: 'zero', comparable: 3 }),
    groupRow({ deletedState: 'one', comparable: 2 }),
    groupRow({ deletedState: 'other', comparable: 1 }),
  ]);
  assert.deepEqual(result.groups.map(group => group.deletedState), ['zero', 'one', 'other']);
  // No merged authoritative figure exists anywhere in the result.
  assert.ok(!Object.keys(result.meta).some(key => /total|amount|sum/i.test(key)), 'No aggregate total in metadata');
  assert.match(fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now)), /GROUP BY r\.deletedState/);
  assert.equal(result.meta.deletedRowPolicy.approved, true);
  // Even an approved "include_all" treatment still reports the states apart.
  const merged = await run([groupRow({ deletedState: 'zero' }), groupRow({ deletedState: 'one' })], baseQuery,
    { treatment: 'include_all', approved: true, approvedBy: 'internal-test-owner', reference: 'FC-03' });
  assert.equal(merged.groups.length, 2);
  await assert.rejects(run([groupRow({ deletedState: 'zero' }), groupRow({ deletedState: 'zero' })]), InvalidFixedCostMonetaryResult);
  await assert.rejects(run([groupRow({ deletedState: 'deleted' })]), InvalidFixedCostMonetaryResult);
});

// --- sources and separation ---------------------------------------------------

test('current and locked read entirely separate authoritative columns and detail tables', () => {
  const current = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  const locked = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery({ ...baseQuery, representation: 'locked' }, now));
  assert.match(current, /s\.kastaiVilkiko AS authoritative/);
  // `locked_kastaiVilkiko_data` is task-level lock-event metadata shared by both
  // representations; the locked *amount* column must never appear in a current read.
  assert.ok(!/locked_kastaiVilkiko(?!_data)/.test(current), 'Current never reads the locked amount');
  assert.ok(!current.includes('kastai_fiksuoti_vilkikai_det_locked'), 'Current never reads the locked detail table');
  assert.match(locked, /s\.locked_kastaiVilkiko AS authoritative/);
  assert.match(locked, /FROM kastai_fiksuoti_vilkikai_det_locked d/);
  assert.ok(!/FROM kastai_fiksuoti_vilkikai_det d/.test(locked), 'Locked never reads the current detail table');
  // Neither statement adds or subtracts one representation from the other.
  for (const sql of [current, locked]) {
    assert.ok(!/kastaiVilkiko\s*[-+]\s*s\.locked_kastaiVilkiko/.test(sql));
    assert.ok(!/locked_kastaiVilkiko\s*[-+]\s*s\.kastaiVilkiko/.test(sql));
  }
});

test('the authoritative total is read from the summary table and never recomputed from components', () => {
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  // The authoritative value is a plain column read.
  assert.match(sql, /SELECT a\.uzdavinys, a\.deleted, a\.kastaiVilkiko, a\.locked_kastaiVilkiko_data, t\.id AS taskId\s*\n\s*FROM kastai_fiksuoti_ataskaita a/);
  assert.match(sql, /CAST\(SUM\(r\.authoritative\) AS CHAR\) AS authoritativeTotal/);
  // The component sum is a separate quantity and is never aliased as authoritative.
  assert.ok(!/componentSum\s*\)?\s*AS authoritative\b/.test(sql), 'Component sum is never the authoritative total');
  assert.match(sql, /\) AS componentSum/);
  const authoritativeIndex = sql.indexOf('AS authoritativeTotal');
  const authoritativeExpression = sql.slice(sql.lastIndexOf('CAST(', authoritativeIndex), authoritativeIndex);
  assert.ok(!authoritativeExpression.includes('componentSum'), 'authoritativeTotal never references the component sum');
});

test('the breakdown exposes only verified ERP component field identifiers', async () => {
  const result = await run([groupRow()]);
  assert.deepEqual([...result.meta.componentFields], [...fixedCostComponentFields]);
  assert.equal(result.meta.componentFields.length, 15);
  assert.equal(result.meta.authoritativeSource, fixedCostAuthoritativeSource);
  assert.equal(result.meta.breakdownSource, fixedCostBreakdownSources.current);
  assert.equal((await run([groupRow()], { ...baseQuery, representation: 'locked' })).meta.breakdownSource, fixedCostBreakdownSources.locked);
  // No invented business label, cost group or classification version.
  assert.equal(result.meta.classificationApplied, false);
  assert.equal(result.meta.classificationVersion, null);
  assert.equal(result.meta.semanticsVersion, null);
  assert.doesNotMatch(JSON.stringify(result.meta.componentFields), /fuel|payroll|overhead|cost_group|category/i);
});

// --- decimal safety -----------------------------------------------------------

test('monetary values stay canonical decimal strings and are never parsed into numbers', async () => {
  const result = await run([groupRow({
    authoritativeTotal: '125430.20', comparableAuthoritativeTotal: '124000.00',
    componentTotal: '124980.10', netDifference: '0.30', grossAbsoluteDifference: '0.30',
  })]);
  const group = result.groups[0];
  for (const field of ['authoritativeTotal', 'comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference'] as const) {
    assert.equal(typeof group[field], 'string', `${field} is a string`);
  }
  // Exact passthrough: a float round-trip would not reproduce these digits.
  assert.equal(group.authoritativeTotal, '125430.20');
  assert.equal(group.netDifference, '0.30');
  assert.notEqual(group.netDifference, String(0.1 + 0.2));
  assert.equal(group.componentTotal, '124980.10', 'Trailing zero preserved');
  // Negative and large magnitudes survive unchanged.
  const signed = await run([groupRow({ netDifference: '-12345678901.99', grossAbsoluteDifference: '12345678901.99' })]);
  assert.equal(signed.groups[0].netDifference, '-12345678901.99');
  assert.equal(signed.groups[0].grossAbsoluteDifference, '12345678901.99');
});

test('non-decimal monetary payloads fail closed rather than being coerced', async () => {
  for (const value of [125430.2, '125430', '125,430.20', '1.2e5', 'NaN', '', true, {}, []]) {
    await assert.rejects(run([groupRow({ authoritativeTotal: value as string })]), InvalidFixedCostMonetaryResult, String(value));
  }
  // SUM() over an empty comparable set is NULL and stays null, never a fabricated zero.
  const empty = await run([groupRow({ comparable: 0, noDetail: 3 })]);
  assert.equal(empty.groups[0].componentTotal, null);
  assert.equal(empty.groups[0].authoritativeTotal, '125430.20', 'The real authoritative total survives');
  for (const bad of [1, '1', 'x', null]) assert.throws(() => assertDecimalString(bad, 'field'), InvalidFixedCostMonetaryResult);
  assert.equal(assertDecimalString('-0.01', 'field'), '-0.01');
});

test('every monetary aggregate is computed in SQL decimal arithmetic and cast to text', () => {
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  for (const alias of ['authoritativeTotal', 'comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference']) {
    assert.match(sql, new RegExp(`CAST\\([^]*?AS CHAR\\) AS ${alias}`), `${alias} is cast to text in SQL`);
  }
  // Subtraction and absolute value happen in SQL, not in TypeScript.
  assert.match(sql, /SUM\(CASE WHEN r\.comparable = 1 THEN r\.authoritative - r\.componentSum ELSE NULL END\)/);
  assert.match(sql, /SUM\(CASE WHEN r\.comparable = 1 THEN ABS\(r\.authoritative - r\.componentSum\) ELSE NULL END\)/);
});

test('net and gross absolute differences are distinct and gross prevents cancellation', async () => {
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  const net = sql.slice(sql.lastIndexOf('CAST(', sql.indexOf('AS netDifference')), sql.indexOf('AS netDifference'));
  const gross = sql.slice(sql.lastIndexOf('CAST(', sql.indexOf('AS grossAbsoluteDifference')), sql.indexOf('AS grossAbsoluteDifference'));
  assert.ok(!net.includes('ABS('), 'Net difference is signed and keeps its sign');
  assert.ok(gross.includes('ABS(r.authoritative - r.componentSum)'), 'Gross applies ABS per record before summing');
  assert.notEqual(net, gross);
  // Opposite-signed records cancel in net but not in gross: +10.05 and -10.02.
  const result = await run([groupRow({ comparable: 2, netDifference: '0.03', grossAbsoluteDifference: '20.07' })]);
  assert.equal(result.groups[0].netDifference, '0.03');
  assert.equal(result.groups[0].grossAbsoluteDifference, '20.07');
  assert.notEqual(result.groups[0].netDifference, result.groups[0].grossAbsoluteDifference);
});

// --- reconciliation buckets ---------------------------------------------------

test('bucket counters reuse the committed Slice 4 ladder without redefining it', () => {
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  assert.deepEqual(fixedCostDifferenceLadder.map(entry => entry.maxEur), ['0.00', '0.01', '1.00', '10.00', '100.00', null]);
  for (const [index, { bucket, maxEur }] of fixedCostDifferenceLadder.entries()) {
    const previous = fixedCostDifferenceLadder[index - 1]?.maxEur;
    assert.match(sql, new RegExp(`AS bucket_${bucket}\\b`), `${bucket} counter`);
    if (previous !== undefined) assert.ok(sql.includes(`> ${previous}`), `${bucket} lower bound`);
    if (maxEur !== null) assert.ok(sql.includes(`<= ${maxEur} THEN 1 ELSE 0 END) AS bucket_${bucket}`), `${bucket} upper bound`);
  }
  // Every bucket comparison is absolute and gated on comparable records.
  for (const bucket of fixedCostDifferenceBuckets) {
    const end = sql.indexOf(`AS bucket_${bucket}`);
    assert.ok(end > 0, `${bucket} counter present`);
    const expression = sql.slice(sql.lastIndexOf('SUM(CASE WHEN', end), end);
    assert.ok(expression.startsWith('SUM(CASE WHEN r.comparable = 1'), `${bucket} counts comparable records only`);
    assert.ok(expression.includes('ABS(r.authoritative - r.componentSum)'), `${bucket} compares absolute differences`);
  }
});

test('structurally non-comparable records are counted, never bucketed and never zero-filled', async () => {
  const result = await run([groupRow({
    comparable: 5, noDetail: 3, multipleDetail: 2, missingTotal: 1,
    buckets: { exact: 2, rounding: 1, small: 1, large: 1 },
    componentTotal: '900.00', comparableAuthoritativeTotal: '901.00', authoritativeTotal: '1500.00',
  })]);
  const group = result.groups[0];
  assert.equal(group.authoritativeRecords, 11, 'Non-comparable records stay in the authoritative population');
  assert.equal(group.comparableRecords, 5);
  assert.equal(group.noDetailRecords, 3);
  assert.equal(group.multipleDetailRecords, 2);
  assert.equal(group.missingTotalRecords, 1);
  const bucketed = fixedCostDifferenceBuckets.reduce((sum, name) => sum + group.buckets[name], 0);
  assert.equal(bucketed, group.comparableRecords, 'Buckets cover comparable records only');
  assert.equal(group.affectedRecords, 3);
  // No fabricated zero component total: componentTotal spans comparable records only.
  assert.equal(group.componentTotal, '900.00');
  assert.equal(group.comparableAuthoritativeTotal, '901.00');
  assert.notEqual(group.authoritativeTotal, group.comparableAuthoritativeTotal);
  // The SQL only treats a single matching detail row as comparable.
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  assert.match(sql, /j\.detailRows = 1 AND j\.componentSum IS NOT NULL THEN 1 ELSE 0 END AS comparable/);
});

test('inconsistent record accounting fails closed', async () => {
  const valid = groupRow({ comparable: 4, noDetail: 1 });
  for (const row of [
    { ...valid, authoritativeRecords: 4 },
    { ...valid, bucket_exact: 3 },
    { ...valid, comparableRecords: 3 },
    { ...valid, affectedRecords: 2 },
    { ...valid, affectedRecords: 99 },
    { ...valid, noDetailRecords: 'PRIVATE' },
    { ...valid, bucket_large: -1 },
  ]) {
    await assert.rejects(run([row]), (error: unknown) => {
      assert.ok(error instanceof InvalidFixedCostMonetaryResult);
      assert.doesNotMatch(String(error), /PRIVATE/);
      return true;
    });
  }
});

// --- bounds, ordering and execution -------------------------------------------

test('the statement is static, unqualified, bound-parameterized and deterministically ordered', async () => {
  const { pool, calls } = fixture(() => [groupRow()]);
  await queryFixedCostMonetaryTotals(pool, gate(), { ...baseQuery, truckIds: [11, 22, 33] }, approved, now);
  assert.equal(calls.length, 1);
  const { sql, values } = calls[0];
  assert.deepEqual(values, ['2025-03-01', '2025-04-01', 11, 22, 33], 'All caller input is bound');
  assert.equal((sql.match(/\?/g) ?? []).length, values.length);
  assert.ok(!sql.includes('11') || !/IN \(11/.test(sql), 'Truck identifiers are never interpolated');
  assert.ok(!sql.includes('2025-03') && !sql.includes('2025-04'), 'The period never reaches the statement text');
  assert.match(sql, /IN \(\?, \?, \?\)/);
  assert.ok(!sql.includes('infot_2'), 'No hardcoded schema qualifier');
  assert.doesNotMatch(sql, /`?\w+`?\s*\.\s*`?(kastai_fiksuoti_ataskaita|kastai_fiksuoti_vilkikai_det|kastai_fiksuoti_vilkikai_det_locked|uzdaviniai)\b/);
  assert.match(sql, /ORDER BY a\.uzdavinys/, 'Deterministic record ordering');
  assert.match(sql, /ORDER BY r\.deletedState/, 'Deterministic group ordering');
  assert.match(sql, /LIMIT 101\b/, 'Row bound plus truncation sentinel');
  const referenced = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]);
  assert.deepEqual([...new Set(referenced)].sort(), ['kastai_fiksuoti_ataskaita', 'kastai_fiksuoti_vilkikai_det', 'uzdaviniai']);
});

test('a period exceeding the record bound yields no partial monetary result', async () => {
  // The statement reads limit + 1; exceeding the bound must raise, not return a partial sum.
  await assert.rejects(
    run([groupRow({ comparable: 101 })], { ...baseQuery, limit: 100 }),
    (error: unknown) => {
      assert.ok(error instanceof FixedCostMonetaryTruncated);
      assert.equal(error.recordLimit, 100);
      return true;
    },
  );
  // Split across declared states, the bound still applies to the whole population.
  await assert.rejects(
    run([groupRow({ deletedState: 'zero', comparable: 60 }), groupRow({ deletedState: 'one', comparable: 41 })], { ...baseQuery, limit: 100 }),
    FixedCostMonetaryTruncated,
  );
  const withinBound = await run([groupRow({ comparable: 100 })], { ...baseQuery, limit: 100 });
  assert.equal(withinBound.meta.recordsRead, 100);
  assert.equal(withinBound.meta.truncated, false);
  assert.equal(withinBound.meta.complete, true);
});

test('execution runs through the analytics gate, respects saturation and sanitizes errors', async () => {
  const shared = new AnalyticsGate(1, 6, 1000);
  const { pool, peak } = fixture(() => [groupRow()]);
  await Promise.all(Array.from({ length: 4 }, () => queryFixedCostMonetaryTotals(pool, shared, baseQuery, approved, now)));
  assert.equal(peak(), 1, 'Gate serialized the statements');
  assert.equal(shared.active, 0);
  assert.equal(shared.waiting, 0);

  const busy = new AnalyticsGate(1, 0, 1000);
  const blocker = fixture(async () => { await setImmediate(); return [groupRow()]; });
  const held = busy.run(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  // Saturation stays a deterministic SERVICE_BUSY rather than being flattened into
  // REPLICA_UNAVAILABLE, so callers can still distinguish busy from unavailable.
  await assert.rejects(queryFixedCostMonetaryTotals(blocker.pool, busy, baseQuery, approved, now), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'SERVICE_BUSY');
    assert.equal(error.statusCode, 503);
    return true;
  });
  await held;

  for (const [driverCode, timeout] of [['ER_PARSE_ERROR', false], ['ER_STATEMENT_TIMEOUT', true], ['ER_QUERY_INTERRUPTED', true]] as const) {
    const secret = Object.assign(new Error('SELECT kastaiVilkiko WHERE uzdavinys=810000001 AND masinos_nr=PRIVATE'), {
      code: driverCode, sql: 'SELECT private_sql', parameters: ['2025-03-01', 4242], amount: '125430.20', registration: 'PRIVATE',
    });
    const { pool: failing } = fixture(() => { throw new Error('private wrapper', { cause: secret }); });
    await assert.rejects(queryFixedCostMonetaryTotals(failing, gate(), baseQuery, approved, now), (error: unknown) => {
      assert.ok(error instanceof FixedCostMonetaryError);
      assert.equal(error.code, timeout ? 'QUERY_TIMEOUT' : 'REPLICA_UNAVAILABLE');
      assert.equal(error.statusCode, timeout ? 504 : 503);
      assert.equal(error.cause, undefined);
      assert.ok(error.diagnostics.some(entry => entry.code === driverCode));
      assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /SELECT|private|PRIVATE|810000001|4242|125430/);
      return true;
    });
  }
});

test('the result carries no task IDs, truck identifiers, dates or raw rows', async () => {
  const contaminated = {
    ...groupRow(),
    uzdavinys: 810000001, taskId: 810000001, truckId: 4242, masinos_nr: 'PRIVATE',
    kastai_data: new Date('2025-03-01T00:00:00Z'), rawRow: { amount: '99.99' },
  };
  const result = await run([contaminated], { ...baseQuery, truckIds: [4242] });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /810000001|4242|PRIVATE|99\.99|rawRow/);
  assert.deepEqual(Object.keys(result).sort(), ['groups', 'meta']);
  for (const group of result.groups) {
    assert.deepEqual(Object.keys(group).sort(), [
      'affectedRecords', 'authoritativeRecords', 'authoritativeTotal', 'buckets', 'comparableAuthoritativeTotal',
      'comparableRecords', 'componentTotal', 'deletedState', 'grossAbsoluteDifference', 'lockedRecords',
      'missingTaskCount', 'missingTotalRecords', 'multipleDetailRecords', 'netDifference', 'noDetailRecords',
      'reconciliationStatus', 'unknownLockRecords', 'unlockedRecords',
    ]);
  }
  assert.equal(result.meta.currency, 'EUR');
  assert.equal(result.meta.reconciliationStatus, 'unreconciled');
  assert.ok(result.meta.pendingApprovals.includes('FC-03') && result.meta.pendingApprovals.includes('FC-11'));
  assert.ok(result.meta.limitations.some(entry => /never recomputed from components/.test(entry)));
  assert.ok(result.meta.limitations.some(entry => /kastai_data/.test(entry)), 'Index blocker stated in metadata');
});

// --- mutation checks ----------------------------------------------------------

test('mutation: the safety guards fail when sources, totals, bounds or the policy change', async () => {
  const current = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  const locked = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery({ ...baseQuery, representation: 'locked' }, now));

  const separationGuard = (sql: string, representation: 'current' | 'locked') => {
    if (representation === 'current') {
      assert.ok(!/locked_kastaiVilkiko(?!_data)/.test(sql), 'current reads no locked amount');
      assert.ok(!sql.includes('kastai_fiksuoti_vilkikai_det_locked'), 'current reads no locked detail');
    } else {
      assert.ok(!/FROM kastai_fiksuoti_vilkikai_det d/.test(sql), 'locked reads no current detail');
    }
  };
  separationGuard(current, 'current');
  separationGuard(locked, 'locked');
  assert.throws(() => separationGuard(current.replaceAll('kastai_fiksuoti_vilkikai_det d', 'kastai_fiksuoti_vilkikai_det_locked d'), 'current'),
    assert.AssertionError, 'crossing current into the locked detail table must fail the guard');
  assert.throws(() => separationGuard(locked.replaceAll('kastai_fiksuoti_vilkikai_det_locked d', 'kastai_fiksuoti_vilkikai_det d'), 'locked'),
    assert.AssertionError, 'crossing locked into the current detail table must fail the guard');

  const authoritativeGuard = (sql: string) => {
    const index = sql.indexOf('AS authoritativeTotal');
    const expression = sql.slice(sql.lastIndexOf('CAST(', index), index);
    assert.ok(expression.includes('SUM(r.authoritative)'), 'authoritative total is the stored column');
    assert.ok(!expression.includes('componentSum'), 'authoritative total is never the component sum');
  };
  authoritativeGuard(current);
  assert.throws(() => authoritativeGuard(current.replace('CAST(SUM(r.authoritative) AS CHAR) AS authoritativeTotal', 'CAST(SUM(r.componentSum) AS CHAR) AS authoritativeTotal')),
    assert.AssertionError, 'replacing the authoritative total with the component sum must fail the guard');

  const grossGuard = (sql: string) => {
    const index = sql.indexOf('AS grossAbsoluteDifference');
    const expression = sql.slice(sql.lastIndexOf('CAST(', index), index);
    assert.ok(expression.includes('ABS(r.authoritative - r.componentSum)'), 'gross difference is absolute per record');
  };
  grossGuard(current);
  assert.throws(() => grossGuard(current.replace(
    'SUM(CASE WHEN r.comparable = 1 THEN ABS(r.authoritative - r.componentSum) ELSE NULL END) AS CHAR) AS grossAbsoluteDifference',
    'SUM(CASE WHEN r.comparable = 1 THEN r.authoritative - r.componentSum ELSE NULL END) AS CHAR) AS grossAbsoluteDifference')),
    assert.AssertionError, 'replacing gross with net must fail the guard');

  const boundGuard = (sql: string) => assert.match(sql, /LIMIT \d+\b/, 'row bound present');
  boundGuard(current);
  assert.throws(() => boundGuard(current.replace(/LIMIT \d+/, '')), assert.AssertionError, 'removing the row bound must fail the guard');

  // Bypassing the policy gate is a runtime guard, not a text guard.
  const { pool, calls } = fixture(() => [groupRow()]);
  await queryFixedCostMonetaryTotals(pool, gate(), baseQuery, approved, now);
  assert.equal(calls.length, 1, 'An approved policy executes');
  await assert.rejects(queryFixedCostMonetaryTotals(pool, gate(), baseQuery, { ...approved, approved: false }, now), FixedCostDeletedPolicyUnapproved);
  await assert.rejects(queryFixedCostMonetaryTotals(pool, gate(), baseQuery, { ...approved, approvedBy: '' }, now), FixedCostDeletedPolicyUnapproved);
  assert.equal(calls.length, 1, 'No further replica access after the policy gate rejects');
});

// --- public surface -----------------------------------------------------------

test('no public monetary route exists and all fixed-cost endpoints stay unverified', async () => {
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
    // The truck components route (MP-8) is the one deliberate exception, gated by the truck pilot flag.
    assert.ok([...routes].filter(path => path !== '/expense-analytics/fixed-costs/components').every(path => !/monetary|total|reconcil|component|breakdown-detail/i.test(path)), 'No monetary route');
    for (const path of [
      '/expense-analytics/fixed-costs/totals', '/expense-analytics/fixed-costs/monetary',
      '/fixed-costs/totals',
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
      const components = await app.inject(`/expense-analytics/fixed-costs/components?allocationScope=${scope}&dateFrom=2025-03-01&dateTo=2025-03-31`);
      assert.equal(components.statusCode, 422);
      assert.equal(components.json().error.code, 'SEMANTICS_UNVERIFIED');
    }
    assert.equal(calls.length, 0, 'No replica access from public endpoints');
  } finally { await app.close(); }
});

// --- correction 1: no fabricated zero monetary values -------------------------

test('a state group with only no-detail rows keeps its real total and nulls every comparison', async () => {
  // Mirrors the live `deleted = 1` group: real amounts, no usable breakdown at all.
  const result = await run([
    groupRow({ deletedState: 'zero', comparable: 4 }),
    groupRow({ deletedState: 'one', comparable: 0, noDetail: 363, authoritativeTotal: '98765.43' }),
  ], { ...baseQuery, limit: 1000 });
  const orphanState = result.groups.find(group => group.deletedState === 'one')!;
  assert.equal(orphanState.authoritativeRecords, 363);
  assert.equal(orphanState.authoritativeTotal, '98765.43', 'The real authoritative total is preserved');
  assert.equal(orphanState.comparableRecords, 0);
  assert.equal(orphanState.noDetailRecords, 363);
  for (const field of ['comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference'] as const) {
    assert.equal(orphanState[field], null, `${field} is null, not 0.00`);
  }
  assert.equal(orphanState.reconciliationStatus, 'structurally_non_comparable');
  // No detail row was converted into a zero-valued component.
  assert.equal(fixedCostDifferenceBuckets.reduce((sum, name) => sum + orphanState.buckets[name], 0), 0);
  assert.equal(orphanState.affectedRecords, 0);
  // The comparable group is unaffected and still reports decimal text.
  const comparableState = result.groups.find(group => group.deletedState === 'zero')!;
  assert.equal(comparableState.reconciliationStatus, 'unreconciled');
  assert.equal(typeof comparableState.componentTotal, 'string');
});

test('an empty comparable population is never reported as an exact zero reconciliation', async () => {
  const result = await run([groupRow({ comparable: 0, noDetail: 2, multipleDetail: 1 })]);
  const group = result.groups[0];
  assert.equal(group.buckets.exact, 0, 'No record is counted as an exact match');
  assert.notEqual(group.netDifference, '0.00');
  assert.notEqual(group.grossAbsoluteDifference, '0.00');
  assert.equal(group.netDifference, null);
  assert.equal(group.reconciliationStatus, 'structurally_non_comparable');
  // Serialized, the group carries no zero-amount string that could be misread.
  assert.doesNotMatch(JSON.stringify({
    componentTotal: group.componentTotal, netDifference: group.netDifference,
    grossAbsoluteDifference: group.grossAbsoluteDifference, comparableAuthoritativeTotal: group.comparableAuthoritativeTotal,
  }), /0\.00/);
  // The SQL itself uses NULL, not zero, for the empty comparable population.
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  for (const alias of ['comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference']) {
    const end = sql.indexOf(`AS ${alias}`);
    const expression = sql.slice(sql.lastIndexOf('CAST(', end), end);
    assert.ok(expression.includes('ELSE NULL END'), `${alias} uses ELSE NULL`);
    assert.ok(!expression.includes('ELSE 0 END'), `${alias} never falls back to zero`);
  }
});

test('mismatched comparable counts and comparison totals fail closed in both directions', async () => {
  const zeroComparable = groupRow({ comparable: 0, noDetail: 3 });
  for (const field of ['comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference']) {
    await assert.rejects(run([{ ...zeroComparable, [field]: '0.00' }]), (error: unknown) => {
      assert.ok(error instanceof InvalidFixedCostMonetaryResult);
      assert.match(String(error), new RegExp(`${field} must be null`));
      return true;
    }, `${field} = 0.00 without comparable records must fail`);
    await assert.rejects(run([{ ...zeroComparable, [field]: '12.34' }]), InvalidFixedCostMonetaryResult);
  }
  // With comparable records, a null comparison column is a lost value and fails closed.
  const withComparable = groupRow({ comparable: 3 });
  for (const field of ['comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference']) {
    await assert.rejects(run([{ ...withComparable, [field]: null }]), (error: unknown) => {
      assert.ok(error instanceof InvalidFixedCostMonetaryResult);
      assert.match(String(error), new RegExp(`${field} must be decimal text`));
      return true;
    }, `${field} = null with comparable records must fail`);
    // And a non-canonical string is still rejected.
    await assert.rejects(run([{ ...withComparable, [field]: 12.34 }]), InvalidFixedCostMonetaryResult);
  }
});

test('the authoritative total is null only when no record carries a stored total', async () => {
  const allMissing = await run([groupRow({ comparable: 0, missingTotal: 5, authoritativeTotal: null })]);
  assert.equal(allMissing.groups[0].authoritativeTotal, null);
  assert.equal(allMissing.groups[0].missingTotalRecords, 5);
  // A stored total present but reported as null, or absent but reported as text, both fail.
  await assert.rejects(run([groupRow({ comparable: 0, noDetail: 2, authoritativeTotal: null })]), InvalidFixedCostMonetaryResult);
  await assert.rejects(run([groupRow({ comparable: 0, missingTotal: 5, authoritativeTotal: '1.00' })]), InvalidFixedCostMonetaryResult);
});

// --- correction 2: orphan authoritative rows ----------------------------------

test('the task join is always a LEFT JOIN so orphan summary rows stay in the population', async () => {
  const unfiltered = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery(baseQuery, now));
  const filtered = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery({ ...baseQuery, truckIds: [11, 22] }, now));
  for (const sql of [unfiltered, filtered]) {
    assert.match(sql, /LEFT JOIN uzdaviniai t ON t\.id = a\.uzdavinys/, 'Task join is a LEFT JOIN');
    assert.ok(!/\n\s*JOIN uzdaviniai/.test(sql), 'No inner join to uzdaviniai');
    // The bound is applied after the period and any truck predicate.
    const where = sql.indexOf('WHERE a.kastai_data');
    assert.ok(where > 0 && sql.indexOf('LIMIT ', where) > where, 'LIMIT follows the filters');
    assert.ok(sql.indexOf('ORDER BY a.uzdavinys', where) > where);
  }
  // Orphans are never given an invented truck identity.
  assert.ok(!/IFNULL\(t\.|COALESCE\(t\.|NULLIF\(t\.uzdavinio_masina/.test(unfiltered), 'No invented truck fallback');
  // No truck is labelled with a placeholder identity. (`'unknown'` does appear, but
  // only as a lock-state category for a date the confirmed sentinel cannot classify.)
  assert.ok(!/uzdavinio_masina[^,\n]*'(unknown|orphan|none|n\/a)'/i.test(unfiltered), 'No placeholder truck identity');
  assert.ok(!/'orphan'/i.test(unfiltered));
  assert.match(unfiltered, /THEN 'unknown' END AS lockState|ELSE 'unknown' END AS lockState/, 'unknown is a lock state, not a truck');
  // missingTaskCount is derived from the unmatched task, not from a filter.
  assert.match(unfiltered, /SUM\(CASE WHEN r\.taskId IS NULL THEN 1 ELSE 0 END\) AS missingTaskCount/);
});

test('missing-task records are counted, keep their declared state and do not reduce the total', async () => {
  const result = await run([
    groupRow({ deletedState: 'zero', comparable: 10, noDetail: 2, missingTask: 2, authoritativeTotal: '5000.00' }),
    groupRow({ deletedState: 'one', comparable: 0, noDetail: 4, missingTask: 4, authoritativeTotal: '750.00' }),
  ]);
  const [zero, one] = result.groups;
  assert.equal(zero.missingTaskCount, 2);
  assert.equal(one.missingTaskCount, 4, 'Orphans stay in their declared row state');
  // Orphans remain inside the authoritative population and its total.
  assert.equal(zero.authoritativeRecords, 12);
  assert.equal(zero.authoritativeTotal, '5000.00');
  assert.equal(one.authoritativeTotal, '750.00');
  assert.equal(result.meta.missingTaskCount, 6, 'Roll-up across states');
  assert.equal(result.meta.truckFilterApplied, false);
  assert.equal(result.meta.recordsRead, 16);
  // An orphan without a usable detail match stays structurally non-comparable.
  assert.equal(one.comparableRecords, 0);
  assert.equal(one.reconciliationStatus, 'structurally_non_comparable');
  // A count exceeding the population fails closed.
  await assert.rejects(run([groupRow({ comparable: 2, missingTask: 3 })]), InvalidFixedCostMonetaryResult);
  for (const bad of [-1, 1.5, 'PRIVATE', null]) {
    await assert.rejects(run([{ ...groupRow({ comparable: 2 }), missingTaskCount: bad }]), InvalidFixedCostMonetaryResult);
  }
});

test('a truck filter binds placeholders only and deterministically excludes unmappable orphans', async () => {
  const { pool, calls } = fixture(() => [groupRow({ comparable: 3, missingTask: 0 })]);
  const result = await queryFixedCostMonetaryTotals(pool, gate(), { ...baseQuery, truckIds: [11, 22, 33] }, approved, now);
  const { sql, values } = calls[0];
  assert.deepEqual(values, ['2025-03-01', '2025-04-01', 11, 22, 33]);
  assert.match(sql, /AND t\.uzdavinio_masina IN \(\?, \?, \?\)/, 'Bound placeholders only');
  assert.ok(!/IN \([^?)]*\d/.test(sql), 'No identifier is interpolated into the IN list');
  assert.equal(result.meta.truckFilterApplied, true);
  // NULL IN (...) is not TRUE, so an orphan cannot satisfy a requested truck.
  assert.match(sql, /LEFT JOIN uzdaviniai t/);
  assert.ok(result.meta.limitations.some(entry => /truck filter cannot map them/.test(entry)), 'Limitation documented');
});

test('mutation: removing the left join or the orphan counter fails the guards', () => {
  const sql = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery({ ...baseQuery, truckIds: [11] }, now));
  const leftJoinGuard = (text: string) => {
    assert.match(text, /LEFT JOIN uzdaviniai t ON t\.id = a\.uzdavinys/);
    assert.ok(!/\n\s*JOIN uzdaviniai/.test(text), 'no inner join to uzdaviniai');
  };
  leftJoinGuard(sql);
  assert.throws(() => leftJoinGuard(sql.replace('LEFT JOIN uzdaviniai', 'JOIN uzdaviniai')),
    assert.AssertionError, 'reverting to an inner join must fail the guard');

  const orphanCounterGuard = (text: string) =>
    assert.match(text, /SUM\(CASE WHEN r\.taskId IS NULL THEN 1 ELSE 0 END\) AS missingTaskCount/);
  orphanCounterGuard(sql);
  assert.throws(() => orphanCounterGuard(sql.replace(/SUM\(CASE WHEN r\.taskId IS NULL THEN 1 ELSE 0 END\) AS missingTaskCount/, '0 AS missingTaskCount')),
    assert.AssertionError, 'dropping the orphan counter must fail the guard');

  const nullSumGuard = (text: string) => {
    for (const alias of ['comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference']) {
      const end = text.indexOf(`AS ${alias}`);
      assert.ok(text.slice(text.lastIndexOf('CAST(', end), end).includes('ELSE NULL END'), `${alias} uses ELSE NULL`);
    }
  };
  nullSumGuard(sql);
  assert.throws(() => nullSumGuard(sql.replaceAll('ELSE NULL END', 'ELSE 0 END')),
    assert.AssertionError, 'restoring the zero fallback must fail the guard');
});

// --- correction 3: explicit date basis ----------------------------------------

test('both representations filter the reporting period on the cost month and say so', async () => {
  const statements = (['current', 'locked'] as const).map(representation =>
    fixedCostMonetaryStatement(parseFixedCostMonetaryQuery({ ...baseQuery, representation }, now)));
  for (const sql of statements) {
    assert.match(sql, /WHERE a\.kastai_data >= \? AND a\.kastai_data < \?/, 'Period filter is the cost month');
    // The lock date may be read as lock-state metadata, but never compared, ranged
    // or bound as a reporting period.
    assert.ok(!/locked_kastaiVilkiko_data\s*(>=|<=|<|>)/.test(sql), 'Lock date is never a range bound');
    assert.ok(!/WHERE[^()]*locked_kastaiVilkiko_data\s*(>=|<=|<|>|=)\s*\?/.test(sql), 'Lock date is never a bound period predicate');
    assert.equal((sql.match(/\?/g) ?? []).length, 2, 'Only the two cost-month bounds are bound');
  }
  // Both representations use the identical period predicate.
  const predicate = /WHERE a\.\w+ >= \? AND a\.\w+ < \?/;
  assert.equal(predicate.exec(statements[0])![0], predicate.exec(statements[1])![0], 'Same approved cost-month basis');
  for (const representation of ['current', 'locked'] as const) {
    const result = await run([groupRow()], { ...baseQuery, representation });
    assert.equal(result.meta.dateBasis, 'kastai_data');
    assert.equal(result.meta.representation, representation);
  }
  const result = await run([groupRow()]);
  assert.ok(result.meta.limitations.some(entry => /lock-event metadata, never the period filter/.test(entry)));
});

test('component reads are opt-in, static, and leave the default statement unchanged', () => {
  for (const representation of ['current', 'locked'] as const) {
    const base = parseFixedCostMonetaryQuery({ ...baseQuery, representation }, now);
    const plain = fixedCostMonetaryStatement(base);
    const withComponents = fixedCostMonetaryStatement(parseFixedCostMonetaryQuery({ ...baseQuery, representation, includeComponents: true }, now));
    assert.doesNotMatch(plain, /component_|\bc_/, 'Default statement reads no per-component column');
    assert.equal(withComponents.replace(/,\n[^\n]*\bc_\w+[^\n]*?(?=,?\n|$)/g, ''), plain, 'Only component lines are added');
    for (const field of fixedCostComponentFields) {
      assert.ok(withComponents.includes(`(SELECT SUM(d.${field}) FROM ${fixedCostBreakdownSources[representation]} d WHERE d.uzdavinys = s.uzdavinys) AS c_${field}`), field);
      assert.ok(withComponents.includes(`CAST(SUM(CASE WHEN r.comparable = 1 THEN r.c_${field} ELSE NULL END) AS CHAR) AS component_${field}`), field);
    }
  }
  for (const includeComponents of [false, 'true', 1, null]) {
    assert.throws(() => parseFixedCostMonetaryQuery({ ...baseQuery, includeComponents }, now), InvalidFixedCostMonetaryQuery);
  }
});
