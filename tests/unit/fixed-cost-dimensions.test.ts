import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ReplicaPool } from '../../src/db/replica.js';
import { ApiError } from '../../src/errors.js';
import { fixedCostComponentInventory } from '../../src/fixed-costs/breakdown-contract.js';
import { fixedCostSemanticCapabilities } from '../../src/fixed-costs/capabilities.js';
import { fixedCostAllocationScopes, InvalidFixedCostQuery } from '../../src/fixed-costs/contracts.js';
import {
  fixedCostDimensionDefaultPageSize, fixedCostDimensionMaxPageSize, fixedCostDimensionMaxValues,
  fixedCostDimensionRegistry, fixedCostDimensions, isDimensionPubliclyAvailable,
  parseTruckFixedCostDimensionsRequest, TruckFixedCostDimensionsUnavailable,
  type FixedCostDimension, type FixedCostDimensionRegistryEntry, type TruckFixedCostDimensionsRequest,
} from '../../src/fixed-costs/dimension-contract.js';
import {
  listTruckFixedCostDimensions,
  type DimensionExecutorResult, type FixedCostDimensionExecutor,
} from '../../src/fixed-costs/dimension-service.js';
import { InvalidFixedCostMonetaryResult } from '../../src/fixed-costs/monetary-contract.js';
import { fixedCostComponentFields } from '../../src/fixed-costs/monetary-repository.js';

const base = { allocationScope: 'truck', dimension: 'truck' };
const request = (overrides: Record<string, string> = {}): TruckFixedCostDimensionsRequest =>
  parseTruckFixedCostDimensionsRequest({ ...base, ...overrides });

/** Only injected so the downstream path is reachable; the shipped registry is all false. */
const availableTruckRegistry = {
  ...fixedCostDimensionRegistry,
  truck: { ...fixedCostDimensionRegistry.truck, publicAvailability: true },
} as Readonly<Record<FixedCostDimension, FixedCostDimensionRegistryEntry>>;
const enabledTruck = { truck: { enabled: true } };

function executor(build: () => Partial<DimensionExecutorResult>) {
  const calls: { dimension: FixedCostDimension }[] = [];
  const execute: FixedCostDimensionExecutor = async input => {
    calls.push({ dimension: input.dimension });
    await setImmediate();
    const partial = build();
    const values = partial.values ?? [{ truckId: 11 }];
    return { dimension: input.dimension, values, complete: true, truncated: false, valueCount: values.length, ...partial };
  };
  return { execute, calls };
}

const listAvailable = (
  overrides: Partial<Parameters<typeof listTruckFixedCostDimensions>[0]> = {},
  build: () => Partial<DimensionExecutorResult> = () => ({}),
) => listTruckFixedCostDimensions({
  request: request(), capabilities: enabledTruck, registry: availableTruckRegistry,
  execute: executor(build).execute, ...overrides,
});

// --- registry -----------------------------------------------------------------

test('every shipped dimension is publicly unavailable with recorded blockers', () => {
  assert.deepEqual([...fixedCostDimensions], ['truck', 'costComponent', 'month']);
  for (const dimension of fixedCostDimensions) {
    const entry = fixedCostDimensionRegistry[dimension];
    assert.equal(entry.publicAvailability, false, `${dimension} must stay unavailable`);
    assert.equal(isDimensionPubliclyAvailable(dimension), false, dimension);
    assert.ok(entry.blockers.length > 0, `${dimension} records blockers`);
    assert.equal(entry.key, dimension);
    assert.ok(entry.structuralSource.length > 0);
    assert.ok(entry.maxPageSize > 0 && entry.maxPageSize <= fixedCostDimensionMaxPageSize);
  }
  assert.deepEqual([...fixedCostDimensionRegistry.truck.blockers], ['FC-11', 'FC-14', 'FC-03', 'FC-02', 'FC-P17']);
  assert.deepEqual([...fixedCostDimensionRegistry.costComponent.blockers], ['FC-06', 'FC-07']);
  assert.deepEqual([...fixedCostDimensionRegistry.month.blockers], ['FC-P19', 'FC-P17']);
  // Structural verification is never stated as business approval. The registry does
  // say "unapproved", which is the opposite claim, so the guard targets positive
  // approval wording rather than the substring "approved".
  assert.match(fixedCostDimensionRegistry.truck.structuralSource, /uzdavinio_masina/);
  const serialized = JSON.stringify(fixedCostDimensionRegistry);
  assert.doesNotMatch(serialized, /(?<!un)approved business|business[- ]approved|is approved|has been approved/i);
  assert.match(serialized, /unapproved/i, 'The component restriction states additivity is unapproved');
});

