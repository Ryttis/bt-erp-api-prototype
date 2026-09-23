import { fixedCostComponentInventory } from './breakdown-contract.js';
import { InvalidFixedCostQuery } from './contracts.js';
import { orderFixedCostLimitations } from './summary-contract.js';

/**
 * Slice 8A — truck fixed-cost dimension contract and availability registry.
 *
 * A dimension lists the values a caller may legitimately use in an *enabled*
 * filter or grouping. No fixed-cost filter or grouping is enabled, so **every
 * dimension here is publicly unavailable** and no live value is ever returned.
 *
 * Parameter names continue the fixed-cost surface's camelCase convention
 * (`allocationScope`, `dateFrom`, `groupBy`, `perPage`) rather than the snake_case
 * of the older `/vehicles` and `/invoices` domains. Both already coexist; a
 * dimensions request shares one query string with `allocationScope`, so matching
 * the fixed-cost surface keeps a single request internally consistent.
 */

export const fixedCostDimensionScope = 'truck' as const;

export const fixedCostDimensions = ['truck', 'costComponent', 'month'] as const;
export type FixedCostDimension = typeof fixedCostDimensions[number];

/**
 * How far a dimension's values may ever be exposed.
 *
 * `internal_identifier` means the numeric key an enabled filter would accept —
 * nothing descriptive, nothing about status, lifecycle, people or free text.
 */
export interface FixedCostDimensionExposure {
  classification: 'internal_identifier' | 'technical_schema_field' | 'derived_period';
  restriction: string;
}

export interface FixedCostDimensionRegistryEntry {
  key: FixedCostDimension;
  /** The structurally verified source, stated without asserting business approval. */
  structuralSource: string;
  /**
   * Shape is `boolean` so the runtime gate is a real check rather than a
   * provably-dead comparison, and so tests can inject an available registry to
   * exercise the downstream path. **Every entry in the shipped registry below is
   * `false`**, which a test asserts directly.
   */
  publicAvailability: boolean;
  blockers: readonly string[];
  /** The only fields a future response may carry. Nothing else may be added. */
  allowedFields: readonly string[];
  allowedFilters: readonly string[];
  allowedSorting: readonly string[];
  maxPageSize: number;
  exposure: FixedCostDimensionExposure;
}

export const fixedCostDimensionMaxPageSize = 200;
export const fixedCostDimensionDefaultPageSize = 50;
/** Hard ceiling on distinct values a future executor may return. */
export const fixedCostDimensionMaxValues = 5000;

/**
 * The single static availability registry. It is code, never request-controlled,
 * and deeply frozen so nothing can flip a dimension on at runtime.
 *
 * Structural verification is not business approval: `truck` has a verified numeric
 * mapping and is still unavailable, because no filter or grouping consumes it yet.
 */
