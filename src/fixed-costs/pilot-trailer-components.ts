import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import {
  fixedCostAuthoritativeSource, fixedCostTrailerBreakdownSources, InvalidFixedCostMonetaryResult,
  type DecimalString, type FixedCostMonetaryGroup, type FixedCostMonetaryResult,
} from './monetary-contract.js';
import {
  fixedCostTrailerComponentFields, queryTrailerFleetRankedComponents,
  type FixedCostRankedComponent, type FixedCostRankedComponentGroup, type FixedCostTrailerComponentField,
} from './monetary-repository.js';
import {
  selectIncludedRankedComponents, truckFixedCostComponentsSorting, type FixedCostComponentsRequest,
} from './pilot-components.js';
import { pilotIncludedPopulation, resolveTruckFixedCostPilotMonth } from './pilot-summary.js';
import { trailerFixedCostPilotDeletedRowPolicy } from './pilot-trailer.js';
import { orderFixedCostLimitations } from './summary-contract.js';

/**
 * Fleet-wide trailer fixed-cost components pilot (MP-8), behind the trailer pilot flag
 * `ERP_FIXED_COST_TRAILER_PILOT_ENABLED`. Answers "how much was spent on trailer
 * component X in month M" for the whole trailer fleet.
 *
 * TEMPORARY PILOT POLICY, NOT A PERMANENT FINANCE APPROVAL. The fleet-wide trailer
 * summary's rules apply unchanged: one settled complete calendar month, the locked
 * representation only, `deleted = 0` only, every included task locked. The population
 * is the fleet summary's — every summary row of the month — so `authoritativeAmount`
 * is the same stored `locked_kastaiPriekabos` total the fleet summary reports as
 * `amount`, and the request refuses whenever that population would.
 *
 * Component amounts are the per-component comparable sums of
 * `kastai_fiksuoti_priekabos_det_locked`, the locked detail source of the
 * single-trailer breakdown, keyed by the exact ERP column name. They are explanatory
 * only (FC-06/FC-07): they cover comparable tasks only, never replace the stored
 * total, and the gap is reported, never closed. The database sums and orders them in
 * `DECIMAL`; nothing here adds, compares or sorts money.
 */

export const trailerFleetFixedCostComponentsSemanticsVersion = 'trailer-fleet-fixed-cost-components-pilot-v1' as const;

/** The accepted trailer component keys: the verified ERP column names, sorted. */
export const trailerFleetFixedCostComponentKeys: readonly FixedCostTrailerComponentField[] = Object.freeze([...fixedCostTrailerComponentFields].sort());

export const trailerFleetFixedCostComponentsLimitations = orderFixedCostLimitations([
  'Provisional internal pilot result for BT Finance Analyst; it is not an officially reconciled Finance report.',
  'Not reconciled against an accepted official ERP report (FC-11); reconciliationStatus stays provisional_unreconciled_erp_reference.',
  'Rows with deleted = 1 are excluded under a temporary MP-8 pilot policy; the deleted-row rule is not permanently approved by Finance (FC-03).',
  'Supports exactly one settled complete calendar month that starts at least six months before the current month.',
  'Zero and negative stored amounts are passed through unchanged; their treatment is unapproved (FC-13).',
  'Month filtering on kastai_data has no supporting index and scans the summary table; this is internal low-volume pilot behaviour and is not production-ready (FC-P17).',
  'Lock state uses the 0000-00-00 sentinel on locked_kastaiPriekabos_data by analogy with the ERP-confirmed truck rule (FCB-05); ERP has not confirmed it for trailers.',
  'authoritativeAmount is the stored locked_kastaiPriekabos total from kastai_fiksuoti_ataskaita over the fleet-wide trailer summary population, including rows without an attributable trailer; it is never recomputed from component fields and no current value is reported.',
  'Component keys are the exact ERP column names of kastai_fiksuoti_priekabos_det_locked; no business label or category mapping is applied or approved.',
  'Component amounts are explanatory only: they sum the locked detail columns over comparable tasks (a stored locked total and exactly one locked detail row), their independent additivity is unapproved (FC-06, FC-07), and they never replace authoritativeAmount.',
  'authoritativeAmount covers every included task and componentTotal only comparable tasks, so they can differ; the difference is reported under reconciliation and is never forced to zero or assigned to a residual component.',
  'Components are ordered by the database in DECIMAL by amount descending, then by component key ascending in binary order; zero and negative component amounts are listed unchanged.',
  'Fleet-wide only: no trailerId, grouping, ranking or paging is accepted; per-trailer components are available through the single-trailer breakdown.',
]);

export type TrailerFleetFixedCostComponentsRequest = FixedCostComponentsRequest<FixedCostTrailerComponentField> & { allocationScope: 'trailer' };

