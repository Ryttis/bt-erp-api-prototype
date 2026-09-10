import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
const auth = { authorization: `Bearer ${config.auth.serviceToken}` };

function schemaPool() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('COUNT(*) AS total')) return [{ total: 2 }];
    if (sql.includes('LEFT JOIN INFORMATION_SCHEMA.COLUMNS')) return [{ TABLE_NAME: 'invoices', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 12, COLUMN_NAME: 'invoice_number' }];
    if (sql.includes('FROM INFORMATION_SCHEMA.TABLES') && sql.includes('TABLE_NAME = ?')) return values[1] === 'invoices' ? [{ TABLE_NAME: 'invoices', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 12 }] : [];
    if (sql.includes('FROM INFORMATION_SCHEMA.TABLES')) return [{ TABLE_NAME: 'invoices', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 12 }];
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [{ COLUMN_NAME: 'id', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint(20) unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: 'auto_increment', ORDINAL_POSITION: 1 }, { COLUMN_NAME: 'invoice_number', DATA_TYPE: 'varchar', COLUMN_TYPE: 'varchar(64)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, COLUMN_KEY: '', EXTRA: '', ORDINAL_POSITION: 2 }];
    if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [{ INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id' }];
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) return [{ CONSTRAINT_NAME: 'fk_invoice_customer', COLUMN_NAME: 'customer_id', REFERENCED_TABLE_NAME: 'customers', REFERENCED_COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }];
    throw new Error('Unexpected query');
  }, end: async () => {} } as ReplicaPool;
  return { pool, calls };
}

test('schema endpoints require Bearer authentication while health remains public', async () => {
  const { pool } = schemaPool(); const app = buildApp(config, () => pool);
  try {
    assert.equal((await app.inject('/schema/tables')).statusCode, 401);
    assert.equal((await app.inject('/health')).statusCode, 200);
  } finally { await app.close(); }
});

test('schema table listing is paginated and contains metadata only', async () => {
  const { pool, calls } = schemaPool(); const app = buildApp(config, () => pool);
  try {
    const response = await app.inject({ url: '/schema/tables?page=1&per_page=10', headers: auth });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: [{ name: 'invoices', type: 'BASE TABLE', approximate_row_count: 12 }], meta: { page: 1, per_page: 10, total: 2, complete: true } });
    assert.ok(calls.every((call) => call.sql.includes('INFORMATION_SCHEMA')));
  } finally { await app.close(); }
});

test('schema search validates input, escapes LIKE terms, and returns matching-column shape', async () => {
  const { pool, calls } = schemaPool(); const app = buildApp(config, () => pool);
  try {
    for (const url of ['/schema/search', '/schema/search?q=', '/schema/search?q=x&extra=y', `/schema/search?q=${'a'.repeat(101)}`]) assert.equal((await app.inject({ url, headers: auth })).statusCode, 400, url);
    const response = await app.inject({ url: '/schema/search?q=invoice', headers: auth });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data[0], { name: 'invoices', type: 'BASE TABLE', approximate_row_count: 12, matching_columns: ['invoice_number'] });
    assert.deepEqual(response.json().meta, { query: 'invoice', result_count: 1, limit: 100, complete: true });
    assert.deepEqual(calls[0].values, ['%invoice%', 'infot_2', '%invoice%', 101]);
    await app.inject({ url: '/schema/search?q=%25_', headers: auth });
    assert.deepEqual(calls[1].values, ['%\\%\\_%', 'infot_2', '%\\%\\_%', 101]);
  } finally { await app.close(); }
});