test('the registry is static, deeply frozen and cannot be flipped on at runtime', () => {
  assert.ok(Object.isFrozen(fixedCostDimensionRegistry));
  for (const dimension of fixedCostDimensions) {
    const entry = fixedCostDimensionRegistry[dimension];
    assert.ok(Object.isFrozen(entry), `${dimension} entry frozen`);
    assert.ok(Object.isFrozen(entry.blockers) && Object.isFrozen(entry.allowedFields) && Object.isFrozen(entry.exposure));
    assert.throws(() => { (entry as { publicAvailability: boolean }).publicAvailability = true; }, TypeError, dimension);
    assert.throws(() => { (entry.allowedFields as string[]).push('masinos_nr'); }, TypeError, dimension);
    assert.equal(fixedCostDimensionRegistry[dimension].publicAvailability, false, 'still unavailable after the attempt');
  }
});

// --- truck field boundary -----------------------------------------------------

test('the truck dimension exposes only the verified numeric identifier', () => {
  const entry = fixedCostDimensionRegistry.truck;
  assert.deepEqual([...entry.allowedFields], ['truckId']);
  assert.deepEqual([...entry.allowedFilters], ['truckId']);
  assert.deepEqual([...entry.allowedSorting], ['truckId']);
  assert.equal(entry.exposure.classification, 'internal_identifier');
  // No registration, status, lifecycle, people, comment or unrelated masinos column.
  const forbidden = [
    'masinos_nr', 'plate_number', 'registration', 'vin', 'kebulo_nr', 'marke', 'modelis',
    'nebedirba', 'dirba_nuo', 'nebedirba_nuo', 'tipas_kastu', 'paskutinis_uzdavinio_id',
    'driver', 'vairuotojas', 'employee', 'password', 'slaptazodis', 'comment', 'pastabos',
    'department', 'skyrius', 'lease', 'lizingas', 'rent_price', 'odometer', 'displayName', 'name', 'label',
  ];
  const serialized = JSON.stringify(fixedCostDimensionRegistry.truck);
  for (const field of forbidden) {
    assert.ok(!entry.allowedFields.includes(field), `allowedFields must not contain ${field}`);
    assert.ok(!entry.allowedFilters.includes(field), `allowedFilters must not contain ${field}`);
    assert.ok(!entry.allowedSorting.includes(field), `allowedSorting must not contain ${field}`);
  }
  // The restriction text names them as excluded rather than the registry carrying them.
  assert.match(entry.exposure.restriction, /Numeric identifier only/);
  assert.ok(!/"masinos_nr"|"vin"|"plate_number"/.test(serialized));
});

test('no unknown-truck value or display name is ever invented', async () => {
  // An executor supplying anything but a positive integer identifier fails closed.
  for (const value of [{ truckId: 0 }, { truckId: -1 }, { truckId: 1.5 }]) {
    await assert.rejects(listAvailable({}, () => ({ values: [value] })), InvalidFixedCostMonetaryResult, JSON.stringify(value));
  }
  // Extra or unapproved fields on a value are refused before reaching a response.
  for (const value of [
    { truckId: 11, masinos_nr: 'ABC123' }, { truckId: 11, displayName: 'Truck 11' },
    { truckId: 11, label: 'unknown' }, { name: 'unknown' }, { truckId: 11, active: true },
  ]) {
    await assert.rejects(
      listAvailable({}, () => ({ values: [value as never] })),
      (error: unknown) => {
        assert.ok(error instanceof InvalidFixedCostMonetaryResult);
        assert.match(String(error), /outside the allowlist|invalid truck identifier/);
        return true;
      }, JSON.stringify(value),
    );
  }
  // A valid listing carries the identifier and nothing else.
  const response = await listAvailable({}, () => ({ values: [{ truckId: 11 }, { truckId: 22 }] }));
  assert.equal(response.data.availability, 'available');
  if (response.data.availability !== 'available') throw new Error('unreachable');
  assert.deepEqual(response.data.values.map(value => Object.keys(value)), [['truckId'], ['truckId']]);
  assert.doesNotMatch(JSON.stringify(response.data.values), /unknown|orphan|null|"0"/i);
});

