import type { FastifyInstance } from 'fastify';
import { ApiError, apiErrorBody, isQueryTimeout } from '../errors.js';
import { safeDriverDiagnostics } from '../db/replica.js';
import { logVehicleTelemetry } from '../telemetry.js';
import { vehicleFields, allVehicleFields, numericRanges, dateRanges, idFilters, nameFilters, categoryFilters, isIsoDate, type VehicleFilters, type VehicleField, categorizeVehicles, vehicleCategoryFields, VehicleCategoryLimitError, categoryLimit, type VehicleCategoryField, type VehicleCategoryQuery, listVehicles, summarizeVehicles, vehicleMetrics, vehicleSortFields, type VehicleMetric, type VehicleQuery, type VehicleSummaryQuery } from './repository.js';

const parameters = new Set(['plate_number', 'plate_numbers', 'make', 'model', 'active', 'page', 'per_page', 'sort_by', 'sort_direction', 'view', 'metric', 'field', 'group_by', 'fields', ...idFilters, ...nameFilters, ...categoryFilters,
  ...Object.keys({ ...numericRanges, ...dateRanges }).flatMap((key) => [`${key}_from`, `${key}_to`])]);
class InvalidVehicleQuery extends Error {}

// Compatibility names used by the legacy ERP /plain/mcp/trucks endpoint. Each maps
// to exactly one canonical filter; supplying both spellings is ambiguous and invalid.
export const vehicleFilterAliases = {
  status: 'ownership_status', owner: 'owner_name', consumer: 'consumer_name', lessor: 'lessor_name', bank: 'bank_name',
} as const;

function canonicalParameters(input: Record<string, unknown>): Record<string, unknown> {
  const output = { ...input };
  for (const [alias, canonical] of Object.entries(vehicleFilterAliases)) {
    if (!Object.hasOwn(output, alias)) continue;
    if (Object.hasOwn(output, canonical)) throw new InvalidVehicleQuery();
    output[canonical] = output[alias];
    delete output[alias];
  }
  return output;
}

type ParsedQuery = { view: 'rows'; query: VehicleQuery } | { view: 'summary'; query: VehicleSummaryQuery } | { view: 'distinct' | 'grouped'; query: VehicleCategoryQuery };

function parseQuery(query: Record<string, unknown>): ParsedQuery {
  const input = canonicalParameters(query);
  // Only metric may repeat; all other duplicate or unknown parameters are invalid.
  for (const [key, value] of Object.entries(input)) {
    if (!parameters.has(key) || (typeof value !== 'string' && !(key === 'metric' && Array.isArray(value) && value.every((item) => typeof item === 'string')))) throw new InvalidVehicleQuery();
  }
  const view = input.view ?? 'rows';
  if (!['rows', 'summary', 'distinct', 'grouped'].includes(view as string)) throw new InvalidVehicleQuery();
  let metrics: VehicleMetric[] = [];
  if (view !== 'rows' && ['page', 'per_page', 'sort_by', 'sort_direction', 'fields'].some((key) => Object.hasOwn(input, key))) throw new InvalidVehicleQuery();
  if ((view !== 'distinct' && input.field !== undefined) || (view !== 'grouped' && input.group_by !== undefined)) throw new InvalidVehicleQuery();
  const category = view === 'distinct' ? input.field : input.group_by;
  if ((view === 'distinct' || view === 'grouped') && (typeof category !== 'string' || !Object.hasOwn(vehicleCategoryFields, category))) throw new InvalidVehicleQuery();
  if (view === 'summary' || view === 'grouped') {
    const requested = Array.isArray(input.metric) ? input.metric : [input.metric];
    if (!requested.length || requested.length > 10 || requested.some((metric) => typeof metric !== 'string' || !Object.hasOwn(vehicleMetrics, metric))) throw new InvalidVehicleQuery();
    metrics = requested as VehicleMetric[];
  } else if (input.metric !== undefined) {
    throw new InvalidVehicleQuery();
  }
  const text = (key: string, max = 200): string | undefined => {
    const value = input[key] as string | undefined;
    if (value === undefined) return undefined;
    if (!value.trim() || value.length > max) throw new InvalidVehicleQuery();
    return value.trim();
  };
  const integer = (key: string, fallback: number, max: number) => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value as string)) throw new InvalidVehicleQuery();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new InvalidVehicleQuery();
    return result;
  };
  const page = integer('page', 1, Number.MAX_SAFE_INTEGER);
  const per_page = integer('per_page', 50, 200);
  if (!Number.isSafeInteger((page - 1) * per_page)) throw new InvalidVehicleQuery();
  const active = input.active;
  if (active !== undefined && !['true', 'false', '1', '0'].includes(active as string)) throw new InvalidVehicleQuery();
  const sort_by = input.sort_by ?? 'plate_number';
  if (!Object.hasOwn(vehicleSortFields, sort_by as string)) throw new InvalidVehicleQuery();
  const sort_direction = input.sort_direction ?? 'asc';
  if (sort_direction !== 'asc' && sort_direction !== 'desc') throw new InvalidVehicleQuery();
  const plates = text('plate_numbers', 20100)?.split(',').map((plate) => plate.trim());
  if (plates && (plates.length > 100 || plates.some((plate) => !plate || plate.length > 200))) throw new InvalidVehicleQuery();
  const filters: VehicleFilters = {
    plate_number: text('plate_number'), plate_numbers: plates,
    make: text('make'), model: text('model'),
    active: active === undefined ? undefined : active === 'true' || active === '1',
  };
  const extra: Record<string, string | number> = {};
  for (const prefix of Object.keys(numericRanges)) {
    for (const suffix of ['from', 'to']) {
      const key = `${prefix}_${suffix}`;
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER || (prefix === 'mileage' && Number(value) < 0)) throw new InvalidVehicleQuery();
      extra[key] = Number(value);
    }
    if (extra[`${prefix}_from`] !== undefined && extra[`${prefix}_to`] !== undefined && extra[`${prefix}_from`] > extra[`${prefix}_to`]) throw new InvalidVehicleQuery();
  }
  for (const prefix of Object.keys(dateRanges)) {
    for (const suffix of ['from', 'to']) {
      const key = `${prefix}_${suffix}`;
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !isIsoDate(value)) throw new InvalidVehicleQuery();
      extra[key] = value;
    }
    if (extra[`${prefix}_from`] !== undefined && extra[`${prefix}_to`] !== undefined && extra[`${prefix}_from`] > extra[`${prefix}_to`]) throw new InvalidVehicleQuery();
  }
  for (const key of idFilters) if (input[key] !== undefined) extra[key] = integer(key, 1, Number.MAX_SAFE_INTEGER);
  for (const key of [...nameFilters, ...categoryFilters]) {
    const value = text(key);
    if (value !== undefined) extra[key] = value;
  }
  Object.assign(filters, extra);
  let fields: VehicleField[] | undefined;
  if (input.fields !== undefined) {
    const requested = text('fields', 1000)!.split(',').map((key) => key.trim());
    if (requested.length > allVehicleFields.length || requested.some((key) => !Object.hasOwn(vehicleFields, key))) throw new InvalidVehicleQuery();
    fields = [...new Set(requested)] as VehicleField[];
  }
  if (view === 'distinct' || view === 'grouped') return { view, query: { ...filters, field: category as VehicleCategoryField, metrics } };
  if (view === 'summary') return { view, query: { ...filters, metrics } };
  return { view: 'rows', query: { ...filters, fields, page, per_page, sort_by: sort_by as VehicleQuery['sort_by'], sort_direction } };
}