test('schema detail returns column, index and foreign-key metadata but no business rows', async () => {
  const { pool, calls } = schemaPool(); const app = buildApp(config, () => pool);
  try {
    const response = await app.inject({ url: '/schema/tables/invoices', headers: auth });
    assert.equal(response.statusCode, 200);
    const data = response.json().data;
    assert.equal(data.name, 'invoices'); assert.equal(data.columns[0].auto_increment, true); assert.equal(data.columns[0].primary_key, true);
    assert.deepEqual(data.indexes, [{ name: 'PRIMARY', unique: true, columns: ['id'] }]);
    assert.deepEqual(data.foreign_keys, [{ name: 'fk_invoice_customer', columns: ['customer_id'], referenced_table: 'customers', referenced_columns: ['id'] }]);
    assert.deepEqual(response.json().meta, { columns_complete: true, indexes_complete: true, foreign_keys_complete: true });
    assert.ok(!response.body.includes('invoice business value'));
    assert.ok(calls.every((call) => call.sql.includes('INFORMATION_SCHEMA')));
  } finally { await app.close(); }
});

test('schema metadata reports truncation rather than silently claiming completeness', async () => {
  const overflow = Array.from({ length: 501 }, (_, index) => index);
  const pool = { query: async (sql: string) => {
    if (sql.includes('COUNT(*) AS total')) return [{ total: 101 }];
    if (sql.includes('LEFT JOIN INFORMATION_SCHEMA.COLUMNS')) return overflow.map((index) => ({ TABLE_NAME: `table_${index}`, TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 0, COLUMN_NAME: 'invoice_id' }));
    if (sql.includes('FROM INFORMATION_SCHEMA.TABLES') && sql.includes('TABLE_NAME = ?')) return [{ TABLE_NAME: 'invoices', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 0 }];
    if (sql.includes('FROM INFORMATION_SCHEMA.TABLES')) return [{ TABLE_NAME: 'invoices', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 0 }];
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return overflow.map((index) => ({ COLUMN_NAME: `column_${index}`, DATA_TYPE: 'int', COLUMN_TYPE: 'int(11)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, COLUMN_KEY: '', EXTRA: '', ORDINAL_POSITION: index }));
    if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return overflow.map((index) => ({ INDEX_NAME: `index_${index}`, NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id' }));
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) return overflow.map((index) => ({ CONSTRAINT_NAME: `fk_${index}`, COLUMN_NAME: 'id', REFERENCED_TABLE_NAME: 'parent', REFERENCED_COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }));
    throw new Error('Unexpected query');
  }, end: async () => {} } as ReplicaPool;
  const app = buildApp(config, () => pool);
  try {
    const listing = await app.inject({ url: '/schema/tables?per_page=100', headers: auth });
    assert.equal(listing.json().meta.complete, false);
    const search = await app.inject({ url: '/schema/search?q=invoice', headers: auth });
    assert.equal(search.json().data.length, 100);
    assert.deepEqual(search.json().meta, { query: 'invoice', result_count: 100, limit: 100, complete: false });
    const detail = await app.inject({ url: '/schema/tables/invoices', headers: auth });
    assert.equal(detail.json().data.columns.length, 500);
    assert.equal(detail.json().data.indexes.length, 500);
    assert.equal(detail.json().data.foreign_keys.length, 500);
    assert.deepEqual(detail.json().meta, { columns_complete: false, indexes_complete: false, foreign_keys_complete: false });
  } finally { await app.close(); }
});

test('unknown or SQL-shaped table names never interpolate input or read table rows', async () => {
  const { pool, calls } = schemaPool(); const app = buildApp(config, () => pool);
  try {
    const unknown = await app.inject({ url: '/schema/tables/not_a_table', headers: auth });
    assert.equal(unknown.statusCode, 404);
    const injection = await app.inject({ url: '/schema/tables/invoices%27%20OR%201%3D1--', headers: auth });
    assert.equal(injection.statusCode, 404);
    assert.ok(calls.every((call) => call.sql.includes('INFORMATION_SCHEMA')));
    assert.ok(calls.some((call) => call.values.includes("invoices' OR 1=1--")));
    assert.ok(calls.every((call) => !call.sql.includes("invoices' OR 1=1--")));
  } finally { await app.close(); }
});