// --- component inventory ------------------------------------------------------

test('the component inventory is an exact static allowlist, explanatory and non-public', () => {
  const entry = fixedCostDimensionRegistry.costComponent;
  assert.equal(entry.publicAvailability, false);
  assert.equal(entry.exposure.classification, 'technical_schema_field');
  assert.equal(fixedCostComponentInventory.independentlyAdditive, false);
  assert.equal(fixedCostComponentInventory.syntheticResidualBucket, false);
  assert.equal(fixedCostComponentInventory.status, 'explanatory_semantics_unverified');
  // Exactly the fifteen verified schema columns, deterministically ordered.
  const fields = [...fixedCostComponentInventory.fields];
  assert.equal(fields.length, 15);
  assert.deepEqual(fields, [...fixedCostComponentFields].sort());
  assert.deepEqual(fields, [...fields].sort(), 'Stable deterministic ordering');
  assert.equal(new Set(fields).size, fields.length);
  // No synthetic residual and no invented business label.
  assert.ok(!fields.some(field => /^(other|misc|residual|balance|unallocated)$/i.test(field)));
  assert.doesNotMatch(JSON.stringify(fields), /fuel|payroll|overhead|category|costGroup/i);
  // The inventory is never presented as an approved public dimension.
  assert.deepEqual([...entry.allowedFilters], [], 'No filter is offered for an unapproved dimension');
});

// --- month boundary -----------------------------------------------------------

test('the month dimension performs zero database access and is blocked by FC-P19 and FC-P17', async () => {
  const { execute, calls } = executor(() => ({}));
  const response = await listTruckFixedCostDimensions({
    request: request({ dimension: 'month' }), capabilities: enabledTruck, execute,
  });
  assert.equal(response.data.availability, 'unavailable');
  assert.equal(calls.length, 0, 'No executor call for a blocked dimension');
  if (response.data.availability !== 'unavailable') throw new Error('unreachable');
  assert.deepEqual([...response.data.blockers], ['FC-P19', 'FC-P17']);
  assert.equal(response.meta.dateBasis, 'kastai_data');
  assert.match(fixedCostDimensionRegistry.month.exposure.restriction, /unindexed/);
});

// --- request contract ---------------------------------------------------------

test('the dimensions request accepts the allowlist and applies documented defaults', () => {
  assert.deepEqual(request(), {
    allocationScope: 'truck', dimension: 'truck', page: 1,
    perPage: fixedCostDimensionDefaultPageSize, sortBy: 'truckId', sortDirection: 'asc',
  });
  assert.equal(request({ dimension: 'costComponent' }).sortBy, 'componentField');
  assert.equal(request({ dimension: 'month' }).sortBy, 'month');
  assert.equal(request({ perPage: '200' }).perPage, 200);
  assert.equal(request({ sortDirection: 'desc' }).sortDirection, 'desc');
});

