import type { FastifyInstance } from 'fastify';
import { ApiError, apiErrorBody, isQueryTimeout } from '../errors.js';
import { safeDriverDiagnostics } from '../db/replica.js';
import { categorizeInvoices, defaultInvoiceFields, invoiceCategoryFields, InvoiceCategoryLimitError, invoiceCategoryLimit, InvoiceCurrencyScopeError, invoiceFields, invoiceMetrics, invoiceSortFields, isIsoDate, listInvoices, summarizeInvoices, type InvoiceCategoryField, type InvoiceCategoryQuery, type InvoiceField, type InvoiceFilters, type InvoiceMetric, type InvoiceRowsQuery, type InvoiceSummaryQuery } from './repository.js';

class InvalidInvoiceQuery extends Error {}
type Parsed = { view: 'rows'; query: InvoiceRowsQuery } | { view: 'summary'; query: InvoiceSummaryQuery } | { view: 'distinct' | 'grouped'; query: InvoiceCategoryQuery };
const parameters = new Set(['view', 'page', 'per_page', 'sort_by', 'sort_direction', 'fields', 'metric', 'field', 'group_by', 'order_by', 'order_direction', 'limit', 'invoice_number', 'invoice_series', 'customer_id', 'customer_name', 'currency', 'amount_from', 'amount_to', 'issue_date_from', 'issue_date_to', 'accounting_date_from', 'accounting_date_to', 'due_date_from', 'due_date_to']);

function parse(input: Record<string, unknown>): Parsed {
  for (const [key, value] of Object.entries(input)) if (!parameters.has(key) || (typeof value !== 'string' && !(key === 'metric' && Array.isArray(value) && value.every((entry) => typeof entry === 'string')))) throw new InvalidInvoiceQuery();
  const view = input.view ?? 'rows'; if (!['rows', 'summary', 'distinct', 'grouped'].includes(view as string)) throw new InvalidInvoiceQuery();
  if (view !== 'rows' && ['page', 'per_page', 'sort_by', 'sort_direction', 'fields'].some((key) => Object.hasOwn(input, key))) throw new InvalidInvoiceQuery();
  if (view !== 'grouped' && ['order_by', 'order_direction', 'limit'].some((key) => Object.hasOwn(input, key))) throw new InvalidInvoiceQuery();
  if ((view !== 'distinct' && input.field !== undefined) || (view !== 'grouped' && input.group_by !== undefined)) throw new InvalidInvoiceQuery();
  const text = (key: string, max = 200) => { const value = input[key]; if (value === undefined) return undefined; if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InvalidInvoiceQuery(); return value.trim(); };
  const integer = (key: string, fallback: number, max: number) => { const value = input[key]; if (value === undefined) return fallback; if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new InvalidInvoiceQuery(); const result = Number(value); if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new InvalidInvoiceQuery(); return result; };
  const number = (key: string) => { const value = input[key]; if (value === undefined) return undefined; if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER) throw new InvalidInvoiceQuery(); return Number(value); };
  const filters: InvoiceFilters = { invoice_number: text('invoice_number'), invoice_series: text('invoice_series'), customer_name: text('customer_name'), currency: text('currency', 10) };
  if (input.customer_id !== undefined) filters.customer_id = integer('customer_id', 1, Number.MAX_SAFE_INTEGER);
  for (const key of ['issue_date', 'accounting_date', 'due_date'] as const) {
    for (const side of ['from', 'to'] as const) { const name = `${key}_${side}` as keyof InvoiceFilters; const value = input[name]; if (value !== undefined && (typeof value !== 'string' || !isIsoDate(value))) throw new InvalidInvoiceQuery(); Object.assign(filters, value === undefined ? {} : { [name]: value }); }
    if (filters[`${key}_from`] && filters[`${key}_to`] && filters[`${key}_from`]! > filters[`${key}_to`]!) throw new InvalidInvoiceQuery();
  }
  filters.amount_from = number('amount_from'); filters.amount_to = number('amount_to'); if (filters.amount_from !== undefined && filters.amount_to !== undefined && filters.amount_from > filters.amount_to) throw new InvalidInvoiceQuery();
  const requestedMetrics = Array.isArray(input.metric) ? input.metric : input.metric === undefined ? [] : [input.metric];
  if (view === 'summary' || view === 'grouped') { if (!requestedMetrics.length || requestedMetrics.length > 10 || requestedMetrics.some((metric) => typeof metric !== 'string' || !Object.hasOwn(invoiceMetrics, metric))) throw new InvalidInvoiceQuery(); }
  else if (input.metric !== undefined) throw new InvalidInvoiceQuery();
  const metrics = requestedMetrics as InvoiceMetric[];
  const category = view === 'distinct' ? input.field : input.group_by;
  if ((view === 'distinct' || view === 'grouped') && (typeof category !== 'string' || !Object.hasOwn(invoiceCategoryFields, category))) throw new InvalidInvoiceQuery();
  if (view === 'distinct') return { view, query: { ...filters, field: category as InvoiceCategoryField, metrics: [] } };
  if (view === 'grouped') {
    const rankingKeys = ['order_by', 'order_direction', 'limit'] as const;
    const hasRanking = rankingKeys.some((key) => Object.hasOwn(input, key));
    if (!hasRanking) return { view, query: { ...filters, field: category as InvoiceCategoryField, metrics } };
    if (!rankingKeys.every((key) => Object.hasOwn(input, key)) || typeof input.order_by !== 'string' || !Object.hasOwn(invoiceMetrics, input.order_by) || !metrics.includes(input.order_by as InvoiceMetric) || (input.order_direction !== 'asc' && input.order_direction !== 'desc')) throw new InvalidInvoiceQuery();
    const limit = integer('limit', 1, invoiceCategoryLimit);
    return { view, query: { ...filters, field: category as InvoiceCategoryField, metrics, ranking: { order_by: input.order_by as InvoiceMetric, order_direction: input.order_direction, limit } } };
  }
  if (view === 'summary') return { view, query: { ...filters, metrics } };
  const page = integer('page', 1, Number.MAX_SAFE_INTEGER); const per_page = integer('per_page', 50, 200); if (!Number.isSafeInteger((page - 1) * per_page)) throw new InvalidInvoiceQuery();
  const sort_by = input.sort_by ?? 'issue_date'; const sort_direction = input.sort_direction ?? 'desc'; if (typeof sort_by !== 'string' || !Object.hasOwn(invoiceSortFields, sort_by) || (sort_direction !== 'asc' && sort_direction !== 'desc')) throw new InvalidInvoiceQuery();
  let fields: InvoiceField[] | undefined;
  if (input.fields !== undefined) { const requested = text('fields', 1000)!.split(',').map((field) => field.trim()); if (!requested.length || requested.length > defaultInvoiceFields.length || requested.some((field) => !Object.hasOwn(invoiceFields, field))) throw new InvalidInvoiceQuery(); fields = [...new Set(requested)] as InvoiceField[]; }
  return { view: 'rows', query: { ...filters, page, per_page, sort_by: sort_by as keyof typeof invoiceSortFields, sort_direction, fields } };
}

