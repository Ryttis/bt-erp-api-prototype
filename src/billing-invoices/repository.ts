import { queryReadOnly, type ReplicaPool } from '../db/replica.js';

type FieldKind = 'id' | 'text' | 'number' | 'date';
type Join = 'customer' | 'currency';
const joins = {
  customer: 'LEFT JOIN infot_2.klientai c ON c.id = NULLIF(i.klientas, 0)',
  currency: 'LEFT JOIN infot_2.valiutos v ON v.id = NULLIF(i.valiuta, 0)',
} as const;
const validDateSql = (raw: string) => `(CASE WHEN ${raw} REGEXP '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
  AND CAST(RIGHT(${raw}, 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(${raw}, 7), '-01'))) THEN ${raw} ELSE NULL END)`;
const field = (sql: string, kind: FieldKind, dependencies: Join[] = []) => ({ sql, kind, dependencies });

export const invoiceFields = {
  id: field('i.id', 'id'),
  invoice_number: field('i.sask_nr', 'text'),
  invoice_series: field('i.serija', 'text'),
  issue_date: field(validDateSql('CAST(i.israsymo_data AS CHAR)'), 'date'),
  accounting_date: field(validDateSql('CAST(i.vk_data AS CHAR)'), 'date'),
  due_date: field(validDateSql('CAST(i.apmoketi_iki AS CHAR)'), 'date'),
  customer_id: field('NULLIF(i.klientas, 0)', 'id'),
  customer_name: field('c.firmos_pavadinimas', 'text', ['customer']),
  currency: field('v.valiuta', 'text', ['currency']),
  amount: field('i.suma', 'number'),
} as const;
export type InvoiceField = keyof typeof invoiceFields;
export const defaultInvoiceFields = Object.keys(invoiceFields) as InvoiceField[];
export const invoiceSortFields = Object.fromEntries(Object.entries(invoiceFields).filter(([key]) => key !== 'id').map(([key, value]) => [key, value.sql])) as Record<Exclude<InvoiceField, 'id'>, string>;
export const invoiceCategoryFields = {
  currency: `CAST(CONVERT(${invoiceFields.currency.sql} USING utf8mb4) AS BINARY)`,
  customer_id: invoiceFields.customer_id.sql,
  customer_name: `CAST(CONVERT(${invoiceFields.customer_name.sql} USING utf8mb4) AS BINARY)`,
  invoice_series: `CAST(CONVERT(${invoiceFields.invoice_series.sql} USING utf8mb4) AS BINARY)`,
} as const;
export type InvoiceCategoryField = keyof typeof invoiceCategoryFields;
export const invoiceMetrics = {
  count: 'COUNT(*)',
  'sum:amount': 'ROUND(SUM(i.suma), 2)',
  'avg:amount': 'ROUND(AVG(i.suma), 2)',
  'min:amount': 'ROUND(MIN(i.suma), 2)',
  'max:amount': 'ROUND(MAX(i.suma), 2)',
} as const;
export type InvoiceMetric = keyof typeof invoiceMetrics;
export const invoiceCategoryLimit = 100;

export interface InvoiceFilters {
  invoice_number?: string; invoice_series?: string; customer_id?: number; customer_name?: string; currency?: string;
  issue_date_from?: string; issue_date_to?: string; accounting_date_from?: string; accounting_date_to?: string; due_date_from?: string; due_date_to?: string;
  amount_from?: number; amount_to?: number;
}
export interface InvoiceRowsQuery extends InvoiceFilters { page: number; per_page: number; sort_by: keyof typeof invoiceSortFields; sort_direction: 'asc' | 'desc'; fields?: InvoiceField[]; }
export interface InvoiceSummaryQuery extends InvoiceFilters { metrics: InvoiceMetric[]; }
export interface InvoiceRanking { order_by: InvoiceMetric; order_direction: 'asc' | 'desc'; limit: number; }
export interface InvoiceCategoryQuery extends InvoiceFilters { field: InvoiceCategoryField; metrics: InvoiceMetric[]; ranking?: InvoiceRanking; }

export class InvoiceCategoryLimitError extends Error { constructor() { super('Category limit exceeded; narrow the filters'); } }
export class InvoiceCurrencyScopeError extends Error { constructor() { super('Currency scope is required for invoice amount analytics'); } }