test('the dimensions request rejects unknown, repeated, schema-discovery and SQL-shaped input', () => {
  const invalid: Record<string, unknown>[] = [
    {}, { allocationScope: 'truck' }, { dimension: 'truck' },
    { ...base, allocationScope: 'trailer' }, { ...base, allocationScope: 'fleet' },
    { ...base, dimension: 'driver' }, { ...base, dimension: 'TRUCK' }, { ...base, dimension: '' },
    // Repeated parameters arrive as arrays.
    { ...base, dimension: ['truck', 'month'] }, { allocationScope: ['truck', 'truck'], dimension: 'truck' },
    // Pagination bounds.
    { ...base, page: '0' }, { ...base, page: '-1' }, { ...base, perPage: '0' },
    { ...base, perPage: String(fixedCostDimensionMaxPageSize + 1) }, { ...base, perPage: '1e3' }, { ...base, perPage: ' 10' },
    // Sorting is allowlisted per dimension; a key from another dimension is refused.
    { ...base, sortBy: 'componentField' }, { ...base, dimension: 'month', sortBy: 'truckId' },
    { ...base, sortBy: 'masinos_nr' }, { ...base, sortDirection: 'up' },
    // Schema discovery is deliberately not offered here.
    { ...base, table: 'masinos' }, { ...base, column: 'masinos_nr' }, { ...base, schema: 'infot_2' },
    { ...base, q: 'masinos' }, { ...base, search: 'truck' }, { ...base, pattern: '%' },
    { ...base, include: 'columns' }, { ...base, expand: 'schema' },
    // Fields, measures, grouping and internal controls.
    { ...base, fields: 'truckId' }, { ...base, measures: 'count' }, { ...base, groupBy: 'truck' },
    { ...base, deletedPolicy: 'include_all' }, { ...base, tolerance: '1.00' },
    { ...base, representation: 'locked' }, { ...base, limit: '5' }, { ...base, maxValues: '10' },
    // SQL-shaped input.
    { ...base, dimension: "truck'; DROP TABLE masinos --" },
    { ...base, sortBy: 'truckId; DROP TABLE masinos' },
    { ...base, perPage: '10 OR 1=1' },
  ];
  for (const input of invalid) {
    assert.throws(() => parseTruckFixedCostDimensionsRequest(input), InvalidFixedCostQuery, JSON.stringify(input));
  }
});

// --- gates --------------------------------------------------------------------

test('capability and availability gates run before any executor access', async () => {
  // Real registry: every dimension unavailable, zero executor calls.
  for (const dimension of fixedCostDimensions) {
    const { execute, calls } = executor(() => ({}));
    const response = await listTruckFixedCostDimensions({ request: request({ dimension }), capabilities: enabledTruck, execute });
    assert.equal(response.data.availability, 'unavailable', dimension);
    assert.equal(calls.length, 0, `${dimension} reached no executor`);
  }
  // Real capabilities: disabled, so even an available registry never executes.
  const { execute, calls } = executor(() => ({}));
  const disabled = await listTruckFixedCostDimensions({ request: request(), execute, registry: availableTruckRegistry });
  assert.equal(disabled.data.availability, 'unavailable');
  assert.equal(calls.length, 0, 'Disabled capability blocked before the executor');
  for (const scope of fixedCostAllocationScopes) assert.equal(fixedCostSemanticCapabilities[scope].enabled, false);
});

test('an unavailable dimension is never a plausible empty success', async () => {
  const response = await listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck });
  assert.equal(response.data.availability, 'unavailable');
  // No values array at all, so it cannot be confused with "available but empty".
  assert.ok(!Object.hasOwn(response.data, 'values'));
  assert.equal(response.meta.complete, false);
  assert.equal(response.meta.pagination, null);
  assert.equal(response.meta.sorting, null);
  assert.doesNotMatch(JSON.stringify(response.data), /"values"\s*:\s*\[\]/);

  // An available dimension that genuinely has no values looks different.
  const empty = await listAvailable({}, () => ({ values: [] }));
  assert.equal(empty.data.availability, 'available');
  if (empty.data.availability !== 'available') throw new Error('unreachable');
  assert.deepEqual([...empty.data.values], []);
  assert.equal(empty.meta.complete, true);
  assert.equal(empty.meta.pagination?.valueCount, 0);
});

// --- pagination, ordering, completeness ---------------------------------------

