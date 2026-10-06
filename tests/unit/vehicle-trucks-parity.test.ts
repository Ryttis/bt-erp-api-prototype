import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { categorizeVehicles, defaultVehicleFields, listVehicles, optInVehicleFields, summarizeVehicles, type VehicleQuery } from '../../src/vehicles/repository.js';
import { vehicleFilterAliases } from '../../src/vehicles/routes.js';

// Capabilities migrated from the legacy ERP GET /plain/mcp/trucks endpoint.
const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
const auth = { authorization: `Bearer ${config.auth.serviceToken}` };
const defaults: VehicleQuery = { page: 1, per_page: 50, sort_by: 'plate_number', sort_direction: 'asc' };
const newJoins = /masinu_priekabu_savininkas|masinu_galiojimai|tipai_sarasai_visi/;
const originalDefaultFields = ['id', 'plate_number', 'make', 'model', 'vin', 'active', 'consumer_id', 'consumer_from', 'consumer_to', 'rent_price',
  'lessor_id', 'bank_id', 'lease_start', 'lease_end', 'last_payment_amount', 'manufactured_at', 'registration_date', 'mileage',
  'department', 'group', 'market', 'consumer_name', 'lessor_name', 'bank_name'];

function fixture(rows: unknown[] = [{ id: 1, plate_number: 'TEST' }], total = 1) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('COUNT(*) AS total')) return [{ total: BigInt(total) }];
    if (sql.includes('GROUP BY category_value')) return [];
    if (sql.includes('AS count')) return [{ count: 0 }];
    return rows;
  }, end: async () => {} } as ReplicaPool;
  return { pool, calls };
}
async function withApp<T>(pool: ReplicaPool, run: (app: ReturnType<typeof buildApp>) => Promise<T>) {
  const app = buildApp(config, () => pool, { authenticate: false });
  try { return await run(app); } finally { await app.close(); }
}

test('default representation and SQL are unchanged; migrated fields are opt-in', async () => {
  assert.deepEqual(defaultVehicleFields, originalDefaultFields);
  const { pool, calls } = fixture([Object.fromEntries(originalDefaultFields.map((key) => [key, key === 'id' ? 1 : null]))]);
  await withApp(pool, async (app) => {
    const response = await app.inject('/vehicles');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.json().data[0]), originalDefaultFields);
    for (const call of calls) assert.doesNotMatch(call.sql, newJoins);
  });
});