function requiredJoins(fields: InvoiceField[]) {
  const requested = new Set(fields.flatMap((name) => invoiceFields[name].dependencies));
  return (Object.keys(joins) as Join[]).filter((name) => requested.has(name)).map((name) => joins[name]).join('\n');
}
const substring = (value: string) => `%${value.replace(/[!%_]/g, '!$&')}%`;
function filters(query: InvoiceFilters) {
  const conditions: string[] = []; const values: (string | number)[] = []; const fields: InvoiceField[] = [];
  const text = (key: InvoiceField, value: string, partial: boolean) => { fields.push(key); conditions.push(`LOWER(${invoiceFields[key].sql}) ${partial ? "LIKE LOWER(?) ESCAPE '!'" : '= LOWER(?)'}`); values.push(partial ? substring(value) : value); };
  const bound = (key: InvoiceField, op: string, value: string | number) => { fields.push(key); conditions.push(`${invoiceFields[key].sql} ${op} ?`); values.push(value); };
  if (query.invoice_number !== undefined) text('invoice_number', query.invoice_number, true);
  if (query.invoice_series !== undefined) text('invoice_series', query.invoice_series, false);
  if (query.customer_id !== undefined) bound('customer_id', '=', query.customer_id);
  if (query.customer_name !== undefined) text('customer_name', query.customer_name, true);
  if (query.currency !== undefined) text('currency', query.currency, false);
  for (const key of ['issue_date', 'accounting_date', 'due_date'] as const) {
    if (query[`${key}_from`] !== undefined) bound(key, '>=', query[`${key}_from`] as string);
    if (query[`${key}_to`] !== undefined) bound(key, '<=', query[`${key}_to`] as string);
  }
  if (query.amount_from !== undefined) bound('amount', '>=', query.amount_from);
  if (query.amount_to !== undefined) bound('amount', '<=', query.amount_to);
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values, fields };
}
function numberValue(value: unknown): number | null { if (value === null || value === undefined) return null; const number = Number(value); if (!Number.isFinite(number)) throw new Error('Invalid invoice numeric value'); return number; }
function dateValue(value: unknown): string | null { return typeof value === 'string' && isIsoDate(value) ? value : null; }
function rowValue(value: unknown, kind: FieldKind): string | number | null {
  if (kind === 'number' || kind === 'id') return numberValue(value);
  if (kind === 'date') return dateValue(value);
  return value === null || value === undefined ? null : String(value);
}
export function isIsoDate(value: string) { const date = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-3][0-9])$/.exec(value); if (!date) return false; const normalized = new Date(`${value}T00:00:00Z`); return Number.isFinite(normalized.getTime()) && normalized.toISOString().slice(0, 10) === value; }
function metrics(requested: InvoiceMetric[]) { if (!requested.length || requested.length > 10 || requested.some((item) => !Object.hasOwn(invoiceMetrics, item))) throw new Error('Invalid invoice metrics'); return [...new Set(requested)]; }
function amountRequested(requested: InvoiceMetric[]) { return requested.some((metric) => metric !== 'count'); }
function assertCurrencyScope(query: InvoiceFilters, requested: InvoiceMetric[], groupBy?: InvoiceCategoryField) { if (amountRequested(requested) && query.currency === undefined && groupBy !== 'currency') throw new InvoiceCurrencyScopeError(); }
function expressions(requested: InvoiceMetric[]) { return requested.map((metric) => `${invoiceMetrics[metric]} AS ${metric.replace(':', '_')}`); }
function analyticsJoins(requested: InvoiceMetric[], filterFields: InvoiceField[], category?: InvoiceCategoryField) {
  const fields = [...filterFields];
  if (category) fields.push(category === 'customer_id' ? 'customer_id' : category);
  return requiredJoins(fields);
}
function metricValues(row: Record<string, unknown>, requested: InvoiceMetric[]) {
  const output: Record<string, number | null> = {};
  for (const metric of requested) { const key = metric.replace(':', '_'); if (!Object.hasOwn(row, key)) throw new Error('Incomplete invoice analytics'); output[key] = numberValue(row[key]); }
  return output;
}

