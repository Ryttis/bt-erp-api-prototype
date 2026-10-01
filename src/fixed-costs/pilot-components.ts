import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import { InvalidFixedCostQuery, parseFixedCostRequest, type FixedCostAllocationScope } from './contracts.js';
import {
  fixedCostAuthoritativeSource, fixedCostBreakdownSources, fixedCostMonetaryMaxRecords, InvalidFixedCostMonetaryResult,
  type DecimalString, type FixedCostMonetaryGroup, type FixedCostMonetaryResult,
} from './monetary-contract.js';
import {
  fixedCostComponentFields, fixedCostTrailerComponentFields, queryFixedCostRankedComponents,
  type FixedCostComponentField, type FixedCostRankedComponent,
  type FixedCostRankedComponentGroup, type FixedCostTrailerComponentField,
} from './monetary-repository.js';
import {
  pilotIncludedGroup, resolveTruckFixedCostPilotMonth, truckFixedCostPilotDeletedRowPolicy,
  truckFixedCostPilotLimitations, TruckFixedCostPilotRefused,
} from './pilot-summary.js';
import { orderFixedCostLimitations } from './summary-contract.js';

/**
 * Fleet-wide truck fixed-cost components pilot (MP-8), behind the truck pilot flag
 * `ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED`.
 *
 * TEMPORARY PILOT POLICY, NOT A PERMANENT FINANCE APPROVAL. The summary pilot's
 * rules apply unchanged: one settled complete calendar month, the locked
 * representation only, `deleted = 0` only, every included task locked. The
 * population is decided by `pilotIncludedGroup`, so this endpoint refuses exactly
 * when the fleet-wide summary would, and `authoritativeAmount` is the very same
 * stored total the summary reports as `amount`.
 *
 * Component amounts are the existing per-component comparable sums of the locked
 * detail table, keyed by the exact ERP column name (the same keys as the single-truck
 * breakdown's `reconciliation.locked.components`). They are explanatory only
 * (FC-06/FC-07): they cover comparable tasks only, never replace the stored total,
 * and the gap between them is reported, never closed. The database sums and orders
 * them in `DECIMAL`; nothing here adds, compares or sorts money.
 */

export const truckFixedCostComponentsSemanticsVersion = 'truck-fixed-cost-components-pilot-v1' as const;

/** Database order of `data.components`. Fixed; there is no request-selected sorting. */
export const truckFixedCostComponentsSorting = Object.freeze({
  sortBy: 'amount', sortDirection: 'desc', tieBreaker: Object.freeze({ field: 'component', direction: 'asc' }),
} as const);

/** The accepted component keys: the verified ERP column names, sorted. */
export const truckFixedCostComponentKeys: readonly FixedCostComponentField[] = Object.freeze([...fixedCostComponentFields].sort());

export const truckFixedCostComponentsLimitations = orderFixedCostLimitations([
  ...truckFixedCostPilotLimitations,
  'Component keys are the exact ERP column names of kastai_fiksuoti_vilkikai_det_locked; no business label or category mapping is applied or approved.',
  'Component amounts are explanatory only: they sum the locked detail columns over comparable tasks (a stored locked total and exactly one locked detail row), their independent additivity is unapproved (FC-06, FC-07), and they never replace authoritativeAmount.',
  'authoritativeAmount covers every included task and componentTotal only comparable tasks, so they can differ; the difference is reported under reconciliation and is never forced to zero or assigned to a residual component.',
  'Components are ordered by the database in DECIMAL by amount descending, then by component key ascending in binary order; zero and negative component amounts are listed unchanged.',
]);

export interface FixedCostComponentsRequest<K extends string = FixedCostComponentField | FixedCostTrailerComponentField> {
  /** Any recognised scope; the route enables only `truck` and `trailer`. */
  allocationScope: FixedCostAllocationScope;
  dateFrom: string;
  dateTo: string;
  /** One exact component key of the requested scope; absent means every component. */
  component?: K;
}

export type TruckFixedCostComponentsRequest = FixedCostComponentsRequest<FixedCostComponentField>;

