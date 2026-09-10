import { queryReadOnly, type ReplicaPool } from '../db/replica.js';

// Verified replica mappings and cardinality evidence: docs/vehicle-schema.md.
function validDateSql(raw: string) {
  return `(CASE WHEN ${raw} REGEXP '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND CAST(RIGHT(${raw}, 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(${raw}, 7), '-01')))
    THEN ${raw} ELSE NULL END)`;
}
const manufactured = `(CASE WHEN TRIM(m.pag_metai) REGEXP '^[1-9][0-9]{3}$'
  AND TRIM(m.pag_menuo) REGEXP '^[0-9]{1,2}$' AND TRIM(m.pag_diena) REGEXP '^[0-9]{1,2}$'
  THEN CONCAT(TRIM(m.pag_metai), '-', LPAD(TRIM(m.pag_menuo), 2, '0'), '-', LPAD(TRIM(m.pag_diena), 2, '0')) ELSE NULL END)`;

const joins = {
  rental: `LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id = (
    SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru
    WHERE ru.masinos_id = m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1)`,
  lease: `LEFT JOIN infot_2.masinu_priekabu_lizinguotojas l ON l.id = (
    SELECT ll.id FROM infot_2.masinu_priekabu_lizinguotojas ll
    WHERE ll.masinos_id = m.id ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1)`,
  mileage: 'LEFT JOIN infot_2.masinos_latest_status s ON s.masinos_id = m.id AND s.ar_priekaba = 0',
  department: 'LEFT JOIN infot_2.skyriai d ON d.id = NULLIF(m.priskirto_skyriaus_id, 0)',
  group: 'LEFT JOIN infot_2.poskyriai g ON g.id = NULLIF(m.priskirto_poskyris_id, 0)',
  market: 'LEFT JOIN infot_2.rinkos mk ON mk.id = NULLIF(m.priskirto_rinka_id, 0)',
  consumer: 'LEFT JOIN infot_2.klientai c ON c.id = NULLIF(r.naudotojas, 0)',
  lessor: 'LEFT JOIN infot_2.klientai lc ON lc.id = NULLIF(l.lizinguotojas, 0)',
  bank: 'LEFT JOIN infot_2.klientai bc ON bc.id = NULLIF(l.bankas, 0)',
} as const;
type Join = keyof typeof joins;
type FieldKind = 'id' | 'text' | 'number' | 'fk' | 'date' | 'boolean';
function field(sql: string, kind: FieldKind, dependencies: Join[] = []) { return { sql, kind, dependencies }; }
export const vehicleFields = {
  id: field('m.id', 'id'),
  plate_number: field('m.masinos_nr', 'text'),
  make: field('m.marke_2', 'text'),
  model: field('m.modelis', 'text'),
  vin: field('m.kebulo_nr', 'text'),
  active: field('(COALESCE(m.nebedirba, 0) = 0)', 'boolean'),
  consumer_id: field('NULLIF(r.naudotojas, 0)', 'fk', ['rental']),
  consumer_from: field(validDateSql('CAST(r.data_nuo AS CHAR)'), 'date', ['rental']),
  consumer_to: field(validDateSql('CAST(r.data_iki AS CHAR)'), 'date', ['rental']),
  rent_price: field('r.kaina', 'number', ['rental']),
  lessor_id: field('NULLIF(l.lizinguotojas, 0)', 'fk', ['lease']),
  bank_id: field('NULLIF(l.bankas, 0)', 'fk', ['lease']),
  lease_start: field(validDateSql('CAST(l.data_nuo AS CHAR)'), 'date', ['lease']),
  lease_end: field(validDateSql('CAST(l.data_iki AS CHAR)'), 'date', ['lease']),
  last_payment_amount: field('l.last_payment_amount', 'number', ['lease']),
  manufactured_at: field(validDateSql(manufactured), 'date'),
  registration_date: field(validDateSql('CAST(m.register_date AS CHAR)'), 'date'),
  mileage: field('s.last_odometer', 'number', ['mileage']),
  department: field('d.skyrius', 'text', ['department']),
  group: field('g.poskyris', 'text', ['group']),
  market: field('mk.rinka', 'text', ['market']),
  consumer_name: field('c.firmos_pavadinimas', 'text', ['rental', 'consumer']),
  lessor_name: field('lc.firmos_pavadinimas', 'text', ['lease', 'lessor']),
  bank_name: field('bc.firmos_pavadinimas', 'text', ['lease', 'bank']),
} as const;
export type VehicleField = keyof typeof vehicleFields;
export const defaultVehicleFields = Object.keys(vehicleFields) as VehicleField[];
export const vehicleSortFields = {
  plate_number: vehicleFields.plate_number.sql, make: vehicleFields.make.sql, model: vehicleFields.model.sql,
  manufactured_at: vehicleFields.manufactured_at.sql, registration_date: vehicleFields.registration_date.sql,
  mileage: vehicleFields.mileage.sql, rent_price: vehicleFields.rent_price.sql, last_payment_amount: vehicleFields.last_payment_amount.sql,
  consumer_name: vehicleFields.consumer_name.sql, lessor_name: vehicleFields.lessor_name.sql, bank_name: vehicleFields.bank_name.sql,
  department: vehicleFields.department.sql, group: vehicleFields.group.sql, market: vehicleFields.market.sql,
  lease_start: vehicleFields.lease_start.sql, lease_end: vehicleFields.lease_end.sql,
} as const;