test('migrated fields project with verified sources, joins and null normalization', async () => {
  const cases = [
    { field: 'inactive_since', sql: /CAST\(m\.nebedirba_nuo AS CHAR\)/, join: null, raw: '0000-00-00', expected: null },
    { field: 'inactive_since', sql: /nebedirba_nuo/, join: null, raw: '2024-02-29', expected: '2024-02-29' },
    { field: 'owner_id', sql: /NULLIF\(o\.savininkas, 0\)/, join: /ORDER BY ou\.data_nuo DESC, ou\.id DESC LIMIT 1/, raw: 0, expected: null },
    { field: 'owner_id', sql: /NULLIF\(o\.savininkas, 0\)/, join: /masinu_priekabu_savininkas/, raw: 42n, expected: 42 },
    { field: 'owner_name', sql: /oc\.firmos_pavadinimas/, join: /klientai oc ON oc\.id = NULLIF\(o\.savininkas, 0\)/, raw: null, expected: null },
    { field: 'ownership_status', sql: /ost\.pavadinimas/, join: /tipai_sarasai_visi ost ON ost\.id = NULLIF\(o\.statusas, 0\)/, raw: 'Nuosava', expected: 'Nuosava' },
    { field: 'technical_inspection_valid_until', sql: /ti\.valid_until/, join: /gi\.ispejimo_id = 3 AND gi\.neaktualus = 0/, raw: '2026-10-01', expected: '2026-10-01' },
    { field: 'technical_inspection_valid_until', sql: /ti\.valid_until/, join: /MAX\(gi\.galioja_iki\)/, raw: '0000-00-00', expected: null },
    { field: 'civil_insurance_valid_until', sql: /ci\.valid_until/, join: /gc\.ispejimo_id = 8 AND gc\.neaktualus = 0/, raw: null, expected: null },
  ] as const;
  for (const item of cases) {
    const { pool, calls } = fixture([{ [item.field]: item.raw }]);
    const result = await listVehicles(pool, { ...defaults, fields: [item.field] });
    assert.deepEqual(result.data[0], { [item.field]: item.expected }, item.field);
    assert.match(calls[1].sql, item.sql);
    if (item.join) assert.match(calls[1].sql, item.join);
    else assert.doesNotMatch(calls[1].sql, /JOIN/);
    assert.doesNotMatch(calls[0].sql, /JOIN/, 'unfiltered count needs no joins');
  }
  const { pool } = fixture([Object.fromEntries(optInVehicleFields.map((key) => [key, null]))]);
  await withApp(pool, async (app) => {
    const response = await app.inject(`/vehicles?fields=plate_number,${optInVehicleFields.join(',')}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.json().data[0]), ['plate_number', ...optInVehicleFields]);
  });
});

test('each migrated filter binds its value with the expected condition and joins', async () => {
  const cases: [string, RegExp, unknown[], RegExp | null][] = [
    ['inactive_since_from=2024-01-01&inactive_since_to=2024-12-31', /nebedirba_nuo[\s\S]* >= \?[\s\S]*nebedirba_nuo[\s\S]* <= \?/, ['2024-01-01', '2024-12-31'], null],
    ['technical_inspection_valid_until_from=2026-09-24&technical_inspection_valid_until_to=2026-10-24', /ti\.valid_until[\s\S]* >= \?[\s\S]* <= \?/, ['2026-09-24', '2026-10-24'], /gi\.ispejimo_id = 3/],
    ['civil_insurance_valid_until_to=2026-10-24', /ci\.valid_until[\s\S]* <= \?/, ['2026-10-24'], /gc\.ispejimo_id = 8/],
    ['owner_id=77', /NULLIF\(o\.savininkas, 0\) = \?/, [77], /masinu_priekabu_savininkas/],
    ['owner_name=50%25_off', /LOWER\(oc\.firmos_pavadinimas\) LIKE LOWER\(\?\) ESCAPE '!'/, ['%50!%!_off%'], /klientai oc/],
    ['ownership_status=nuosava', /LOWER\(ost\.pavadinimas\) = LOWER\(\?\)/, ['nuosava'], /tipai_sarasai_visi ost/],
  ];
  for (const [query, condition, values, join] of cases) {
    const { pool, calls } = fixture();
    await withApp(pool, async (app) => {
      assert.equal((await app.inject(`/vehicles?fields=id&${query}`)).statusCode, 200, query);
      assert.equal((await app.inject(`/vehicles?view=summary&metric=count&${query}`)).statusCode, 200, query);
      assert.equal((await app.inject(`/vehicles?view=distinct&field=make&${query}`)).statusCode, 200, query);
      assert.equal((await app.inject(`/vehicles?view=grouped&group_by=make&metric=count&${query}`)).statusCode, 200, query);
    });
    assert.equal(calls.length, 5);
    const where = calls[0].sql.split('WHERE ').at(-1)!.trim();
    for (const call of calls) {
      assert.match(call.sql, condition, query);
      assert.ok(call.sql.includes(where), `${query}: identical WHERE across views`);
      if (join) assert.match(call.sql, join, query);
    }
    assert.deepEqual(calls[0].values, values, query);
    assert.deepEqual(calls[1].values, [...values, 50, 0], query);
    for (const call of calls.slice(2)) assert.deepEqual(call.values, values, query);
  }
});

test('legacy filter aliases are exact synonyms of their canonical filters', async () => {
  assert.deepEqual(vehicleFilterAliases, { status: 'ownership_status', owner: 'owner_name', consumer: 'consumer_name', lessor: 'lessor_name', bank: 'bank_name' });
  for (const [alias, canonical] of Object.entries(vehicleFilterAliases)) {
    for (const view of ['fields=id', 'view=summary&metric=count']) {
      const legacy = fixture();
      const current = fixture();
      await withApp(legacy.pool, async (app) => assert.equal((await app.inject(`/vehicles?${view}&${alias}=Transline`)).statusCode, 200));
      await withApp(current.pool, async (app) => assert.equal((await app.inject(`/vehicles?${view}&${canonical}=Transline`)).statusCode, 200));
      assert.deepEqual(legacy.calls, current.calls, `${alias} -> ${canonical}`);
    }
  }
});

test('invalid migrated filters, alias conflicts and legacy-only parameters fail before DB access', async () => {
  const { pool, calls } = fixture();
  await withApp(pool, async (app) => {
    const invalid = ['owner_id=0', 'owner_id=-1', 'owner_id=abc', 'owner_name=', 'ownership_status=', `ownership_status=${'x'.repeat(201)}`,
      'status=', 'status=a&status=b', 'owner=a&owner_name=b', 'status=a&ownership_status=b', 'consumer=a&consumer_name=b',
      'lessor=a&lessor_name=b', 'bank=a&bank_name=b', 'inactive_since=2024-01-01', 'technical_inspection_valid_until=2026-01-01',
      'sort=plate_number', 'status_id=1042', 'fields=owner_status', 'fields=status', 'sort_by=owner_id', 'view=distinct&field=owner_name'];
    for (const prefix of ['inactive_since', 'technical_inspection_valid_until', 'civil_insurance_valid_until']) {
      for (const date of ['0000-00-00', '2025-02-29', '2025-13-01', '2025-1-1', 'today']) invalid.push(`${prefix}_from=${date}`);
      invalid.push(`${prefix}_from=2025-02-01&${prefix}_to=2025-01-01`);
    }
    for (const query of invalid) {
      const response = await app.inject(`/vehicles?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual(response.json(), { error: { code: 'INVALID_QUERY', message: 'Invalid vehicle query' } });
    }
  });
  assert.equal(calls.length, 0);
});