export async function registerVehicleRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, unknown> }>('/vehicles', async (request, reply) => {
    let parsed: ParsedQuery;
    try {
      parsed = parseQuery(request.query);
    } catch {
      return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid vehicle query')));
    }
    const startedAt = performance.now();
    const view = parsed.view;
    const operation = `vehicle.${view}`;
    const telemetry = (outcome: 'success' | 'error' | 'timeout' | 'busy', extra: Record<string, number | boolean> = {}) => {
      const duration_ms = Number((performance.now() - startedAt).toFixed(2));
      logVehicleTelemetry(request.log, app.vehicleSafety.slowQueryMs, { request_id: request.id, endpoint: '/vehicles', view, operation, duration_ms, outcome, timeout: outcome === 'timeout', busy: outcome === 'busy', ...extra });
    };
    try {
      let result: unknown;
      if (view === 'rows') result = await listVehicles(app.replica, parsed.query);
      else result = await app.analyticsGate.run(async () => view === 'summary'
        ? summarizeVehicles(app.replica, parsed.query)
        : categorizeVehicles(app.replica, parsed.query, view));
      const data = result as { data: unknown[] | Record<string, unknown>; meta: Record<string, unknown> };
      telemetry('success', {
        result_count: Array.isArray(data.data) ? data.data.length : 1,
        metric_count: view === 'summary' || view === 'grouped' ? parsed.query.metrics.length : 0,
        category_count: view === 'distinct' || view === 'grouped' ? data.data.length as number : 0,
        page_size: view === 'rows' ? parsed.query.per_page : 0,
      });
      return result;
    } catch (error) {
      if (error instanceof VehicleCategoryLimitError) {
        telemetry('error');
        return reply.code(422).send({ error: { code: 'CATEGORY_LIMIT_EXCEEDED', message: 'Category limit exceeded; narrow the filters', limit: categoryLimit } });
      }
      if (error instanceof ApiError) {
        telemetry('busy');
        return reply.code(error.statusCode).send(apiErrorBody(error));
      }
      if (isQueryTimeout(error)) {
        telemetry('timeout');
        return reply.code(504).send(apiErrorBody(new ApiError(504, 'QUERY_TIMEOUT', 'Vehicle query timed out')));
      }
      request.log.warn({ request_id: request.id, endpoint: '/vehicles', view, operation, diagnostics: safeDriverDiagnostics(error) }, 'Vehicle database request failed');
      telemetry('error');
      return reply.code(503).send(apiErrorBody(new ApiError(503, 'REPLICA_UNAVAILABLE', 'Vehicle data temporarily unavailable')));
    }
  });
}