test('values are deterministically ordered in both directions and bounded by page', async () => {
  const values = [33, 11, 22].map(truckId => ({ truckId }));
  const ascending = await listAvailable({}, () => ({ values }));
  if (ascending.data.availability !== 'available') throw new Error('unreachable');
  assert.deepEqual(ascending.data.values.map(value => (value as { truckId: number }).truckId), [11, 22, 33]);
  const descending = await listAvailable({ request: request({ sortDirection: 'desc' }) }, () => ({ values }));
  if (descending.data.availability !== 'available') throw new Error('unreachable');
  assert.deepEqual(descending.data.values.map(value => (value as { truckId: number }).truckId), [33, 22, 11]);

  // Pages tile the set exactly once.
  const many = Array.from({ length: 25 }, (_, index) => ({ truckId: index + 1 }));
  const seen: number[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await listAvailable({ request: request({ page: String(page), perPage: '10' }) }, () => ({ values: many }));
    if (response.data.availability !== 'available') throw new Error('unreachable');
    assert.equal(response.meta.pagination?.page, page);
    assert.equal(response.meta.pagination?.valueCount, 25);
    assert.equal(response.meta.pagination?.pageCount, 3);
    seen.push(...response.data.values.map(value => (value as { truckId: number }).truckId));
  }
  assert.deepEqual(seen, many.map(value => value.truckId));
  await assert.rejects(
    listAvailable({ request: request({ page: '4', perPage: '10' }) }, () => ({ values: many })),
    (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostDimensionsUnavailable);
      assert.equal(error.reason, 'page_out_of_range');
      return true;
    },
  );
});

test('incomplete, truncated, duplicate, mismatched or oversized results fail closed', async () => {
  for (const partial of [{ complete: false }, { truncated: true }]) {
    await assert.rejects(listAvailable({}, () => partial), (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostDimensionsUnavailable);
      assert.equal(error.reason, 'incomplete_values');
      return true;
    });
  }
  await assert.rejects(listAvailable({}, () => ({ values: [{ truckId: 11 }], valueCount: 5 })), InvalidFixedCostMonetaryResult);
  await assert.rejects(listAvailable({}, () => ({ values: [{ truckId: 11 }, { truckId: 11 }] })), InvalidFixedCostMonetaryResult);
  await assert.rejects(listAvailable({}, () => ({ dimension: 'month' as FixedCostDimension })), InvalidFixedCostMonetaryResult);
  const oversized = Array.from({ length: fixedCostDimensionMaxValues + 1 }, (_, index) => ({ truckId: index + 1 }));
  await assert.rejects(listAvailable({}, () => ({ values: oversized })), (error: unknown) => {
    assert.ok(error instanceof TruckFixedCostDimensionsUnavailable);
    assert.equal(error.reason, 'value_count_exceeded');
    return true;
  });
});

test('timeout and SERVICE_BUSY errors propagate unchanged for a future available executor', async () => {
  const timeout = Object.assign(new Error('driver'), { code: 'ER_STATEMENT_TIMEOUT', statusCode: 504 });
  await assert.rejects(
    listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck, registry: availableTruckRegistry, execute: async () => { throw timeout; } }),
    (error: unknown) => { assert.equal(error, timeout, 'Timeout is not re-wrapped'); return true; },
  );
  const busy = new ApiError(503, 'SERVICE_BUSY', 'Analytical service is busy');
  await assert.rejects(
    listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck, registry: availableTruckRegistry, execute: async () => { throw busy; } }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'SERVICE_BUSY');
      assert.equal(error.statusCode, 503);
      return true;
    },
  );
});

test('metadata is deterministic, blocker-aware and invents nothing', async () => {
  const response = await listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck });
  assert.equal(response.meta.allocationScope, 'truck');
  assert.equal(response.meta.dimension, 'truck');
  assert.equal(response.meta.availability, 'unavailable');
  assert.equal(response.meta.sourceFamily, 'fixed_cost_truck_allocation');
  assert.equal(response.meta.dateBasis, null, 'No period basis applies to the truck dimension');
  assert.deepEqual([...response.meta.allowedFields], ['truckId']);
  assert.equal(response.meta.componentInventory, null, 'Inventory only surfaces for the component dimension');
  const limitations = [...response.meta.limitations];
  assert.deepEqual(limitations, [...limitations].sort(), 'Limitations sorted');
  assert.equal(new Set(limitations).size, limitations.length);
  assert.ok(limitations.some(entry => /publicly unavailable because no fixed-cost filter or grouping/.test(entry)));
  for (const approval of ['FC-02', 'FC-03', 'FC-06', 'FC-07', 'FC-11', 'FC-14', 'FC-P17', 'FC-P19']) {
    assert.ok(response.meta.pendingApprovals.includes(approval), approval);
  }
  const component = await listTruckFixedCostDimensions({ request: request({ dimension: 'costComponent' }), capabilities: enabledTruck });
  assert.equal(component.meta.componentInventory?.independentlyAdditive, false);
});

