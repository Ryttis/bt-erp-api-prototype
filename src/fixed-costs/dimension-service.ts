import { fixedCostSemanticCapabilities } from './capabilities.js';
import { fixedCostComponentInventory } from './breakdown-contract.js';
import {
  fixedCostDimensionMaxValues, fixedCostDimensionRegistry, truckFixedCostDimensionLimitations,
  truckFixedCostDimensionPendingApprovals, TruckFixedCostDimensionsUnavailable,
  type FixedCostDimension, type FixedCostDimensionRegistryEntry, type FixedCostDimensionValue,
  type TruckFixedCostDimensionsMetadata, type TruckFixedCostDimensionsRequest,
  type TruckFixedCostDimensionsResponse,
} from './dimension-contract.js';
import { InvalidFixedCostMonetaryResult } from './monetary-contract.js';
import { orderFixedCostLimitations } from './summary-contract.js';

/**
 * Slice 8A — internal truck dimensions orchestration.
 *
 * Gates run before anything else, so a blocked dimension performs **zero**
 * executor calls. No production SQL is added: the month dimension would need to
 * enumerate `kastai_data`, which is unindexed, and the truck dimension must
 * eventually be scoped to valid fixed-cost analytics data rather than enumerating
 * the whole `masinos` table. Both belong to Slice 8B.
 *
 * Nothing is logged: no identifier, date, row or schema content leaves this module.
 */

export interface DimensionExecutorResult {
  dimension: FixedCostDimension;
  values: readonly FixedCostDimensionValue[];
  /** The executor must prove it enumerated every value before pagination. */
  complete: boolean;
  truncated: boolean;
  valueCount: number;
}

export type FixedCostDimensionExecutor = (input: {
  allocationScope: 'truck';
  dimension: FixedCostDimension;
}) => Promise<DimensionExecutorResult>;

export interface TruckFixedCostDimensionsInput {
  request: TruckFixedCostDimensionsRequest;
  /** Only ever called for a dimension the registry marks publicly available. */
  execute?: FixedCostDimensionExecutor;
  capabilities?: Record<string, { enabled: boolean }>;
  /**
   * Registry override, injected only so the downstream orchestration is testable.
   * Every entry in the real registry is unavailable, so the default path always
   * refuses before the executor.
   */
  registry?: Readonly<Record<FixedCostDimension, FixedCostDimensionRegistryEntry>>;
}

const identifierOf = (value: FixedCostDimensionValue): string | number => {
  if ('truckId' in value) return value.truckId;
  if ('componentField' in value) return value.componentField;
  return value.month;
};

/** Total ordering on the single allowlisted key; no caller-supplied column exists. */
function orderValues(values: readonly FixedCostDimensionValue[], direction: 'asc' | 'desc'): FixedCostDimensionValue[] {
  return [...values].sort((left, right) => {
    const a = identifierOf(left);
    const b = identifierOf(right);
    const primary = a === b ? 0 : a < b ? -1 : 1;
    return direction === 'desc' ? -primary : primary;
  });
}

function metadata(
  request: TruckFixedCostDimensionsRequest,
  entry: FixedCostDimensionRegistryEntry,
  availability: 'unavailable' | 'available',
  extra: Partial<TruckFixedCostDimensionsMetadata> = {},
): TruckFixedCostDimensionsMetadata {
  return {
    allocationScope: 'truck',
    dimension: request.dimension,
    availability,
    blockers: entry.blockers,
    sourceFamily: 'fixed_cost_truck_allocation',
    structuralSource: entry.structuralSource,
    dateBasis: request.dimension === 'month' ? 'kastai_data' : null,
    allowedFields: entry.allowedFields,
    allowedFilters: entry.allowedFilters,
    exposure: entry.exposure,
    complete: availability === 'available',
    pagination: null,
    sorting: null,
    // Surfaced for the component dimension only, and always marked explanatory.
    componentInventory: request.dimension === 'costComponent' ? fixedCostComponentInventory : null,
    pendingApprovals: truckFixedCostDimensionPendingApprovals,
    limitations: orderFixedCostLimitations([...truckFixedCostDimensionLimitations]),
    ...extra,
  };
}