export const fixedCostDimensionRegistry: Readonly<Record<FixedCostDimension, FixedCostDimensionRegistryEntry>> = Object.freeze({
  truck: Object.freeze({
    key: 'truck',
    structuralSource: 'uzdaviniai.uzdavinio_masina joined to masinos.id (FCB-08 / FC-08)',
    publicAvailability: false,
    blockers: Object.freeze(['FC-11', 'FC-14', 'FC-03', 'FC-02', 'FC-P17']),
    // The verified numeric identifier only. No registration string, status,
    // lifecycle, department, driver, comment or any other masinos column.
    allowedFields: Object.freeze(['truckId']),
    allowedFilters: Object.freeze(['truckId']),
    allowedSorting: Object.freeze(['truckId']),
    maxPageSize: fixedCostDimensionMaxPageSize,
    exposure: Object.freeze({
      classification: 'internal_identifier',
      restriction: 'Numeric identifier only. No registration number, status, lifecycle, department, driver, comment or other masinos column may be added, and no display name may be invented.',
    }),
  }),
  costComponent: Object.freeze({
    key: 'costComponent',
    structuralSource: 'The fifteen verified decimal columns of the truck detail tables',
    publicAvailability: false,
    blockers: Object.freeze(['FC-06', 'FC-07']),
    // A technical schema inventory is not an approved business dimension.
    allowedFields: Object.freeze(['componentField']),
    allowedFilters: Object.freeze([]),
    allowedSorting: Object.freeze(['componentField']),
    maxPageSize: fixedCostDimensionMaxPageSize,
    exposure: Object.freeze({
      classification: 'technical_schema_field',
      restriction: 'Explanatory schema field names only. Independent additivity is unapproved, so these are not an approved public business dimension and carry no measure.',
    }),
  }),
  month: Object.freeze({
    key: 'month',
    structuralSource: 'kastai_fiksuoti_ataskaita.kastai_data, the confirmed cost month (FCB-06)',
    publicAvailability: false,
    blockers: Object.freeze(['FC-P19', 'FC-P17']),
    allowedFields: Object.freeze(['month']),
    allowedFilters: Object.freeze([]),
    allowedSorting: Object.freeze(['month']),
    maxPageSize: fixedCostDimensionMaxPageSize,
    exposure: Object.freeze({
      classification: 'derived_period',
      restriction: 'No live month enumeration exists. kastai_data is unindexed, so listing available months would scan the full summary table.',
    }),
  }),
}) as Readonly<Record<FixedCostDimension, FixedCostDimensionRegistryEntry>>;

export const isDimensionPubliclyAvailable = (dimension: FixedCostDimension): boolean =>
  fixedCostDimensionRegistry[dimension].publicAvailability === true;

export interface TruckFixedCostDimensionsRequest {
  allocationScope: typeof fixedCostDimensionScope;
  dimension: FixedCostDimension;
  page: number;
  perPage: number;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) throw new InvalidFixedCostQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new InvalidFixedCostQuery();
  return parsed;
}

/**
 * Strict dimensions request validation.
 *
 * Exactly six parameters are accepted. Everything else is refused, including
 * arbitrary table, column or schema names, search expressions, SQL fragments,
 * field or measure selection, grouping expressions, deleted-row policy, tolerance,
 * representation, internal limits, sensitive-field selection and the generic
 * schema-discovery parameters this service deliberately does not offer.
 */
export function parseTruckFixedCostDimensionsRequest(input: Record<string, unknown>): TruckFixedCostDimensionsRequest {
  const allowed = new Set(['allocationScope', 'dimension', 'page', 'perPage', 'sortBy', 'sortDirection']);
  for (const [key, value] of Object.entries(input)) {
    // A repeated query parameter arrives as an array, never a string.
    if (!allowed.has(key) || typeof value !== 'string') throw new InvalidFixedCostQuery();
  }

  if (input.allocationScope !== fixedCostDimensionScope) throw new InvalidFixedCostQuery();

  const dimension = input.dimension;
  if (typeof dimension !== 'string' || !(fixedCostDimensions as readonly string[]).includes(dimension)) {
    throw new InvalidFixedCostQuery();
  }
  const entry = fixedCostDimensionRegistry[dimension as FixedCostDimension];

  const page = boundedInteger(input.page, 1, 100_000);
  const perPage = boundedInteger(input.perPage, fixedCostDimensionDefaultPageSize, entry.maxPageSize);
  if (!Number.isSafeInteger((page - 1) * perPage)) throw new InvalidFixedCostQuery();

  // Sorting is allowlisted per dimension; no caller-supplied column name is ever accepted.
  const sortBy = input.sortBy ?? entry.allowedSorting[0];
  if (typeof sortBy !== 'string' || !entry.allowedSorting.includes(sortBy)) throw new InvalidFixedCostQuery();
  const sortDirection = input.sortDirection ?? 'asc';
  if (sortDirection !== 'asc' && sortDirection !== 'desc') throw new InvalidFixedCostQuery();

  return {
    allocationScope: fixedCostDimensionScope,
    dimension: dimension as FixedCostDimension,
    page, perPage, sortBy, sortDirection,
  };
}