test('migrated sort fields are allowlisted with null-last and deterministic id tie-break', async () => {
  for (const sort_by of ['inactive_since', 'owner_name', 'ownership_status', 'technical_inspection_valid_until', 'civil_insurance_valid_until']) {
    const { pool, calls } = fixture();
    await withApp(pool, async (app) => {
      const response = await app.inject(`/vehicles?fields=plate_number&sort_by=${sort_by}&sort_direction=desc`);
      assert.equal(response.statusCode, 200, sort_by);
      assert.deepEqual(response.json().meta.sort, { field: sort_by, direction: 'desc' });
    });
    assert.match(calls[1].sql, /ORDER BY [\s\S]+ IS NULL ASC, [\s\S]+ DESC, m\.id ASC\s+LIMIT \? OFFSET \?/);
    if (sort_by !== 'inactive_since') assert.match(calls[1].sql, newJoins, `${sort_by} sort joins its source`);
  }
});

test('pagination, empty results and combined old and new filters keep the rows contract', async () => {
  const paged = fixture([{ plate_number: 'A' }], 5);
  await withApp(paged.pool, async (app) => {
    const response = await app.inject('/vehicles?fields=plate_number&make=Volvo&active=1&technical_inspection_valid_until_to=2026-10-24&status=Lizingas&page=2&per_page=2');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().meta, { page: 2, per_page: 2, total: 5, last_page: 3, sort: { field: 'plate_number', direction: 'asc' } });
    assert.deepEqual(paged.calls[1].values, ['Volvo', 1, '2026-10-24', 'Lizingas', 2, 2]);
    assert.match(paged.calls[0].sql, /LOWER\(m\.marke_2\) = LOWER\(\?\) AND \([\s\S]*m\.nebedirba = 0[\s\S]*m\.nebedirba_nuo IS NULL[\s\S]*m\.nebedirba_nuo = '0000-00-00'[\s\S]*m\.nebedirba_nuo > CURDATE\(\)[\s\S]*m\.tipas_apskaitai != 1101[\s\S]*\) = \? AND [\s\S]+ AND LOWER\(ost\.pavadinimas\) = LOWER\(\?\)/);
    assert.equal((await app.inject('/vehicles?per_page=201&status=Nuosava')).statusCode, 400, 'page bound still applies');
  });
  const empty = fixture([], 0);
  await withApp(empty.pool, async (app) => {
    const response = await app.inject('/vehicles?owner=nobody&inactive_since_from=2099-01-01');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: [], meta: { page: 1, per_page: 50, total: 0, last_page: 0, sort: { field: 'plate_number', direction: 'asc' } } });
  });
});

