import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

test('live invoices reconcile with the replica without mixing currencies', { timeout: 60000 }, async () => {
  const app = buildApp(loadConfig(), undefined, { authenticate: false });
  try {
    const direct = await app.replica.query<Record<string, unknown>[]>(`SELECT COUNT(*) AS total FROM infot_2.sask_ist`);
    const rows = await app.inject('/invoices?per_page=1&fields=invoice_number,invoice_series,issue_date,customer_id,customer_name,currency,amount');
    assert.equal(rows.statusCode, 200);
    const sample = rows.json().data[0];
    assert.ok(sample.invoice_number); assert.ok(sample.currency); assert.equal(typeof sample.amount, 'number');
    const count = await app.inject('/invoices?view=summary&metric=count');
    assert.equal(count.statusCode, 200); assert.equal(count.json().data.count, Number(direct[0].total));
    const currency = encodeURIComponent(sample.currency);
    const currencyRows = await app.inject(`/invoices?currency=${currency}&per_page=1`);
    const currencySummary = await app.inject(`/invoices?view=summary&currency=${currency}&metric=count&metric=sum:amount`);
    assert.equal(currencySummary.statusCode, 200); assert.equal(currencySummary.json().data.count, currencyRows.json().meta.total);
    const sqlCurrency = await app.replica.query<Record<string, unknown>[]>(`SELECT COUNT(*) AS count, ROUND(SUM(i.suma), 2) AS total FROM infot_2.sask_ist i JOIN infot_2.valiutos v ON v.id=i.valiuta WHERE v.valiuta=?`, [sample.currency]);
    assert.equal(currencySummary.json().data.count, Number(sqlCurrency[0].count));
    assert.equal(currencySummary.json().data.sum_amount, Number(sqlCurrency[0].total));
    const currencies = await app.inject('/invoices?view=distinct&field=currency'); assert.equal(currencies.statusCode, 200); assert.ok(currencies.json().data.some((row: { value: string }) => row.value === sample.currency));
    const grouped = await app.inject('/invoices?view=grouped&group_by=currency&metric=count&metric=sum:amount'); assert.equal(grouped.statusCode, 200); assert.equal(grouped.json().data.reduce((total: number, row: { count: number }) => total + row.count, 0), count.json().data.count);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const currentPeriod = await app.inject(`/invoices?view=summary&currency=${currency}&issue_date_from=${month}-01&issue_date_to=${today}&metric=count&metric=sum:amount`);
    const sqlCurrentPeriod = await app.replica.query<Record<string, unknown>[]>(`SELECT COUNT(*) AS count, ROUND(SUM(i.suma), 2) AS total FROM infot_2.sask_ist i JOIN infot_2.valiutos v ON v.id=i.valiuta WHERE v.valiuta=? AND i.israsymo_data >= ? AND i.israsymo_data <= ?`, [sample.currency, `${month}-01`, today]);
    assert.deepEqual(currentPeriod.json().data, { count: Number(sqlCurrentPeriod[0].count), sum_amount: sqlCurrentPeriod[0].total === null ? null : Number(sqlCurrentPeriod[0].total) });
    const ranked = await app.inject(`/invoices?view=grouped&group_by=customer_name&currency=${currency}&issue_date_from=${month}-01&issue_date_to=${today}&metric=sum:amount&order_by=sum:amount&order_direction=desc&limit=10`);
    assert.equal(ranked.statusCode, 200); assert.deepEqual(ranked.json().meta, { view: 'grouped', group_by: 'customer_name', complete: false, ranking: true, limit: 10 }); assert.ok(ranked.json().data.length <= 10);
    const customerRows = await app.inject(`/invoices?customer_id=${sample.customer_id}&per_page=1`);
    const customerSummary = await app.inject(`/invoices?view=summary&customer_id=${sample.customer_id}&metric=count`);
    assert.equal(customerRows.json().meta.total, customerSummary.json().data.count);
    const negativeExpected = await app.replica.query<{ count: number }[]>(`SELECT COUNT(*) AS count FROM infot_2.sask_ist WHERE suma <= -0.01`);
    const negative = await app.inject('/invoices?amount_to=-0.01&per_page=1&fields=amount');
    assert.equal(negative.statusCode, 200); assert.equal(negative.json().meta.total, Number(negativeExpected[0].count));
    if (Number(negativeExpected[0].count) > 0) assert.ok(negative.json().data[0].amount < 0);
    console.log(`Invoice live evidence: ${sample.invoice_number}/${sample.invoice_series ?? ''}, ${sample.issue_date}, ${sample.currency}, signed amount ${sample.amount}; total ${count.json().data.count}; EUR sum reconciled.`);
  } finally { await app.close(); }
});