/**
 * Lists dimension values, or explains why a dimension is unavailable.
 *
 * An unavailable dimension returns a discriminated `unavailable` result carrying
 * its blockers and **no values array**, so it can never be mistaken for an
 * available dimension that happens to be empty.
 */
export async function listTruckFixedCostDimensions(
  input: TruckFixedCostDimensionsInput,
): Promise<TruckFixedCostDimensionsResponse> {
  const { request } = input;
  const capabilities = input.capabilities ?? fixedCostSemanticCapabilities;
  const registry = input.registry ?? fixedCostDimensionRegistry;
  const entry = registry[request.dimension];
  // A registry without an entry for the requested dimension is a misconfiguration.
  // Fail closed with a typed error rather than dereferencing undefined.
  if (!entry || entry.key !== request.dimension) {
    throw new TruckFixedCostDimensionsUnavailable('registry_entry_missing', []);
  }

  // 1. Capability gate. Every real registry entry is disabled.
  if (!capabilities[request.allocationScope]?.enabled) {
    return {
      data: { availability: 'unavailable', dimension: request.dimension, blockers: entry.blockers },
      meta: metadata(request, entry, 'unavailable'),
    };
  }
  // 2. Availability gate. Structural verification is not business approval.
  if (entry.publicAvailability !== true) {
    return {
      data: { availability: 'unavailable', dimension: request.dimension, blockers: entry.blockers },
      meta: metadata(request, entry, 'unavailable'),
    };
  }
  // 3. Sorting must be allowlisted for this dimension, before any access.
  if (!entry.allowedSorting.includes(request.sortBy)) {
    throw new TruckFixedCostDimensionsUnavailable('sort_field_unsupported', entry.blockers);
  }
  // The dimension is available at this point, so the missing piece is the caller's
  // executor. Reporting `dimension_unavailable` here would misstate system state.
  if (!input.execute) {
    throw new TruckFixedCostDimensionsUnavailable('executor_unavailable', entry.blockers);
  }

  const result = await input.execute({ allocationScope: 'truck', dimension: request.dimension });
  if (result.dimension !== request.dimension) {
    throw new InvalidFixedCostMonetaryResult('Dimension mismatch between request and executor result');
  }
  // A partial enumeration is never presented as complete.
  if (result.truncated || !result.complete) {
    throw new TruckFixedCostDimensionsUnavailable('incomplete_values', entry.blockers);
  }
  if (result.valueCount !== result.values.length) {
    throw new InvalidFixedCostMonetaryResult('Dimension value count disagrees with the returned values');
  }
  if (result.valueCount > fixedCostDimensionMaxValues) {
    throw new TruckFixedCostDimensionsUnavailable('value_count_exceeded', entry.blockers);
  }
  const identifiers = result.values.map(identifierOf);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new InvalidFixedCostMonetaryResult('Dimension returned duplicate values');
  }
  for (const value of result.values) {
    const fields = Object.keys(value);
    // Only the registry's allowlisted fields may appear, so no unapproved column
    // can reach a response even if an executor supplies one.
    if (fields.length !== 1 || !entry.allowedFields.includes(fields[0])) {
      throw new InvalidFixedCostMonetaryResult('Dimension value carries a field outside the allowlist');
    }
    if ('truckId' in value && (!Number.isSafeInteger(value.truckId) || value.truckId <= 0)) {
      throw new InvalidFixedCostMonetaryResult('Dimension value carries an invalid truck identifier');
    }
  }

  const ordered = orderValues(result.values, request.sortDirection);
  const valueCount = ordered.length;
  const pageCount = valueCount === 0 ? 0 : Math.ceil(valueCount / request.perPage);
  if (valueCount > 0 && request.page > pageCount) {
    throw new TruckFixedCostDimensionsUnavailable('page_out_of_range', []);
  }
  const offset = (request.page - 1) * request.perPage;

  return {
    data: {
      availability: 'available',
      dimension: request.dimension,
      values: Object.freeze(ordered.slice(offset, offset + request.perPage)),
    },
    meta: metadata(request, entry, 'available', {
      pagination: { page: request.page, perPage: request.perPage, valueCount, pageCount, maxValues: fixedCostDimensionMaxValues },
      sorting: { sortBy: request.sortBy, sortDirection: request.sortDirection },
    }),
  };
}