// --- mutation guards ----------------------------------------------------------

test('mutation: weakening a boundary changes an observable outcome', async () => {
  // Enabling a dimension in the registry is the only thing that reaches an executor.
  const blocked = executor(() => ({}));
  await listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck, execute: blocked.execute });
  assert.equal(blocked.calls.length, 0, 'Shipped registry never executes');
  const opened = executor(() => ({}));
  const response = await listTruckFixedCostDimensions({
    request: request(), capabilities: enabledTruck, registry: availableTruckRegistry, execute: opened.execute,
  });
  assert.equal(opened.calls.length, 1, 'Only an available registry executes');
  assert.equal(response.data.availability, 'available');

  // Adding an unapproved truck field, or a request-controlled column, is refused.
  await assert.rejects(listAvailable({}, () => ({ values: [{ truckId: 11, masinos_nr: 'ABC' } as never] })), InvalidFixedCostMonetaryResult);
  assert.throws(() => parseTruckFixedCostDimensionsRequest({ ...base, sortBy: 'masinos_nr' }), InvalidFixedCostQuery);
  assert.throws(() => parseTruckFixedCostDimensionsRequest({ ...base, column: 'masinos_nr' }), InvalidFixedCostQuery);

  // Querying before the availability gate would have produced values.
  const gated = executor(() => ({}));
  const month = await listTruckFixedCostDimensions({ request: request({ dimension: 'month' }), capabilities: enabledTruck, execute: gated.execute });
  assert.equal(gated.calls.length, 0);
  assert.equal(month.data.availability, 'unavailable');

  // Exposing components as independently additive would flip a recorded constant.
  assert.equal(fixedCostComponentInventory.independentlyAdditive, false);
  assert.equal(fixedCostDimensionRegistry.costComponent.publicAvailability, false);

  // Treating incomplete results as complete would have produced a response.
  await assert.rejects(listAvailable({}, () => ({ truncated: true })), TruckFixedCostDimensionsUnavailable);
});

// --- public route boundary ----------------------------------------------------