export async function registerBillingInvoiceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, unknown> }>('/invoices', async (request, reply) => {
    let parsed: Parsed;
    try { parsed = parse(request.query); } catch { return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid invoice query'))); }
    const startedAt = performance.now(); const operation = `invoice.${parsed.view}`;
    const telemetry = (outcome: string, extra: Record<string, number | boolean> = {}) => request.log[outcome === 'success' ? 'info' : 'warn']({ request_id: request.id, endpoint: '/invoices', view: parsed.view, operation, duration_ms: Number((performance.now() - startedAt).toFixed(2)), outcome, timeout: outcome === 'timeout', busy: outcome === 'busy', ...extra }, outcome === 'success' ? 'Invoice database request' : 'Invoice database request failed');
    try {
      let result: { data: unknown; meta: Record<string, unknown> };
      if (parsed.view === 'rows') result = await listInvoices(app.replica, parsed.query);
      else if (parsed.view === 'summary') result = await app.analyticsGate.run(() => summarizeInvoices(app.replica, parsed.query));
      else result = await app.analyticsGate.run(() => categorizeInvoices(app.replica, parsed.query, parsed.view));
      const data = result.data as unknown[] | Record<string, unknown>;
      telemetry('success', { result_count: Array.isArray(data) ? data.length : 1, category_count: parsed.view === 'distinct' || parsed.view === 'grouped' ? data.length as number : 0, metric_count: parsed.view === 'summary' || parsed.view === 'grouped' ? parsed.query.metrics.length : 0, page_size: parsed.view === 'rows' ? parsed.query.per_page : 0 });
      return result;
    } catch (error) {
      if (error instanceof InvoiceCurrencyScopeError) { telemetry('error'); return reply.code(400).send(apiErrorBody(new ApiError(400, 'CURRENCY_SCOPE_REQUIRED', 'Currency scope is required for invoice amount analytics'))); }
      if (error instanceof InvoiceCategoryLimitError) { telemetry('error'); return reply.code(422).send({ error: { code: 'CATEGORY_LIMIT_EXCEEDED', message: 'Category limit exceeded; narrow the filters', limit: invoiceCategoryLimit } }); }
      if (error instanceof ApiError) { telemetry('busy'); return reply.code(error.statusCode).send(apiErrorBody(error)); }
      if (isQueryTimeout(error)) { telemetry('timeout'); return reply.code(504).send(apiErrorBody(new ApiError(504, 'QUERY_TIMEOUT', 'Invoice query timed out'))); }
      request.log.warn({ request_id: request.id, endpoint: '/invoices', view: parsed.view, operation, diagnostics: safeDriverDiagnostics(error) }, 'Invoice database request failed'); telemetry('error');
      return reply.code(503).send(apiErrorBody(new ApiError(503, 'REPLICA_UNAVAILABLE', 'Invoice data temporarily unavailable')));
    }
  });
}
