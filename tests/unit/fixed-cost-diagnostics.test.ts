import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import {
  fixedCostDiagnosticCategories, InvalidFixedCostDiagnosticInput,
  parseFixedCostDiagnosticInput, parseFixedCostDiagnosticTaskIds,
} from '../../src/fixed-costs/diagnostic-contract.js';
import { diagnoseFixedCosts, FixedCostDiagnosticError } from '../../src/fixed-costs/diagnostic-repository.js';

const summaryRow = {
  task: 'present', summary: 'present', summaryCardinality: 'one', truckTotals: 'equal',
  currentLocked: 'different', assignedTruck: 'populated_with_master',
  taskLockedTotals: 'different', taskTruckValue: 'positive', summaryCurrentValue: 'positive', summaryLockedValue: 'zero',
  summaryDeletedFlag: 'zero', summaryCurrentDate: 'valid_date', summaryLockedDate: 'zero_date', currentLockedDate: 'unclassified',
};
const detailRow = { details: 'present', detailCardinality: 'multiple', detailCurrentDate: 'mixed', detailLockedDate: 'summary_date_unusable' };
const detailKeys = ['details', 'detailCardinality', 'detailCurrentDate', 'detailLockedDate'];

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

test('invalid diagnostic inputs fail complete validation before any pool call', async () => {
  const { pool, calls } = fixture();
  const invalid = [
    { taskIds: [] }, { taskIds: Array.from({ length: 21 }, (_, i) => i + 1) },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123', null, undefined].map(id => ({ taskIds: [1, id] })),
    { taskIds: [1, 1] }, { taskIds: '1,2' }, { taskIds: null }, { taskIds: {} },
    null, undefined, [], {}, { taskIds: [1], extra: true }, { taskIds: new Array(1) },
    { taskIds: [1], [Symbol('extra')]: true }, Object.create({ taskIds: [1] }),
    Object.defineProperty({}, 'taskIds', { get() { throw new Error('Getter must not run'); } }),
  ];
  for (const input of invalid) await assert.rejects(diagnoseFixedCosts(pool, input), InvalidFixedCostDiagnosticInput);
  assert.equal(calls.length, 0);
});