/**
 * Exactly `allocationScope`, a paired date range and an optional `component`. No
 * selector, grouping, sorting, paging, representation or field input exists; an
 * unknown, repeated or case-variant component key is rejected.
 *
 * The key must belong to the requested scope's own verified column list: a truck
 * key on the trailer scope, or a trailer key on the truck scope, is rejected. Scopes
 * without a component source keep the truck list and are then refused by the route.
 */
export function parseFixedCostComponentsRequest(input: Record<string, unknown>): FixedCostComponentsRequest {
  const { component, ...rest } = input;
  const parsed = parseFixedCostRequest(rest);
  if (parsed.dateFrom === undefined || parsed.dateTo === undefined) throw new InvalidFixedCostQuery();
  const keys: readonly string[] = parsed.allocationScope === 'trailer' ? fixedCostTrailerComponentFields : fixedCostComponentFields;
  if (component !== undefined && (typeof component !== 'string' || !keys.includes(component))) throw new InvalidFixedCostQuery();
  return {
    allocationScope: parsed.allocationScope, dateFrom: parsed.dateFrom, dateTo: parsed.dateTo,
    ...(component === undefined ? {} : { component: component as FixedCostComponentField | FixedCostTrailerComponentField }),
  };
}

/** The truck-only name of `parseFixedCostComponentsRequest`, kept for existing callers. */
export const parseTruckFixedCostComponentsRequest = parseFixedCostComponentsRequest;

export interface TruckFixedCostPilotComponentsResponse {
  data: {
    allocationScope: 'truck';
    periodMonth: string;
    currency: 'EUR';
    representation: 'locked';
    /** Every component, or exactly the requested one, in database order. */
    components: readonly FixedCostRankedComponent[];
    /** The stored locked total of every included task; identical to the summary's `amount`. */
    authoritativeAmount: DecimalString;
    totalTaskCount: number;
    lockedTaskCount: number;
    reconciliation: {
      comparableTaskCount: number;
      /** Included tasks with no locked detail row; their components are not read. */
      noDetailTaskCount: number;
      /** Included tasks with several locked detail rows; their components are not read. */
      multipleDetailTaskCount: number;
      comparableAuthoritativeAmount: DecimalString;
      /** Sum of every component over comparable tasks, whatever `component` selected. */
      componentTotal: DecimalString;
      /** comparableAuthoritativeAmount - componentTotal, signed, from SQL. */
      netDifference: DecimalString;
      /** Per-task absolute differences, summed, from SQL; opposite signs cannot cancel. */
      grossAbsoluteDifference: DecimalString;
      affectedTaskCount: number;
      /** Database-evaluated: the listed component sums add up exactly to componentTotal. */
      componentsSumToComponentTotal: true;
    };
  };
  meta: {
    sourceFamily: 'truck_fixed_costs';
    amountSemantics: 'explanatory_locked_component_sums_over_comparable_tasks_excluding_deleted';
    authoritativeSource: typeof fixedCostAuthoritativeSource;
    componentSource: typeof fixedCostBreakdownSources['locked'];
    componentKeys: readonly FixedCostComponentField[];
    componentFilter: FixedCostComponentField | null;
    sorting: typeof truckFixedCostComponentsSorting;
    dateBasis: 'kastai_data';
    semanticsVersion: typeof truckFixedCostComponentsSemanticsVersion;
    reconciliationStatus: 'provisional_unreconciled_erp_reference';
    complete: true;
    pilot: true;
    limitations: readonly string[];
  };
}

const incomplete = () => new TruckFixedCostPilotRefused('INCOMPLETE_RESULT');

/**
 * The included population's database-ordered components, optionally narrowed to one
 * exact key. Shared by the truck and trailer component pilots; the caller has already
 * proven the read matches its scope and applied the population rules to `group`.
 */