export const numericRanges = { mileage: 'mileage', rent_price: 'rent_price', last_payment: 'last_payment_amount' } as const;
export const dateRanges = { manufactured: 'manufactured_at', registration: 'registration_date', consumer: 'consumer_from', lease_start: 'lease_start', lease_end: 'lease_end' } as const;
export const idFilters = ['consumer_id', 'lessor_id', 'bank_id'] as const;
export const nameFilters = ['consumer_name', 'lessor_name', 'bank_name'] as const;
export const categoryFilters = ['department', 'group', 'market'] as const;
type NumericRangeKey = `${keyof typeof numericRanges}_${'from' | 'to'}`;
type DateRangeKey = `${keyof typeof dateRanges}_${'from' | 'to'}`;
export type VehicleFilters = {
  plate_number?: string; plate_numbers?: string[]; make?: string; model?: string; active?: boolean;
} & Partial<Record<NumericRangeKey | typeof idFilters[number], number>>
  & Partial<Record<DateRangeKey | typeof nameFilters[number] | typeof categoryFilters[number], string>>;
export interface VehicleQuery extends VehicleFilters {
  page: number; per_page: number; sort_by: keyof typeof vehicleSortFields; sort_direction: 'asc' | 'desc'; fields?: VehicleField[];
}
export interface Vehicle {
  id: number; plate_number: string; make: string | null; model: string | null; vin: string | null; active: boolean;
  consumer_id: number | null; consumer_from: string | null; consumer_to: string | null; rent_price: number | null;
  lessor_id: number | null; bank_id: number | null; lease_start: string | null; lease_end: string | null; last_payment_amount: number | null;
  manufactured_at: string | null; registration_date: string | null; mileage: number | null;
  department: string | null; group: string | null; market: string | null;
  consumer_name: string | null; lessor_name: string | null; bank_name: string | null;
}
function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('Invalid vehicle numeric value');
  return result;
}
function foreignKey(value: unknown): number | null {
  const result = numeric(value);
  if (result !== null && !Number.isSafeInteger(result)) throw new Error('Invalid relation ID');
  return result === 0 ? null : result;
}
export function isIsoDate(value: string): boolean {
  if (!/^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(value)) return false;
  const time = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
}
function projectedVehicle(row: Record<string, unknown>, fields: VehicleField[]) {
  const output: Partial<Vehicle> = {};
  for (const key of fields) {
    const value = row[key];
    let canonical: string | number | boolean | null;
    switch (vehicleFields[key].kind) {
      case 'id': canonical = numeric(value); if (canonical === null || !Number.isSafeInteger(canonical)) throw new Error('Invalid vehicle ID'); break;
      case 'fk': canonical = foreignKey(value); break;
      case 'number': canonical = numeric(value); break;
      case 'boolean': canonical = numeric(value) === 1; break;
      case 'date': canonical = typeof value === 'string' && isIsoDate(value) ? value : null; break;
      default: canonical = value === null || value === undefined ? null : String(value);
    }
    Object.assign(output, { [key]: canonical });
  }
  return output;
}
const substring = (value: string) => `%${value.replace(/[!%_]/g, '!$&')}%`;
function requiredJoins(fields: VehicleField[]) {
  const required = new Set(fields.flatMap((key) => vehicleFields[key].dependencies));
  return (Object.keys(joins) as Join[]).filter((key) => required.has(key)).map((key) => joins[key]).join('\n');
}
function vehicleFilters(query: VehicleFilters) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  const fields: VehicleField[] = [];
  const condition = (key: VehicleField, operator: string, value: string | number) => {
    fields.push(key); conditions.push(`${vehicleFields[key].sql} ${operator} ?`); values.push(value);
  };
  const text = (key: VehicleField, value: string, partial: boolean) => {
    fields.push(key);
    conditions.push(`LOWER(${vehicleFields[key].sql}) ${partial ? "LIKE LOWER(?) ESCAPE '!'" : '= LOWER(?)'}`);
    values.push(partial ? substring(value) : value);
  };
  if (query.plate_number !== undefined) text('plate_number', query.plate_number, true);
  if (query.plate_numbers !== undefined) {
    conditions.push(`m.masinos_nr IN (${query.plate_numbers.map(() => '?').join(', ')})`); values.push(...query.plate_numbers);
  }
  if (query.make !== undefined) text('make', query.make, false);
  if (query.model !== undefined) text('model', query.model, true);
  if (query.active !== undefined) condition('active', '=', query.active ? 1 : 0);
  for (const [prefix, key] of Object.entries({ ...numericRanges, ...dateRanges })) {
    for (const [suffix, operator] of [['from', '>='], ['to', '<=']] as const) {
      const value = query[`${prefix}_${suffix}` as NumericRangeKey | DateRangeKey];
      if (value !== undefined) condition(key, operator, value);
    }
  }
  for (const key of idFilters) if (query[key] !== undefined) condition(key, '=', query[key]);
  for (const key of nameFilters) if (query[key] !== undefined) text(key, query[key], true);
  for (const key of categoryFilters) if (query[key] !== undefined) text(key, query[key], false);
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values, fields };
}
export async function listVehicles(pool: ReplicaPool, query: VehicleQuery) {
  const { where, values, fields: filterFields } = vehicleFilters(query);
  const fields = [...new Set(query.fields ?? defaultVehicleFields)];
  if (!fields.length || fields.length > defaultVehicleFields.length || fields.some((key) => !Object.hasOwn(vehicleFields, key))) throw new Error('Invalid vehicle projection');
  const counts = await queryReadOnly<{ total: unknown }[]>(pool, `SELECT COUNT(*) AS total FROM infot_2.masinos m ${requiredJoins(filterFields)} ${where}`, values);
  const total = numeric(counts[0].total);
  if (total === null || !Number.isSafeInteger(total)) throw new Error('Invalid vehicle count');
  const sort = vehicleSortFields[query.sort_by];
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT ${fields.map((key) => `${vehicleFields[key].sql} AS \`${key}\``).join(', ')}
    FROM infot_2.masinos m ${requiredJoins([...filterFields, ...fields, query.sort_by])} ${where}
    ORDER BY ${sort} IS NULL ASC, ${sort} ${query.sort_direction === 'desc' ? 'DESC' : 'ASC'}, m.id ASC
    LIMIT ? OFFSET ?`, [...values, query.per_page, (query.page - 1) * query.per_page]);
  return { data: rows.map((row) => projectedVehicle(row, fields)), meta: {
    page: query.page, per_page: query.per_page, total, last_page: Math.ceil(total / query.per_page),
    sort: { field: query.sort_by, direction: query.sort_direction },
  } };
}

// Both metric keys and expressions are fixed; client input never becomes SQL.
// Round final monetary aggregates (not individual rows) to two decimal places.
export const vehicleMetrics = {
  count: 'COUNT(*)',
  'avg:mileage': 'AVG(s.last_odometer)',
  'min:mileage': 'MIN(s.last_odometer)',
  'max:mileage': 'MAX(s.last_odometer)',
  'sum:rent_price': 'ROUND(SUM(r.kaina), 2)',
  'avg:rent_price': 'ROUND(AVG(r.kaina), 2)',
  'min:rent_price': 'ROUND(MIN(r.kaina), 2)',
  'max:rent_price': 'ROUND(MAX(r.kaina), 2)',
  'sum:last_payment_amount': 'ROUND(SUM(l.last_payment_amount), 2)',
  'avg:last_payment_amount': 'ROUND(AVG(l.last_payment_amount), 2)',
  'min:last_payment_amount': 'ROUND(MIN(l.last_payment_amount), 2)',
  'max:last_payment_amount': 'ROUND(MAX(l.last_payment_amount), 2)',
} as const;

export type VehicleMetric = keyof typeof vehicleMetrics;
export interface VehicleSummaryQuery extends VehicleFilters {
  metrics: VehicleMetric[];
}

function selectedMetrics(requested: VehicleMetric[]) {
  if (!requested.length || requested.length > 10 || requested.some((metric) => !Object.hasOwn(vehicleMetrics, metric))) {
    throw new Error('Invalid vehicle metrics');
  }
  return [...new Set(requested)];
}

function metricExpressions(metrics: VehicleMetric[]) {
  return metrics.map((metric) => `${vehicleMetrics[metric]} AS ${metric.replace(':', '_')}`);
}

function analyticalJoins(metrics: VehicleMetric[], filters: VehicleField[], category?: VehicleCategoryField) {
  const fields: VehicleField[] = [...filters];
  for (const metric of metrics) if (metric !== 'count') fields.push(metric.split(':')[1] as VehicleField);
  if (category) fields.push(category);
  return requiredJoins(fields);
}

function metricValues(row: Record<string, unknown>, metrics: VehicleMetric[]) {
  const data: Record<string, number | null> = {};
  for (const metric of metrics) {
    const key = metric.replace(':', '_');
    if (!Object.hasOwn(row, key) || row[key] === undefined) throw new Error('Incomplete vehicle analytics');
    const value = numeric(row[key]);
    if (metric === 'count' && (value === null || !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid vehicle count');
    data[key] = value;
  }
  return data;
}

export async function summarizeVehicles(pool: ReplicaPool, query: VehicleSummaryQuery) {
  const metrics = selectedMetrics(query.metrics);
  const { where, values, fields } = vehicleFilters(query);
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `SELECT ${metricExpressions(metrics).join(', ')}
    FROM infot_2.masinos m ${analyticalJoins(metrics, fields)} ${where}`, values);
  if (rows.length !== 1) throw new Error('Incomplete vehicle summary');
  return { data: metricValues(rows[0], metrics), meta: { view: 'summary' as const, complete: true } };
}

// Binary UTF-8 text grouping preserves exact canonical spelling (including case
// and trailing spaces), regardless of the source column's grouping collation.
export const vehicleCategoryFields = {
  make: 'CAST(CONVERT(m.marke_2 USING utf8mb4) AS BINARY)',
  model: 'CAST(CONVERT(m.modelis USING utf8mb4) AS BINARY)',
  department: `CAST(CONVERT(${vehicleFields.department.sql} USING utf8mb4) AS BINARY)`,
  group: `CAST(CONVERT(${vehicleFields.group.sql} USING utf8mb4) AS BINARY)`,
  market: `CAST(CONVERT(${vehicleFields.market.sql} USING utf8mb4) AS BINARY)`,
  active: '(COALESCE(m.nebedirba, 0) = 0)',
  consumer_id: 'NULLIF(r.naudotojas, 0)',
  lessor_id: 'NULLIF(l.lizinguotojas, 0)',
  bank_id: 'NULLIF(l.bankas, 0)',
} as const;
export type VehicleCategoryField = keyof typeof vehicleCategoryFields;
export interface VehicleCategoryQuery extends VehicleFilters {
  field: VehicleCategoryField;
  metrics: VehicleMetric[];
}
export const categoryLimit = 100;
export class VehicleCategoryLimitError extends Error {
  constructor() { super('Category limit exceeded; narrow the filters'); }
}

function categoryValue(value: unknown, field: VehicleCategoryField): string | number | boolean | null {
  if (value === undefined) throw new Error('Incomplete vehicle category');
  if (value === null) return null;
  if (field === 'make' || field === 'model' || field === 'department' || field === 'group' || field === 'market') return String(value);
  if (field === 'active') {
    const active = numeric(value);
    if (active !== 0 && active !== 1) throw new Error('Invalid vehicle category');
    return active === 1;
  }
  return foreignKey(value);
}

// Both categorical views use the same bounded SQL grouping. The extra category
// is a sentinel: never return partial data when it is present.
export async function categorizeVehicles(pool: ReplicaPool, query: VehicleCategoryQuery, view: 'distinct' | 'grouped') {
  if (!Object.hasOwn(vehicleCategoryFields, query.field)) throw new Error('Invalid vehicle category field');
  const metrics = selectedMetrics(view === 'distinct' ? ['count'] : query.metrics);
  const { where, values, fields } = vehicleFilters(query);
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool, `
    SELECT ${vehicleCategoryFields[query.field]} AS category_value, ${metricExpressions(metrics).join(', ')}
    FROM infot_2.masinos m ${analyticalJoins(metrics, fields, query.field)} ${where}
    GROUP BY category_value
    ORDER BY COUNT(*) DESC, category_value IS NULL ASC, category_value ASC
    LIMIT ${categoryLimit + 1}`, values);
  if (rows.length > categoryLimit) throw new VehicleCategoryLimitError();
  const data = rows.map((row) => ({
    [view === 'distinct' ? 'value' : 'group']: categoryValue(row.category_value, query.field),
    ...metricValues(row, metrics),
  }));
  return {
    data,
    meta: view === 'distinct'
      ? { view, field: query.field, complete: true }
      : { view, group_by: query.field, complete: true },
  };
}