export async function listInvoices(pool: ReplicaPool, query: InvoiceRowsQuery) {
  const { where, values, fields: filterFields } = filters(query);
  const fields = [...new Set(query.fields ?? defaultInvoiceFields)];
  const countRows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT COUNT(*) AS total FROM infot_2.sask_ist i ${requiredJoins(filterFields)} ${where}`, values);
  const total = numberValue(countRows[0]?.total); if (total === null || !Number.isSafeInteger(total)) throw new Error('Invalid invoice count');
  const sort = invoiceSortFields[query.sort_by];
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT ${fields.map((name) => `${invoiceFields[name].sql} AS \`${name}\``).join(', ')} FROM infot_2.sask_ist i
    ${requiredJoins([...filterFields, ...fields, query.sort_by])} ${where}
    ORDER BY ${sort} IS NULL ASC, ${sort} ${query.sort_direction === 'asc' ? 'ASC' : 'DESC'}, i.id DESC LIMIT ? OFFSET ?`, [...values, query.per_page, (query.page - 1) * query.per_page]);
  return { data: rows.map((row) => Object.fromEntries(fields.map((name) => [name, name === 'customer_id' && numberValue(row[name]) === 0 ? null : rowValue(row[name], invoiceFields[name].kind)]))), meta: { page: query.page, per_page: query.per_page, total, last_page: Math.ceil(total / query.per_page) } };
}
export async function summarizeInvoices(pool: ReplicaPool, query: InvoiceSummaryQuery) {
  const requested = metrics(query.metrics); assertCurrencyScope(query, requested);
  const { where, values, fields } = filters(query);
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT ${expressions(requested).join(', ')} FROM infot_2.sask_ist i ${analyticsJoins(requested, fields)} ${where}`, values);
  if (rows.length !== 1) throw new Error('Incomplete invoice summary');
  return { data: metricValues(rows[0], requested), meta: { view: 'summary' as const, complete: true } };
}
function categoryValue(value: unknown, field: InvoiceCategoryField): string | number | null { const number = field === 'customer_id' ? numberValue(value) : null; return field === 'customer_id' ? number === 0 ? null : number : value === null || value === undefined ? null : String(value); }
export async function categorizeInvoices(pool: ReplicaPool, query: InvoiceCategoryQuery, view: 'distinct' | 'grouped') {
  const requested = metrics(view === 'distinct' ? ['count'] : query.metrics); assertCurrencyScope(query, requested, query.field);
  const { where, values, fields } = filters(query);
  if (query.ranking) {
    const { order_by, order_direction, limit } = query.ranking;
    if (view !== 'grouped' || !requested.includes(order_by) || limit < 1 || limit > invoiceCategoryLimit) throw new Error('Invalid invoice ranking');
    const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT ${invoiceCategoryFields[query.field]} AS category_value, ${expressions(requested).join(', ')} FROM infot_2.sask_ist i
      ${analyticsJoins(requested, fields, query.field)} ${where} GROUP BY category_value
      ORDER BY ${invoiceMetrics[order_by]} IS NULL ASC, ${invoiceMetrics[order_by]} ${order_direction === 'asc' ? 'ASC' : 'DESC'}, category_value IS NULL ASC, category_value ASC LIMIT ?`, [...values, limit]);
    return { data: rows.map((row) => ({ group: categoryValue(row.category_value, query.field), ...metricValues(row, requested) })), meta: { view: 'grouped' as const, group_by: query.field, complete: false, ranking: true, limit } };
  }
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT ${invoiceCategoryFields[query.field]} AS category_value, ${expressions(requested).join(', ')} FROM infot_2.sask_ist i
    ${analyticsJoins(requested, fields, query.field)} ${where} GROUP BY category_value
    ORDER BY COUNT(*) DESC, category_value IS NULL ASC, category_value ASC LIMIT ${invoiceCategoryLimit + 1}`, values);
  if (rows.length > invoiceCategoryLimit) throw new InvoiceCategoryLimitError();
  return { data: rows.map((row) => ({ [view === 'distinct' ? 'value' : 'group']: categoryValue(row.category_value, query.field), ...metricValues(row, requested) })), meta: view === 'distinct' ? { view, field: query.field, complete: true } : { view, group_by: query.field, complete: true } };
}