/** The only shape a future truck dimension value may take. */
export interface TruckDimensionValue { truckId: number }
export interface CostComponentDimensionValue { componentField: string }
export interface MonthDimensionValue { month: string }

export type FixedCostDimensionValue = TruckDimensionValue | CostComponentDimensionValue | MonthDimensionValue;

export interface FixedCostDimensionPagination {
  page: number;
  perPage: number;
  valueCount: number;
  pageCount: number;
  maxValues: number;
}

export interface TruckFixedCostDimensionsMetadata {
  allocationScope: typeof fixedCostDimensionScope;
  dimension: FixedCostDimension;
  availability: 'unavailable' | 'available';
  blockers: readonly string[];
  sourceFamily: 'fixed_cost_truck_allocation';
  structuralSource: string;
  /** Present only where a period basis applies. */
  dateBasis: 'kastai_data' | null;
  allowedFields: readonly string[];
  allowedFilters: readonly string[];
  exposure: FixedCostDimensionExposure;
  complete: boolean;
  pagination: FixedCostDimensionPagination | null;
  sorting: { sortBy: string; sortDirection: 'asc' | 'desc' } | null;
  componentInventory: typeof fixedCostComponentInventory | null;
  pendingApprovals: readonly string[];
  limitations: readonly string[];
}

/**
 * A dimensions result is a discriminated union, deliberately.
 *
 * `unavailable` carries no `values` array at all. Returning `values: []` for a
 * blocked dimension would be a plausible empty success — indistinguishable from
 * "available, but this period has no values" — and that is exactly the confusion
 * this slice must not create.
 */
export type TruckFixedCostDimensionsResponse =
  | { data: { availability: 'unavailable'; dimension: FixedCostDimension; blockers: readonly string[] }; meta: TruckFixedCostDimensionsMetadata }
  | { data: { availability: 'available'; dimension: FixedCostDimension; values: readonly FixedCostDimensionValue[] }; meta: TruckFixedCostDimensionsMetadata };

export const truckFixedCostDimensionLimitations = orderFixedCostLimitations([
  'Every fixed-cost dimension is publicly unavailable because no fixed-cost filter or grouping capability has been activated.',
  'A dimension lists values usable by an enabled filter or grouping; none is enabled, so no live value is returned.',
  'The truck dimension is restricted to the verified numeric identifier; no registration number, status, lifecycle or other masinos column is exposed and no display name is invented.',
  'Cost-component fields are an explanatory technical inventory; their independent additivity is unapproved, so they are not an approved public business dimension.',
  'No live month enumeration exists because kastai_data is unindexed and listing months would scan the full summary table.',
  'Records whose truck cannot be resolved are reported as structural counters, never as a dimension value.',
]);

export const truckFixedCostDimensionPendingApprovals = Object.freeze([
  'FC-02', 'FC-03', 'FC-06', 'FC-07', 'FC-11', 'FC-14', 'FC-P17', 'FC-P19',
] as const);

export type TruckFixedCostDimensionsBlockedReason =
  | 'capability_disabled'
  | 'dimension_unavailable'
  | 'registry_entry_missing'
  | 'executor_unavailable'
  | 'sort_field_unsupported'
  | 'value_count_exceeded'
  | 'incomplete_values'
  | 'page_out_of_range';

export class TruckFixedCostDimensionsUnavailable extends Error {
  constructor(readonly reason: TruckFixedCostDimensionsBlockedReason, readonly blockers: readonly string[]) {
    super(`Truck fixed-cost dimensions unavailable: ${reason} (${blockers.join(', ') || 'no blocker recorded'})`);
    this.name = 'TruckFixedCostDimensionsUnavailable';
  }
}