export interface TrailerFleetFixedCostPilotComponentsResponse {
  data: {
    allocationScope: 'trailer';
    periodMonth: string;
    currency: 'EUR';
    representation: 'locked';
    /** Every trailer component, or exactly the requested one, in database order. */
    components: readonly FixedCostRankedComponent[];
    /** The stored locked trailer total of every included task; identical to the fleet summary's `amount`. */
    authoritativeAmount: DecimalString;
    totalTaskCount: number;
    lockedTaskCount: number;
    reconciliation: {
      comparableTaskCount: number;
      /** Included tasks with no locked trailer detail row; their components are not read. */
      noDetailTaskCount: number;
      /** Included tasks with several locked trailer detail rows; their components are not read. */
      multipleDetailTaskCount: number;
      comparableAuthoritativeAmount: DecimalString;
      /** Sum of every trailer component over comparable tasks, whatever `component` selected. */
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
    sourceFamily: 'trailer_fixed_costs';
    amountSemantics: 'explanatory_locked_component_sums_over_comparable_tasks_excluding_deleted';
    authoritativeSource: typeof fixedCostAuthoritativeSource;
    componentSource: typeof fixedCostTrailerBreakdownSources['locked'];
    componentKeys: readonly FixedCostTrailerComponentField[];
    componentFilter: FixedCostTrailerComponentField | null;
    sorting: typeof truckFixedCostComponentsSorting;
    dateBasis: 'kastai_data';
    semanticsVersion: typeof trailerFleetFixedCostComponentsSemanticsVersion;
    reconciliationStatus: 'provisional_unreconciled_erp_reference';
    complete: true;
    pilot: true;
    limitations: readonly string[];
  };
}

/**
 * The read must be the fleet-wide locked trailer read: scope, representation, period,
 * sources and the absence of any trailer or truck filter are all checked before the
 * shared population rules run, so neither a truck read nor a single-trailer read can
 * be projected as a fleet trailer result.
 */
export function trailerFleetComponentsIncludedGroup(result: FixedCostMonetaryResult, periodMonth: string): FixedCostMonetaryGroup {
  const { meta } = result;
  if (meta.allocationScope !== 'trailer' || meta.representation !== 'locked' || meta.periodMonth !== periodMonth
    || meta.currency !== 'EUR' || meta.dateBasis !== 'kastai_data' || meta.authoritativeSource !== fixedCostAuthoritativeSource
    || meta.breakdownSource !== fixedCostTrailerBreakdownSources.locked
    || meta.trailerFilterApplied !== false || meta.truckFilterApplied !== false) {
    throw new InvalidFixedCostMonetaryResult('Repository result does not match the fleet trailer components read');
  }
  return pilotIncludedPopulation(result);
}

/**
 * Applies the pilot rules to one ranked read. Exported for mutation tests; the route
 * always reaches it through `runTrailerFleetFixedCostPilotComponents`.
 */
export function projectTrailerFleetFixedCostPilotComponents(
  totals: FixedCostMonetaryResult,
  ranking: readonly FixedCostRankedComponentGroup[],
  periodMonth: string,
  component?: FixedCostTrailerComponentField,
): TrailerFleetFixedCostPilotComponentsResponse {
  const group = trailerFleetComponentsIncludedGroup(totals, periodMonth);
  const components = selectIncludedRankedComponents(group, ranking, fixedCostTrailerComponentFields, component);
  return {
    data: {
      allocationScope: 'trailer',
      periodMonth,
      currency: 'EUR',
      representation: 'locked',
      components,
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
      sourceFamily: 'trailer_fixed_costs',
      amountSemantics: 'explanatory_locked_component_sums_over_comparable_tasks_excluding_deleted',
      authoritativeSource: fixedCostAuthoritativeSource,
      componentSource: fixedCostTrailerBreakdownSources.locked,
      componentKeys: trailerFleetFixedCostComponentKeys,
      componentFilter: component ?? null,
      sorting: truckFixedCostComponentsSorting,
      dateBasis: 'kastai_data',
      semanticsVersion: trailerFleetFixedCostComponentsSemanticsVersion,
      reconciliationStatus: 'provisional_unreconciled_erp_reference',
      complete: true,
      pilot: true,
      limitations: trailerFleetFixedCostComponentsLimitations,
    },
  };
}

/** One locked, fleet-wide ranked trailer read. Period rules run before any gate or replica access. */
export async function runTrailerFleetFixedCostPilotComponents(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  request: TrailerFleetFixedCostComponentsRequest,
  now: Date = new Date(),
): Promise<TrailerFleetFixedCostPilotComponentsResponse> {
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const { totals, ranking } = await queryTrailerFleetRankedComponents(pool, gate, periodMonth, trailerFixedCostPilotDeletedRowPolicy, now);
  return projectTrailerFleetFixedCostPilotComponents(totals, ranking, periodMonth, request.component);
}