test('ownership status and owner id are categorical analytics fields', async () => {
  const text = fixture();
  text.pool.query = (async (sql: string, values: unknown[]) => { text.calls.push({ sql, values }); return [{ category_value: Buffer.from('Nuosava'), count: 3n }, { category_value: null, count: 1n }]; }) as ReplicaPool['query'];
  assert.deepEqual(await categorizeVehicles(text.pool, { field: 'ownership_status', metrics: [] }, 'distinct'), {
    data: [{ value: 'Nuosava', count: 3 }, { value: null, count: 1 }], meta: { view: 'distinct', field: 'ownership_status', complete: true },
  });
  assert.match(text.calls[0].sql, /CAST\(CONVERT\(ost\.pavadinimas USING utf8mb4\) AS BINARY\)/);
  assert.match(text.calls[0].sql, /masinu_priekabu_savininkas[\s\S]+tipai_sarasai_visi/);
  const owner = fixture();
  owner.pool.query = (async (sql: string, values: unknown[]) => { owner.calls.push({ sql, values }); return [{ category_value: 0, count: 2 }]; }) as ReplicaPool['query'];
  assert.deepEqual((await categorizeVehicles(owner.pool, { field: 'owner_id', metrics: ['count'] }, 'grouped')).data, [{ group: null, count: 2 }]);
  const { pool } = fixture();
  await withApp(pool, async (app) => {
    assert.equal((await app.inject('/vehicles?view=distinct&field=ownership_status')).statusCode, 200);
    assert.equal((await app.inject('/vehicles?view=grouped&group_by=owner_id&metric=count&civil_insurance_valid_until_to=2026-12-31')).statusCode, 200);
  });
  const summary = fixture();
  await summarizeVehicles(summary.pool, { ownership_status: 'Lizingas', metrics: ['count'] });
  assert.match(summary.calls[0].sql, /tipai_sarasai_visi ost/);
});