export function selectIncludedRankedComponents(
  group: Pick<FixedCostMonetaryGroup, 'comparableRecords'>,
  ranking: readonly FixedCostRankedComponentGroup[],
  fields: readonly string[],
  component?: string,
): readonly FixedCostRankedComponent[] {
  const ranked = ranking.filter(entry => entry.deletedState === 'zero');
  if (ranked.length !== 1) throw new InvalidFixedCostMonetaryResult('The included population has no single component ranking');
  const [{ components, componentsReconcile }] = ranked;
  // Without a comparable task no component amount exists. That is not a zero.
  if (group.comparableRecords === 0 || components === null) throw incomplete();
  // Per-component sums that do not add up to their own total are a broken read, not a residual.
  if (componentsReconcile !== true) throw incomplete();
  if (components.length !== fields.length) throw incomplete();

  // Exact key selection, never arithmetic: the single amount is the same text the full list carries.
  const selected = component === undefined ? components : components.filter(entry => entry.component === component);
  if (component !== undefined && selected.length !== 1) throw incomplete();
  return Object.freeze(selected.map(entry => ({ component: entry.component, amount: entry.amount })));
}

/**
 * Applies the pilot rules to one ranked read. Exported for mutation tests; the route
 * always reaches it through `runTruckFixedCostPilotComponents`.
 */
export function projectTruckFixedCostPilotComponents(
  totals: FixedCostMonetaryResult,
  ranking: readonly FixedCostRankedComponentGroup[],
  periodMonth: string,
  component?: FixedCostComponentField,
): TruckFixedCostPilotComponentsResponse {
  // Same population rules, same refusals, same stored total as the fleet-wide summary.
  const group = pilotIncludedGroup(totals, 'locked', periodMonth);
  if (totals.meta.breakdownSource !== fixedCostBreakdownSources.locked) {
    throw new InvalidFixedCostMonetaryResult('Components were not read from the locked detail table');
  }
  const selected = selectIncludedRankedComponents(group, ranking, fixedCostComponentFields, component);

  return {
    data: {
      allocationScope: 'truck',
      periodMonth,
      currency: 'EUR',
      representation: 'locked',
      components: selected,
      authoritativeAmount: group.authoritativeTotal!,
      totalTaskCount: group.authoritativeRecords,
      lockedTaskCount: group.lockedRecords,
      reconciliation: {
        comparableTaskCount: group.comparableRecords,
        noDetailTaskCount: group.noDetailRecords,
        multipleDetailTaskCount: group.multipleDetailRecords,
        comparableAuthoritativeAmount: group.comparableAuthoritativeTotal!,
        componentTotal: group.componentTotal!,
        netDifference: group.netDifference!,
        grossAbsoluteDifference: group.grossAbsoluteDifference!,
        affectedTaskCount: group.affectedRecords,
        componentsSumToComponentTotal: true,
      },
    },
    meta: {
      sourceFamily: 'truck_fixed_costs',
      amountSemantics: 'explanatory_locked_component_sums_over_comparable_tasks_excluding_deleted',
      authoritativeSource: fixedCostAuthoritativeSource,
      componentSource: fixedCostBreakdownSources.locked,
      componentKeys: truckFixedCostComponentKeys,
      componentFilter: component ?? null,
      sorting: truckFixedCostComponentsSorting,
      dateBasis: 'kastai_data',
      semanticsVersion: truckFixedCostComponentsSemanticsVersion,
      reconciliationStatus: 'provisional_unreconciled_erp_reference',
      complete: true,
      pilot: true,
      limitations: truckFixedCostComponentsLimitations,
    },
  };
}

/** One locked, fleet-wide ranked read. Period rules run before any gate or replica access. */
export async function runTruckFixedCostPilotComponents(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  request: TruckFixedCostComponentsRequest & { allocationScope: 'truck' },
  now: Date = new Date(),
): Promise<TruckFixedCostPilotComponentsResponse> {
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const { totals, ranking } = await queryFixedCostRankedComponents(pool, gate, {
    allocationScope: 'truck', representation: 'locked', periodMonth, limit: fixedCostMonetaryMaxRecords, includeComponents: true,
  }, truckFixedCostPilotDeletedRowPolicy, now);
  return projectTruckFixedCostPilotComponents(totals, ranking, periodMonth, request.component);
}