test('public dimensions requests stay blocked with zero replica access', async () => {
  const config = loadConfig({
    ERP_REPLICA_HOST: 'example.invalid', ERP_REPLICA_DATABASE: 'infot_2', ERP_REPLICA_USER: 'test',
    ERP_REPLICA_PASSWORD: 'test', ERP_ANALYTICS_API_TOKEN: 'test-token-that-is-longer-than-thirty-two-characters',
  });
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => { queries.push(sql); throw new Error('Public routes must not reach the replica'); },
    end: async () => {},
  } as ReplicaPool;
  const app = buildApp(config, () => pool, { authenticate: false });
  const routes = new Set<string>();
  app.addHook('onRoute', route => { routes.add(route.url); });
  try {
    await app.ready();
    const blocked = await app.inject('/expense-analytics/fixed-costs/dimensions?allocationScope=truck');
    assert.equal(blocked.statusCode, 422);
    assert.equal(blocked.json().error.code, 'SEMANTICS_UNVERIFIED');
    // Summary and breakdown are unchanged, and every scope stays blocked.
    for (const endpoint of ['summary', 'breakdown', 'dimensions']) {
      for (const scope of fixedCostAllocationScopes) {
        const response = await app.inject(`/expense-analytics/fixed-costs/${endpoint}?allocationScope=${scope}`);
        assert.equal(response.statusCode, 422, `${endpoint}/${scope}`);
        assert.equal(response.json().error.code, 'SEMANTICS_UNVERIFIED');
      }
    }
    // Dimension-specific and schema-discovery input is refused before the gate.
    for (const query of [
      'allocationScope=truck&dimension=truck', 'allocationScope=truck&dimension=month',
      'allocationScope=truck&perPage=10', 'allocationScope=truck&sortBy=truckId',
      'allocationScope=truck&table=masinos', 'allocationScope=truck&column=masinos_nr',
      'allocationScope=truck&schema=infot_2', 'allocationScope=truck&q=masinos',
    ]) {
      const rejected = await app.inject(`/expense-analytics/fixed-costs/dimensions?${query}`);
      assert.equal(rejected.statusCode, 400, query);
      assert.equal(rejected.json().error.code, 'INVALID_QUERY');
    }
    // No dimensions sub-route, schema-discovery, diagnostic, reconciliation or monetary path.
    assert.ok([...routes].every(path => !/monetary|reconcil|diagnost|totals|component|dimension\//i.test(path)));
    for (const path of [
      '/expense-analytics/fixed-costs/dimensions/truck', '/expense-analytics/fixed-costs/dimensions/values',
      '/expense-analytics/fixed-costs/schema', '/expense-analytics/fixed-costs/columns',
      '/fixed-costs/dimensions',
    ]) {
      for (const method of ['GET', 'POST'] as const) assert.equal((await app.inject({ method, url: path })).statusCode, 404, path);
    }
    assert.deepEqual([...routes].filter(path => path.includes('fixed-costs')).sort(), [
      // MP-8 single-trailer month discovery; the only fixed-cost route added since.
      '/expense-analytics/fixed-costs/available-periods',
      '/expense-analytics/fixed-costs/breakdown',
      '/expense-analytics/fixed-costs/dimensions',
      '/expense-analytics/fixed-costs/summary',
    ], 'No new fixed-cost route');
    assert.equal(queries.length, 0, 'Zero replica access');
  } finally { await app.close(); }
});

// --- review corrections -------------------------------------------------------

test('a registry entry that is missing or mislabelled fails closed with a typed error', async () => {
  // Previously this dereferenced undefined and surfaced a raw TypeError.
  for (const registry of [
    { truck: undefined },
    {},
    // An entry whose key disagrees with its slot is a misconfiguration too.
    { ...fixedCostDimensionRegistry, truck: { ...fixedCostDimensionRegistry.month, publicAvailability: true } },
  ]) {
    await assert.rejects(
      listTruckFixedCostDimensions({
        request: request(), capabilities: enabledTruck,
        registry: registry as Readonly<Record<FixedCostDimension, FixedCostDimensionRegistryEntry>>,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TruckFixedCostDimensionsUnavailable, 'Typed, not a raw TypeError');
        assert.equal(error.reason, 'registry_entry_missing');
        return true;
      }, JSON.stringify(Object.keys(registry)),
    );
  }
});

test('an available dimension without an executor reports the executor, not the dimension', async () => {
  // Saying `dimension_unavailable` here would misstate system state: the registry
  // says available, and it is the caller that supplied no executor.
  await assert.rejects(
    listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck, registry: availableTruckRegistry }),
    (error: unknown) => {
      assert.ok(error instanceof TruckFixedCostDimensionsUnavailable);
      assert.equal(error.reason, 'executor_unavailable');
      return true;
    },
  );
  // A genuinely unavailable dimension still reports unavailability, not an error.
  const blocked = await listTruckFixedCostDimensions({ request: request(), capabilities: enabledTruck });
  assert.equal(blocked.data.availability, 'unavailable');
});

test('string-keyed dimensions order totally in both directions', async () => {
  const componentRegistry = {
    ...fixedCostDimensionRegistry,
    costComponent: { ...fixedCostDimensionRegistry.costComponent, publicAvailability: true },
  } as Readonly<Record<FixedCostDimension, FixedCostDimensionRegistryEntry>>;
  const values = [{ componentField: 'remontas' }, { componentField: 'amortizacija' }, { componentField: 'padangos' }];
  for (const [direction, expected] of [
    ['asc', ['amortizacija', 'padangos', 'remontas']],
    ['desc', ['remontas', 'padangos', 'amortizacija']],
  ] as const) {
    const response = await listTruckFixedCostDimensions({
      request: request({ dimension: 'costComponent', sortDirection: direction }),
      capabilities: enabledTruck, registry: componentRegistry,
      execute: async () => ({ dimension: 'costComponent', values, complete: true, truncated: false, valueCount: 3 }),
    });
    if (response.data.availability !== 'available') throw new Error('unreachable');
    assert.deepEqual(response.data.values.map(value => (value as { componentField: string }).componentField), [...expected]);
  }
});