test('migrated filters keep authentication, timeout and busy protections', async () => {
  const { pool, calls } = fixture();
  const app = buildApp(config, () => pool);
  try {
    for (const query of ['status=Nuosava', 'technical_inspection_valid_until_to=2026-10-24', 'owner=Transline']) {
      const denied = await app.inject(`/vehicles?${query}`);
      assert.equal(denied.statusCode, 401, query);
      assert.equal((await app.inject({ url: `/vehicles?${query}`, headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
    }
    assert.equal(calls.length, 0);
    assert.equal((await app.inject({ url: '/vehicles?status=Nuosava', headers: auth })).statusCode, 200);
  } finally { await app.close(); }

  const timeoutPool = { query: async () => { throw Object.assign(new Error('SELECT secret'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 }); }, end: async () => {} } as ReplicaPool;
  await withApp(timeoutPool, async (timeoutApp) => {
    for (const query of ['civil_insurance_valid_until_from=2026-01-01', 'view=summary&metric=count&inactive_since_from=2020-01-01']) {
      const response = await timeoutApp.inject(`/vehicles?${query}`);
      assert.equal(response.statusCode, 504, query);
      assert.deepEqual(response.json(), { error: { code: 'QUERY_TIMEOUT', message: 'Vehicle query timed out' } });
    }
  });

  const busyConfig = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters', ERP_ANALYTICS_CONCURRENCY: '1', ERP_ANALYTICS_QUEUE_LIMIT: '1', ERP_ANALYTICS_QUEUE_TIMEOUT_MS: '10' });
  const busyApp = buildApp(busyConfig, () => fixture().pool, { authenticate: false });
  try {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const active = busyApp.analyticsGate.run(async () => hold);
    const waiting = busyApp.analyticsGate.run(async () => hold);
    const busy = await busyApp.inject('/vehicles?view=grouped&group_by=ownership_status&metric=count');
    assert.equal(busy.statusCode, 503);
    assert.deepEqual(busy.json(), { error: { code: 'SERVICE_BUSY', message: 'Analytical service is busy' } });
    release();
    await active;
    await waiting;
  } finally { await busyApp.close(); }
});

// Representative requests BT Finance Analyst sends to the legacy endpoint, with the
// /vehicles request carrying the same intended meaning (see README migration table).
test('representative legacy /plain/mcp/trucks requests translate to equivalent /vehicles requests', async () => {
  const comparisons: { legacy: string; vehicles: string; condition: RegExp; values: unknown[] }[] = [
    { legacy: 'make=Volvo&per_page=3', vehicles: 'make=Volvo&per_page=3', condition: /LOWER\(m\.marke_2\) = LOWER\(\?\)/, values: ['Volvo'] },
    { legacy: 'active=1', vehicles: 'active=1', condition: /\([\s\S]*m\.nebedirba = 0[\s\S]*m\.nebedirba_nuo IS NULL[\s\S]*m\.nebedirba_nuo = '0000-00-00'[\s\S]*m\.nebedirba_nuo > CURDATE\(\)[\s\S]*m\.tipas_apskaitai != 1101[\s\S]*\) = \?/, values: [1] },
    { legacy: 'active=0&inactive_since_from=2024-01-01&inactive_since_to=2024-12-31', vehicles: 'active=0&inactive_since_from=2024-01-01&inactive_since_to=2024-12-31', condition: /nebedirba_nuo/, values: [0, '2024-01-01', '2024-12-31'] },
    { legacy: 'status=Nuosava', vehicles: 'ownership_status=Nuosava', condition: /LOWER\(ost\.pavadinimas\) = LOWER\(\?\)/, values: ['Nuosava'] },
    { legacy: 'owner=transline', vehicles: 'owner_name=transline', condition: /LOWER\(oc\.firmos_pavadinimas\) LIKE/, values: ['%transline%'] },
    { legacy: 'consumer=transline', vehicles: 'consumer_name=transline', condition: /LOWER\(c\.firmos_pavadinimas\) LIKE/, values: ['%transline%'] },
    { legacy: 'lessor=rental', vehicles: 'lessor_name=rental', condition: /LOWER\(lc\.firmos_pavadinimas\) LIKE/, values: ['%rental%'] },
    { legacy: 'bank=seb', vehicles: 'bank_name=seb', condition: /LOWER\(bc\.firmos_pavadinimas\) LIKE/, values: ['%seb%'] },
    { legacy: 'active=1&technical_inspection_valid_until_from=2026-08-27&technical_inspection_valid_until_to=2026-09-26', vehicles: 'active=1&technical_inspection_valid_until_from=2026-08-27&technical_inspection_valid_until_to=2026-09-26', condition: /ti\.valid_until/, values: [1, '2026-08-27', '2026-09-26'] },
    { legacy: 'civil_insurance_valid_until_from=2026-01-01&civil_insurance_valid_until_to=2026-12-31', vehicles: 'civil_insurance_valid_until_from=2026-01-01&civil_insurance_valid_until_to=2026-12-31', condition: /ci\.valid_until/, values: ['2026-01-01', '2026-12-31'] },
    { legacy: 'lease_start_from=2024-01-01&lease_start_to=2024-12-31', vehicles: 'lease_start_from=2024-01-01&lease_start_to=2024-12-31', condition: /l\.data_nuo/, values: ['2024-01-01', '2024-12-31'] },
    { legacy: 'mileage_from=500000', vehicles: 'mileage_from=500000', condition: /s\.last_odometer >= \?/, values: [500000] },
    { legacy: 'plate_number=ab', vehicles: 'plate_number=ab', condition: /LOWER\(m\.masinos_nr\) LIKE/, values: ['%ab%'] },
    { legacy: 'model=fh', vehicles: 'model=fh', condition: /LOWER\(m\.modelis\) LIKE/, values: ['%fh%'] },
    { legacy: 'page=2&per_page=25', vehicles: 'page=2&per_page=25', condition: /LIMIT \? OFFSET \?/, values: [] },
  ];
  for (const { legacy, vehicles, condition, values } of comparisons) {
    const canonical = fixture();
    const aliased = fixture();
    await withApp(canonical.pool, async (app) => assert.equal((await app.inject(`/vehicles?${vehicles}`)).statusCode, 200, vehicles));
    await withApp(aliased.pool, async (app) => assert.equal((await app.inject(`/vehicles?${legacy}`)).statusCode, 200, `legacy spelling ${legacy}`));
    assert.deepEqual(aliased.calls, canonical.calls, `legacy spelling ${legacy} matches ${vehicles}`);
    assert.match(canonical.calls.map((call) => call.sql).join('\n'), condition, vehicles);
    assert.deepEqual(canonical.calls[0].values, values, vehicles);
  }
});
