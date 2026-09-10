import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';

const config = loadConfig({ ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test', ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters' });
function fixture(rows: unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  return { calls, pool: { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return rows; }, end: async () => {} } as ReplicaPool };
}

test('invoice rows bind filters, project fields, sort deterministically and preserve nulls and negative amounts', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return sql.includes('COUNT(*) AS total') ? [{ total: 1 }] : [{ invoice_number: 'INV-1', customer_id: 0, issue_date: '0000-00-00', amount: '-42.50' }]; }, end: async () => {} } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const response = await app.inject('/invoices?invoice_number=INV%25&customer_name=Acme&fields=invoice_number,customer_id,issue_date,amount&sort_by=amount&sort_direction=asc&page=1&per_page=1');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, [{ invoice_number: 'INV-1', customer_id: null, issue_date: null, amount: -42.5 }]);
    assert.match(calls[1].sql, /ORDER BY i.suma IS NULL ASC, i.suma ASC, i.id DESC/);
    assert.deepEqual(calls[0].values, ['%INV!%%', '%Acme%']);
  } finally { await app.close(); }
});

test('summary enforces currency scope, aggregates only filtered currency and handles empty data', async () => {
  const { pool, calls } = fixture([{ count: 0, sum_amount: null, avg_amount: null, min_amount: null, max_amount: null }]);
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const rejected = await app.inject('/invoices?view=summary&metric=sum:amount');
    assert.deepEqual(rejected.json(), { error: { code: 'CURRENCY_SCOPE_REQUIRED', message: 'Currency scope is required for invoice amount analytics' } });
    const response = await app.inject('/invoices?view=summary&currency=EUR&issue_date_from=2026-01-01&metric=count&metric=sum:amount&metric=avg:amount&metric=min:amount&metric=max:amount');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { count: 0, sum_amount: null, avg_amount: null, min_amount: null, max_amount: null });
    assert.match(calls[0].sql, /ROUND\(SUM\(i.suma\), 2\)/);
    assert.deepEqual(calls[0].values, ['EUR', '2026-01-01']);
  } finally { await app.close(); }
});

test('categorical invoice views are bounded, deterministic, and require currency for non-currency monetary groups', async () => {
  const { pool } = fixture([{ category_value: Buffer.from('EUR'), count: 2, sum_amount: '-10.5' }]);
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const grouped = await app.inject('/invoices?view=grouped&group_by=currency&metric=count&metric=sum:amount');
    assert.equal(grouped.statusCode, 200);
    assert.deepEqual(grouped.json().data, [{ group: 'EUR', count: 2, sum_amount: -10.5 }]);
    assert.equal((await app.inject('/invoices?view=grouped&group_by=customer_name&metric=sum:amount')).json().error.code, 'CURRENCY_SCOPE_REQUIRED');
    assert.equal((await app.inject('/invoices?view=grouped&group_by=customer_name&currency=EUR&metric=sum:amount')).statusCode, 200);
  } finally { await app.close(); }
});

test('invoice validation rejects invalid ranges, fields and analytical pagination without leaking errors', async () => {
  const { pool, calls } = fixture([]); const app = buildApp(config, () => pool, { authenticate: false });
  try {
    for (const query of ['issue_date_from=2026-02-30', 'amount_from=2&amount_to=1', 'fields=amount,sql', 'view=grouped&group_by=id&metric=count', 'view=summary&metric=median:amount', 'view=distinct&field=currency&page=1', 'view=grouped&group_by=currency&metric=count&sort_by=amount']) {
      const response = await app.inject(`/invoices?${query}`); assert.equal(response.statusCode, 400, query); assert.ok(!response.body.includes('SELECT'));
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('invoice category overflow never returns partial complete data', async () => {
  const { pool } = fixture(Array.from({ length: 101 }, (_, index) => ({ category_value: `C${index}`, count: 1 })));
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    for (const query of ['view=distinct&field=currency', 'view=grouped&group_by=currency&metric=count']) {
      const response = await app.inject(`/invoices?${query}`); assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'CATEGORY_LIMIT_EXCEEDED');
    }
  } finally { await app.close(); }
});

test('ranked invoice grouping is explicitly bounded, ordered and incomplete', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return [{ category_value: 'Beta', count: 2, sum_amount: '100' }, { category_value: 'Alpha', count: 2, sum_amount: '100' }, { category_value: null, count: 1, sum_amount: null }];
  }, end: async () => {} } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    const response = await app.inject('/invoices?view=grouped&group_by=customer_name&currency=EUR&metric=count&metric=sum:amount&order_by=sum:amount&order_direction=desc&limit=10');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().meta, { view: 'grouped', group_by: 'customer_name', complete: false, ranking: true, limit: 10 });
    assert.equal(response.json().data.length, 3);
    assert.ok(response.json().data.some((row: { group: string | null }) => row.group === null));
    assert.match(calls[0].sql, /ORDER BY ROUND\(SUM\(i\.suma\), 2\) IS NULL ASC, ROUND\(SUM\(i\.suma\), 2\) DESC, category_value IS NULL ASC, category_value ASC LIMIT \?/);
    assert.deepEqual(calls[0].values, ['EUR', 10]);
    const ascending = await app.inject('/invoices?view=grouped&group_by=currency&metric=count&order_by=count&order_direction=asc&limit=1');
    assert.equal(ascending.statusCode, 200);
    const customerCount = await app.inject('/invoices?view=grouped&group_by=customer_name&metric=count&order_by=count&order_direction=desc&limit=10');
    assert.equal(customerCount.statusCode, 200);
    assert.equal(customerCount.json().meta.complete, false);
  } finally { await app.close(); }
});

test('invoice ranking rejects incomplete or unsafe ranking parameters without weakening complete grouping', async () => {
  const { pool } = fixture(Array.from({ length: 101 }, (_, index) => ({ category_value: `C${index}`, count: 1 })));
  const app = buildApp(config, () => pool, { authenticate: false });
  try {
    for (const query of [
      'view=grouped&group_by=customer_name&currency=EUR&metric=sum:amount&limit=10',
      'view=grouped&group_by=customer_name&currency=EUR&metric=sum:amount&order_by=sum:amount&order_direction=desc&limit=0',
      'view=grouped&group_by=customer_name&currency=EUR&metric=sum:amount&order_by=sum:amount&order_direction=desc&limit=101',
      'view=grouped&group_by=customer_name&currency=EUR&metric=sum:amount&order_by=max:amount&order_direction=desc&limit=10',
      'view=grouped&group_by=customer_name&metric=sum:amount&order_by=sum:amount&order_direction=desc&limit=10',
    ]) assert.equal((await app.inject(`/invoices?${query}`)).statusCode, 400, query);
    const ordinary = await app.inject('/invoices?view=grouped&group_by=currency&metric=count');
    assert.equal(ordinary.statusCode, 422);
    assert.equal(ordinary.json().error.code, 'CATEGORY_LIMIT_EXCEEDED');
  } finally { await app.close(); }
});
