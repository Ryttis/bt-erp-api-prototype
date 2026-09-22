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
};
const detailRow = { details: 'present', detailCardinality: 'multiple' };

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
      WHEN m.id IS NULL THEN 'populated_without_master' ELSE 'populated_with_master' END AS assignedTruck
    FROM (SELECT ? AS task_id) requested
    LEFT JOIN uzdaviniai t ON t.id = requested.task_id
    LEFT JOIN kastai_fiksuoti_ataskaita s ON s.uzdavinys = requested.task_id
    LEFT JOIN masinos m ON m.id = NULLIF(t.uzdavinio_masina, 0)`,
  `SELECT CASE WHEN COUNT(*) = 0 THEN 'missing' ELSE 'present' END AS details,
    CASE WHEN COUNT(*) = 0 THEN 'zero' WHEN COUNT(*) = 1 THEN 'one'
      WHEN COUNT(*) > 100 THEN 'over_limit' ELSE 'multiple' END AS detailCardinality
    FROM (SELECT 1 FROM kastai_fiksuoti_vilkikai_det WHERE uzdavinys = ? LIMIT 101) bounded_details`,
].map(normalize));

test('valid samples execute only allowlisted parameterized statements sequentially and project categorical fields', async () => {
  // Synthetic inputs, never copied from the replica.
  const taskIds = Array.from({ length: 20 }, (_, i) => 810000001 + i);
  const { pool, calls, peak } = fixture(index => [index % 2 === 0
    ? { ...summaryRow, taskId: 999, vehicleId: 888, amount: '123.45', registration: 'PRIVATE' }
    : { ...detailRow, componentAmount: '456.78' }]);
  const result = await diagnoseFixedCosts(pool, { taskIds });
  assert.equal(calls.length, 40);
  assert.equal(peak(), 1);
  for (const [index, call] of calls.entries()) {
    assert.ok(allowedSql.has(normalize(call.sql)), 'Allowlisted SQL shape');
    assert.equal((call.sql.match(/\?/g) ?? []).length, call.values.length);
    assert.deepEqual(call.values, [taskIds[Math.floor(index / 2)]]);
    for (const id of taskIds) assert.ok(!call.sql.includes(String(id)));
    assert.ok(!call.sql.includes('infot_2.'), 'No hardcoded schema qualifier');
  }
  assert.deepEqual(result, {
    data: taskIds.map((_, inputPosition) => ({ inputPosition, ...summaryRow, ...detailRow })),
    meta: { sampleSize: 20, complete: true },
  });
  assert.doesNotMatch(JSON.stringify(result), /810000|999|888|123\.45|456\.78|PRIVATE|taskId|vehicleId|amount|registration/);
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
  assert.deepEqual(referenced.sort(), [...tables].sort());
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
  assert.deepEqual(calls.map(call => call.values), [[810000001], [810000001], [810000002], [810000002]]);
});

test('approved missing, equality, master and detail categories survive; overflow is incomplete', async () => {
  for (const [key, values] of Object.entries(fixedCostDiagnosticCategories)) {
    for (const value of values) {
      const summary = { ...summaryRow, ...(!['details', 'detailCardinality'].includes(key) ? { [key]: value } : {}) };
      const detail = { ...detailRow, ...(['details', 'detailCardinality'].includes(key) ? { [key]: value } : {}) };
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
});

test('driver failures and nested timeouts use sanitized repository diagnostics and stop subsequent queries', async () => {
  for (const [driverCode, timeout] of [['ER_PARSE_ERROR', false], ['ER_STATEMENT_TIMEOUT', true], ['ER_QUERY_INTERRUPTED', true]] as const) {
    for (const failAt of [0, 1]) {
      const secret = Object.assign(new Error('SELECT private_amount WHERE id=810000001'), {
        code: driverCode, sql: 'SELECT private_sql', parameters: [810000001], amount: '123.45',
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
        assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /SELECT|private|810000001|123\.45|parameters/);
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