test('environment parsing is strict, shares the contract and never forwards malformed or SQL-shaped input', async () => {
  const { pool, calls } = fixture();
  for (const value of [
    undefined, null, '', ' ', '1,', ',1', '1,,2', '1, 2', ' 1', '1\n', '01', '+1', '-1', '0', '1.0',
    '1e3', 'NaN', 'Infinity', '9007199254740992', '1,1', '[1,2]', 'null',
    '1); SELECT * FROM uzdaviniai --', '1 OR 1=1', Array.from({ length: 21 }, (_, i) => i + 1).join(','),
  ]) {
    await assert.rejects(async () => diagnoseFixedCosts(pool, parseFixedCostDiagnosticTaskIds(value)), InvalidFixedCostDiagnosticInput);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(parseFixedCostDiagnosticTaskIds('1,9007199254740991'), { taskIds: [1, Number.MAX_SAFE_INTEGER] });
  assert.equal(parseFixedCostDiagnosticTaskIds(Array.from({ length: 20 }, (_, i) => i + 1).join(',')).taskIds.length, 20);
});

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
// Independently allowlist the complete two statement shapes, including projection.
// A local date fragment keeps the expected text readable; it is not imported from source.
const valid = (date: string) => `(CAST(${date} AS CHAR) REGEXP '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
  AND CAST(RIGHT(CAST(${date} AS CHAR), 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(CAST(${date} AS CHAR), 7), '-01'))))`;
const allowedSql = new Set([
  `SELECT
    CASE WHEN t.id IS NULL THEN 'missing' ELSE 'present' END AS task,
    CASE WHEN s.uzdavinys IS NULL THEN 'missing' ELSE 'present' END AS summary,
    CASE WHEN s.uzdavinys IS NULL THEN 'zero' ELSE 'one' END AS summaryCardinality,
    CASE WHEN t.kastaiVilkiko IS NULL AND s.kastaiVilkiko IS NULL THEN 'both_missing'
      WHEN t.kastaiVilkiko IS NULL THEN 'left_missing' WHEN s.kastaiVilkiko IS NULL THEN 'right_missing'
      WHEN t.kastaiVilkiko = s.kastaiVilkiko THEN 'equal' ELSE 'different' END AS truckTotals,
    CASE WHEN s.kastaiVilkiko IS NULL AND s.locked_kastaiVilkiko IS NULL THEN 'both_missing'
      WHEN s.kastaiVilkiko IS NULL THEN 'left_missing' WHEN s.locked_kastaiVilkiko IS NULL THEN 'right_missing'
      WHEN s.kastaiVilkiko = s.locked_kastaiVilkiko THEN 'equal' ELSE 'different' END AS currentLocked,
    CASE WHEN t.id IS NULL THEN 'missing' WHEN t.uzdavinio_masina = 0 THEN 'zero'
      WHEN m.id IS NULL THEN 'populated_without_master' ELSE 'populated_with_master' END AS assignedTruck,
    CASE WHEN t.kastaiVilkiko IS NULL AND s.locked_kastaiVilkiko IS NULL THEN 'both_missing'
      WHEN t.kastaiVilkiko IS NULL THEN 'left_missing' WHEN s.locked_kastaiVilkiko IS NULL THEN 'right_missing'
      WHEN t.kastaiVilkiko = s.locked_kastaiVilkiko THEN 'equal' ELSE 'different' END AS taskLockedTotals,
    CASE WHEN t.kastaiVilkiko IS NULL THEN 'missing'
      WHEN t.kastaiVilkiko < 0 THEN 'negative' WHEN t.kastaiVilkiko = 0 THEN 'zero' ELSE 'positive' END AS taskTruckValue,
    CASE WHEN s.kastaiVilkiko IS NULL THEN 'missing'
      WHEN s.kastaiVilkiko < 0 THEN 'negative' WHEN s.kastaiVilkiko = 0 THEN 'zero' ELSE 'positive' END AS summaryCurrentValue,
    CASE WHEN s.locked_kastaiVilkiko IS NULL THEN 'missing'
      WHEN s.locked_kastaiVilkiko < 0 THEN 'negative' WHEN s.locked_kastaiVilkiko = 0 THEN 'zero' ELSE 'positive' END AS summaryLockedValue,
    CASE WHEN s.uzdavinys IS NULL THEN 'missing'
      WHEN s.deleted = 0 THEN 'zero' WHEN s.deleted = 1 THEN 'one' ELSE 'other' END AS summaryDeletedFlag,
    CASE WHEN s.kastai_data IS NULL THEN 'missing'
      WHEN CAST(s.kastai_data AS CHAR) = '0000-00-00' THEN 'zero_date'
      WHEN ${valid('s.kastai_data')} THEN 'valid_date' ELSE 'other' END AS summaryCurrentDate,
    CASE WHEN s.locked_kastaiVilkiko_data IS NULL THEN 'missing'
      WHEN CAST(s.locked_kastaiVilkiko_data AS CHAR) = '0000-00-00' THEN 'zero_date'
      WHEN ${valid('s.locked_kastaiVilkiko_data')} THEN 'valid_date' ELSE 'other' END AS summaryLockedDate,
    CASE WHEN s.kastai_data IS NULL AND s.locked_kastaiVilkiko_data IS NULL THEN 'both_missing'
      WHEN s.kastai_data IS NULL THEN 'left_missing'
      WHEN s.locked_kastaiVilkiko_data IS NULL THEN 'right_missing'
      WHEN NOT (${valid('s.kastai_data')} AND ${valid('s.locked_kastaiVilkiko_data')}) THEN 'unclassified'
      WHEN s.kastai_data = s.locked_kastaiVilkiko_data THEN 'equal'
      WHEN s.kastai_data < s.locked_kastaiVilkiko_data THEN 'current_before_locked'
      ELSE 'current_after_locked' END AS currentLockedDate
    FROM (SELECT ? AS task_id) requested
    LEFT JOIN uzdaviniai t ON t.id = requested.task_id
    LEFT JOIN kastai_fiksuoti_ataskaita s ON s.uzdavinys = requested.task_id
    LEFT JOIN masinos m ON m.id = NULLIF(t.uzdavinio_masina, 0)`,
  `SELECT CASE WHEN COUNT(*) = 0 THEN 'missing' ELSE 'present' END AS details,
    CASE WHEN COUNT(*) = 0 THEN 'zero' WHEN COUNT(*) = 1 THEN 'one'
      WHEN COUNT(*) > 100 THEN 'over_limit' ELSE 'multiple' END AS detailCardinality,
    CASE WHEN COUNT(*) = 0 THEN 'no_details' WHEN COUNT(*) > 100 THEN 'unclassified'
      WHEN MIN(CASE WHEN ${valid('s.kastai_data')} THEN 1 ELSE 0 END) = 0 THEN 'summary_date_unusable'
      WHEN MIN(CASE WHEN ${valid('d.kastai_data')} THEN 1 ELSE 0 END) = 0 THEN 'detail_date_unusable'
      WHEN SUM(CASE WHEN d.kastai_data = s.kastai_data THEN 1 ELSE 0 END) = COUNT(*) THEN 'all_equal'
      WHEN SUM(CASE WHEN d.kastai_data = s.kastai_data THEN 1 ELSE 0 END) = 0 THEN 'none_equal'
      ELSE 'mixed' END AS detailCurrentDate,
    CASE WHEN COUNT(*) = 0 THEN 'no_details' WHEN COUNT(*) > 100 THEN 'unclassified'
      WHEN MIN(CASE WHEN ${valid('s.locked_kastaiVilkiko_data')} THEN 1 ELSE 0 END) = 0 THEN 'summary_date_unusable'
      WHEN MIN(CASE WHEN ${valid('d.kastai_data')} THEN 1 ELSE 0 END) = 0 THEN 'detail_date_unusable'
      WHEN SUM(CASE WHEN d.kastai_data = s.locked_kastaiVilkiko_data THEN 1 ELSE 0 END) = COUNT(*) THEN 'all_equal'
      WHEN SUM(CASE WHEN d.kastai_data = s.locked_kastaiVilkiko_data THEN 1 ELSE 0 END) = 0 THEN 'none_equal'
      ELSE 'mixed' END AS detailLockedDate
    FROM (SELECT kastai_data FROM kastai_fiksuoti_vilkikai_det WHERE uzdavinys = ? LIMIT 101) d
    LEFT JOIN kastai_fiksuoti_ataskaita s ON s.uzdavinys = ?`,
].map(normalize));

test('valid samples execute only allowlisted parameterized statements sequentially and project categorical fields', async () => {
  // Synthetic inputs, never copied from the replica.
  const taskIds = Array.from({ length: 20 }, (_, i) => 810000001 + i);
  const { pool, calls, peak } = fixture(index => [index % 2 === 0
    ? { ...summaryRow, taskId: 999, vehicleId: 888, amount: '123.45', lockedAmount: '-77.10', registration: 'PRIVATE', kastai_data: new Date('2026-09-01T00:00:00Z'), lockDate: '2026-08-15' }
    : { ...detailRow, componentAmount: '456.78', detailDate: '2026-07-31' }]);
  const result = await diagnoseFixedCosts(pool, { taskIds });
  assert.equal(calls.length, 40);
  assert.equal(peak(), 1);
  for (const [index, call] of calls.entries()) {
    assert.ok(allowedSql.has(normalize(call.sql)), 'Allowlisted SQL shape');
    assert.equal((call.sql.match(/\?/g) ?? []).length, call.values.length);
    // Summary binds the task once; detail binds it for the bounded prefix and the summary PK.
    const taskId = taskIds[Math.floor(index / 2)];
    assert.deepEqual(call.values, index % 2 === 0 ? [taskId] : [taskId, taskId]);
    for (const id of taskIds) assert.ok(!call.sql.includes(String(id)));
    assert.ok(!call.sql.includes('infot_2.'), 'No hardcoded schema qualifier');
  }
  assert.deepEqual(result, {
    data: taskIds.map((_, inputPosition) => ({ inputPosition, ...summaryRow, ...detailRow })),
    meta: { sampleSize: 20, complete: true },
  });
  assert.doesNotMatch(JSON.stringify(result), /810000|999|888|123\.45|456\.78|77\.10|PRIVATE|2026-|taskId|vehicleId|amount|Amount|registration|kastai_data|lockDate|detailDate/);
});

test('diagnostic SQL uses only static unqualified allowlisted tables, never a hardcoded schema', async () => {
  // The configured ERP_REPLICA_DATABASE selects the schema; SQL must not bypass it.
  const { pool, calls } = fixture(index => [index % 2 === 0 ? summaryRow : detailRow]);
  await diagnoseFixedCosts(pool, { taskIds: [810000001] });
  assert.equal(calls.length, 2);
  const tables = ['uzdaviniai', 'kastai_fiksuoti_ataskaita', 'masinos', 'kastai_fiksuoti_vilkikai_det'];
  const referenced: string[] = [];
  for (const { sql } of calls) {
    assert.ok(!sql.includes('infot_2.'), 'No hardcoded infot_2 schema qualifier');
    assert.doesNotMatch(sql, /`?\w+`?\s*\.\s*`?(uzdaviniai|kastai_fiksuoti_ataskaita|masinos|kastai_fiksuoti_vilkikai_det)\b/);
    for (const [, target] of sql.matchAll(/\b(?:FROM|JOIN)\s+([^\s()]+)/gi)) referenced.push(target);
  }
  // The detail shape reads the summary PK row for its date comparisons.
  assert.deepEqual(referenced.sort(), [...tables, 'kastai_fiksuoti_ataskaita'].sort());
  for (const sql of allowedSql) assert.ok(!sql.includes('infot_2.'), 'Allowlist carries no schema qualifier');
});

test('validation copies the entire input before asynchronous work', async () => {
  const input = { taskIds: [810000001, 810000002] };
  const parsed = parseFixedCostDiagnosticInput(input);
  assert.notEqual(parsed.taskIds, input.taskIds);
  const { pool, calls } = fixture(index => [index % 2 === 0 ? summaryRow : detailRow]);
  const pending = diagnoseFixedCosts(pool, input);
  input.taskIds[1] = 0;
  input.taskIds.push(810000003);
  await pending;
  assert.deepEqual(calls.map(call => call.values), [[810000001], [810000001, 810000001], [810000002], [810000002, 810000002]]);
});

test('approved missing, equality, master and detail categories survive; overflow is incomplete', async () => {
  for (const [key, values] of Object.entries(fixedCostDiagnosticCategories)) {
    for (const value of values) {
      const summary = { ...summaryRow, ...(!detailKeys.includes(key) ? { [key]: value } : {}) };
      const detail = { ...detailRow, ...(detailKeys.includes(key) ? { [key]: value } : {}) };
      const { pool } = fixture(index => [index % 2 === 0 ? summary : detail]);
      const result = await diagnoseFixedCosts(pool, { taskIds: [810000001] });
      assert.equal(result.data[0][key as keyof typeof fixedCostDiagnosticCategories], value);
      assert.equal(result.meta.complete, value !== 'over_limit');
    }
  }
});

test('unexpected result cardinality and non-categorical values fail closed without exposing payloads', async () => {
  for (const rows of [[], [summaryRow, summaryRow], [{ ...summaryRow, truckTotals: '123.45 PRIVATE' }], [{ ...summaryRow, task: undefined }]]) {
    const { pool } = fixture(index => index === 0 ? rows : [detailRow]);
    await assert.rejects(diagnoseFixedCosts(pool, { taskIds: [810000001] }), (error: unknown) => {
      assert.ok(error instanceof FixedCostDiagnosticError);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /123\.45|PRIVATE|810000001/);
      return true;
    });
  }
  // Slice 3A categories: raw amounts, raw dates, driver Date objects, case/whitespace
  // variants, business-sounding labels and absent keys all fail closed.
  const malformed: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ ...summaryRow, taskTruckValue: '-12.50' }, detailRow],
    [{ ...summaryRow, summaryCurrentValue: 0 }, detailRow],
    [{ ...summaryRow, summaryLockedValue: 'Zero' }, detailRow],
    [{ ...summaryRow, taskLockedTotals: 'approximately_equal' }, detailRow],
    [{ ...summaryRow, summaryDeletedFlag: 1 }, detailRow],
    [{ ...summaryRow, summaryDeletedFlag: 'deleted' }, detailRow],
    [{ ...summaryRow, summaryCurrentDate: '2026-09-01' }, detailRow],
    [{ ...summaryRow, summaryLockedDate: new Date('2026-09-01T00:00:00Z') }, detailRow],
    [{ ...summaryRow, currentLockedDate: 'current_before_locked ' }, detailRow],
    [{ ...summaryRow, summaryCurrentValue: 'reportable' }, detailRow],
    [Object.fromEntries(Object.entries(summaryRow).filter(([key]) => key !== 'currentLockedDate')), detailRow],
    [summaryRow, { ...detailRow, detailCurrentDate: '2026-07-31' }],
    [summaryRow, { ...detailRow, detailLockedDate: null }],
    [summaryRow, { details: 'present', detailCardinality: 'one', detailCurrentDate: 'all_equal' }],
  ];
  for (const [summary, detail] of malformed) {
    const { pool } = fixture(index => [index === 0 ? summary : detail]);
    await assert.rejects(diagnoseFixedCosts(pool, { taskIds: [810000001] }), (error: unknown) => {
      assert.ok(error instanceof FixedCostDiagnosticError);
      assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /12\.50|2026-|810000001|reportable|approximately/);
      return true;
    });
  }
});

test('driver failures and nested timeouts use sanitized repository diagnostics and stop subsequent queries', async () => {
  for (const [driverCode, timeout] of [['ER_PARSE_ERROR', false], ['ER_STATEMENT_TIMEOUT', true], ['ER_QUERY_INTERRUPTED', true]] as const) {
    for (const failAt of [0, 1]) {
      const secret = Object.assign(new Error('SELECT private_amount WHERE id=810000001 AND kastai_data=2026-09-01 AND masinos_nr=PRIVATE'), {
        code: driverCode, sql: 'SELECT private_sql', parameters: [810000001, 810000001], amount: '123.45', date: '2026-09-01', registration: 'PRIVATE',
      });
      const { pool, calls } = fixture(index => {
        if (index === failAt) throw new Error('private wrapper', { cause: secret });
        return [summaryRow];
      });
      await assert.rejects(diagnoseFixedCosts(pool, { taskIds: [810000001, 810000002] }), (error: unknown) => {
        assert.ok(error instanceof FixedCostDiagnosticError);
        assert.equal(error.code, timeout ? 'QUERY_TIMEOUT' : 'REPLICA_UNAVAILABLE');
        assert.equal(error.statusCode, timeout ? 504 : 503);
        assert.equal(error.cause, undefined);
        assert.ok(error.diagnostics.some(entry => entry.code === driverCode));
        assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /SELECT|private|PRIVATE|810000001|123\.45|2026-|parameters/);
        return true;
      });
      assert.equal(calls.length, failAt + 1);
    }
  }
});

test('diagnostics add no HTTP surface and all Slice 1 monetary capabilities remain disabled', async () => {
  const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool, { authenticate: false });
  const routes = new Set<string>();
  app.addHook('onRoute', route => { routes.add(route.url); });
  try {
    await app.ready();
    assert.deepEqual([...routes].filter(path => path.includes('fixed-costs')).sort(), [
      '/expense-analytics/fixed-costs/available-periods',
      '/expense-analytics/fixed-costs/breakdown', '/expense-analytics/fixed-costs/dimensions', '/expense-analytics/fixed-costs/summary',
    ]);
    assert.ok([...routes].every(path => !/diagnostic/i.test(path)));
    for (const [scope, capability] of Object.entries(fixedCostSemanticCapabilities)) {
      assert.equal(capability.enabled, false);
      for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
        const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?allocationScope=${scope}`);
        assert.equal(response.statusCode, 422);
        assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
    }
    for (const path of ['/expense-analytics/fixed-costs/diagnostics', '/expense-analytics/fixed-costs/diagnostic', '/fixed-costs/diagnostics']) {
      for (const method of ['GET', 'POST'] as const) assert.equal((await app.inject({ method, url: path })).statusCode, 404);
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});
