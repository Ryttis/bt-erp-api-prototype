import {
  assertApprovedDeletedRowPolicy, fixedCostAuthoritativeSource, fixedCostBreakdownSources,
  fixedCostRepresentations, InvalidFixedCostMonetaryResult, unapprovedFixedCostDeletedRowPolicy,
  type FixedCostDeletedRowPolicy, type FixedCostMonetaryGroup, type FixedCostMonetaryResult,
  type FixedCostRepresentation,
} from './monetary-contract.js';
import {
  assertSummaryPeriodMonths, orderFixedCostLimitations, truckFixedCostSummaryLimitations,
  truckFixedCostSummaryPendingApprovals,
  TruckFixedCostSummaryUnavailable,
  type TruckFixedCostSummaryReconciliation, type TruckFixedCostSummaryRequest, type TruckFixedCostSummaryResponse,
} from './summary-contract.js';

/**
 * Slice 6A — internal truck summary orchestration.
 *
 * Assembles a summary response from the existing monetary repository without
 * activating any public capability. The current and locked representations are
 * fetched through two independent calls and are never substituted for one another,
 * added together, or derived from component sums.
 *
 * The executor is injected, so the whole assembler is unit-testable with fakes and
 * the public route never gains a path to the replica.
 */

/** One independent monetary read. The caller supplies no SQL, table or field. */
export type FixedCostMonetaryExecutor = (input: {
  allocationScope: 'truck';
  representation: FixedCostRepresentation;
  periodMonth: string;
}) => Promise<FixedCostMonetaryResult>;

export interface TruckFixedCostSummaryInput {
  request: TruckFixedCostSummaryRequest;
  /**
   * Cost months to summarise, supplied by an internal caller. It is deliberately
   * not derived from the request: the day-range to cost-month rule is unapproved
   * (FC-P19) and `planTruckFixedCostSummaryPeriod` reports that blocker.
   */
  periodMonths: readonly string[];
  execute: FixedCostMonetaryExecutor;
  policy?: FixedCostDeletedRowPolicy;
}

const projectReconciliation = (group: FixedCostMonetaryGroup): TruckFixedCostSummaryReconciliation => ({
  status: group.reconciliationStatus,
  comparableRecords: group.comparableRecords,
  affectedRecords: group.affectedRecords,
  comparableAuthoritativeTotal: group.comparableAuthoritativeTotal,
  componentTotal: group.componentTotal,
  netDifference: group.netDifference,
  grossAbsoluteDifference: group.grossAbsoluteDifference,
  buckets: { ...group.buckets },
  noDetailRecords: group.noDetailRecords,
  multipleDetailRecords: group.multipleDetailRecords,
  missingTotalRecords: group.missingTotalRecords,
});

/**
 * Selects the single row-state group an approved policy designates.
 *
 * `exclude_deleted` designates the `deleted = 0` group, which needs no arithmetic.
 * `separate_by_state` cannot collapse to one amount at all, and `include_all` would
 * require adding decimal totals across states — which this layer will not do in
 * JavaScript. Both fail closed rather than producing an approximate figure.
 */
function selectGroup(result: FixedCostMonetaryResult, policy: FixedCostDeletedRowPolicy): FixedCostMonetaryGroup | null {
  if (policy.treatment === 'separate_by_state') {
    throw new TruckFixedCostSummaryUnavailable('deleted_state_collapse_unapproved', policy.reference);
  }
  if (policy.treatment === 'include_all') {
    const populated = result.groups.filter(group => group.authoritativeRecords > 0);
    if (populated.length > 1) {
      // Summing decimal totals across states in JavaScript would break decimal safety.
      throw new TruckFixedCostSummaryUnavailable('cross_state_addition_unavailable', policy.reference);
    }
    return populated[0] ?? null;
  }
  return result.groups.find(group => group.deletedState === 'zero') ?? null;
}

function assertConsistentResult(result: FixedCostMonetaryResult, representation: FixedCostRepresentation, periodMonth: string): void {
  if (result.meta.representation !== representation) {
    throw new InvalidFixedCostMonetaryResult('Representation mismatch between request and repository result');
  }
  if (result.meta.periodMonth !== periodMonth) {
    throw new InvalidFixedCostMonetaryResult('Period mismatch between request and repository result');
  }
  if (result.meta.allocationScope !== 'truck' || result.meta.currency !== 'EUR' || result.meta.dateBasis !== 'kastai_data') {
    throw new InvalidFixedCostMonetaryResult('Unexpected repository scope, currency or date basis');
  }
  if (result.meta.authoritativeSource !== fixedCostAuthoritativeSource
    || result.meta.breakdownSource !== fixedCostBreakdownSources[representation]) {
    throw new InvalidFixedCostMonetaryResult('Repository source does not match the requested representation');
  }
  if (result.meta.truncated !== false || result.meta.complete !== true) {
    throw new TruckFixedCostSummaryUnavailable('incomplete_population', 'FC-P17');
  }
}

/**
 * Builds a truck summary from independent current and locked reads.
 *
 * Fails closed before any executor call unless an approved deleted-row policy is
 * injected. Nothing is logged: no amount, task ID, truck ID, date or business row
 * leaves this module.
 */
export async function summarizeTruckFixedCosts(input: TruckFixedCostSummaryInput): Promise<TruckFixedCostSummaryResponse> {
  const { request, periodMonths, execute } = input;
  const policy = input.policy ?? unapprovedFixedCostDeletedRowPolicy;
  // The policy gate runs before the executor is touched.
  assertApprovedDeletedRowPolicy(policy);

  if (periodMonths.length === 0) throw new TruckFixedCostSummaryUnavailable('month_mapping_unapproved', 'FC-P19');
  if (periodMonths.length > 1) {
    // Adding month totals would require decimal arithmetic in JavaScript.
    throw new TruckFixedCostSummaryUnavailable('multi_month_aggregation_unavailable', 'FC-P19');
  }
  // Each month must be canonical and must overlap the echoed request range, so a
  // response can never describe one period while reporting another period's money.
  assertSummaryPeriodMonths(periodMonths, request);
  const [periodMonth] = periodMonths;

  // Two independent reads. Neither result is reused for the other representation.
  const results = {} as Record<FixedCostRepresentation, FixedCostMonetaryResult>;
  for (const representation of fixedCostRepresentations) {
    const result = await execute({ allocationScope: 'truck', representation, periodMonth });
    assertConsistentResult(result, representation, periodMonth);
    results[representation] = result;
  }

  const groups = {} as Record<FixedCostRepresentation, FixedCostMonetaryGroup | null>;
  for (const representation of fixedCostRepresentations) {
    groups[representation] = selectGroup(results[representation], policy);
  }
  const current = groups.current;
  const locked = groups.locked;

  // Both representations describe the same task population, so their record and
  // lock-state counts must agree. A disagreement means the two reads are not
  // comparable and no single task count can honestly be reported.
  const counts = fixedCostRepresentations.map(representation => {
    const group = groups[representation];
    return {
      total: group?.authoritativeRecords ?? 0,
      locked: group?.lockedRecords ?? 0,
      unlocked: group?.unlockedRecords ?? 0,
      unknown: group?.unknownLockRecords ?? 0,
      missingTask: group?.missingTaskCount ?? 0,
    };
  });
  const [currentCounts, lockedCounts] = counts;
  for (const key of ['total', 'locked', 'unlocked', 'unknown', 'missingTask'] as const) {
    if (currentCounts[key] !== lockedCounts[key]) {
      throw new InvalidFixedCostMonetaryResult('Current and locked reads describe different task populations');
    }
  }
  if (currentCounts.locked + currentCounts.unlocked + currentCounts.unknown !== currentCounts.total) {
    throw new InvalidFixedCostMonetaryResult('Lock-state counts do not cover the task population');
  }

  const limitations = orderFixedCostLimitations([
    ...truckFixedCostSummaryLimitations,
    ...(currentCounts.missingTask > 0
      ? ['Some summary records have no matching uzdaviniai task; they remain in the authoritative population and are counted by missingTaskCount.']
      : []),
    ...(policy.treatment === 'exclude_deleted'
      ? ['Records with a non-zero deleted flag are excluded under the injected policy; that inclusion rule is still unapproved.']
      : []),
  ]);

  return {
    data: {
      allocationScope: 'truck',
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      currency: 'EUR',
      // Stored authoritative totals, copied as decimal text. No JavaScript arithmetic.
      currentAmount: current?.authoritativeTotal ?? null,
      lockedAmount: locked?.authoritativeTotal ?? null,
      totalTaskCount: currentCounts.total,
      lockedTaskCount: currentCounts.locked,
      unlockedTaskCount: currentCounts.unlocked,
      unknownLockStateTaskCount: currentCounts.unknown,
      reconciliation: {
        current: current ? projectReconciliation(current) : absentReconciliation(),
        locked: locked ? projectReconciliation(locked) : absentReconciliation(),
      },
    },
    meta: {
      sourceFamily: 'fixed_cost_truck_allocation',
      authoritativeSource: fixedCostAuthoritativeSource,
      breakdownSources: fixedCostBreakdownSources,
      amountSemantics: 'stored_task_level_authoritative_total',
      dateBasis: 'kastai_data',
      semanticsVersion: null,
      classificationApplied: false,
      classificationVersion: null,
      reconciliationStatus: 'unreconciled',
      representation: {
        mode: 'current_and_locked_reported_separately',
        current: fixedCostBreakdownSources.current,
        locked: fixedCostBreakdownSources.locked,
      },
      periodMonths: Object.freeze([periodMonth]),
      complete: true,
      missingTaskCount: currentCounts.missingTask,
      deletedRowPolicy: policy,
      pendingApprovals: truckFixedCostSummaryPendingApprovals,
      limitations,
    },
  };
}

/** An absent group is reported as structurally non-comparable, never as zero. */
function absentReconciliation(): TruckFixedCostSummaryReconciliation {
  return {
    status: 'structurally_non_comparable',
    comparableRecords: 0,
    affectedRecords: 0,
    comparableAuthoritativeTotal: null,
    componentTotal: null,
    netDifference: null,
    grossAbsoluteDifference: null,
    buckets: { exact: 0, rounding: 0, small: 0, moderate: 0, material: 0, large: 0 },
    noDetailRecords: 0,
    multipleDetailRecords: 0,
    missingTotalRecords: 0,
  };
}
