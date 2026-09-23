import { fixedCostSemanticCapabilities } from './capabilities.js';
import {
  assertApprovedDeletedRowPolicy, assertDecimalString, fixedCostAuthoritativeSource,
  fixedCostBreakdownSources, InvalidFixedCostMonetaryResult, unapprovedFixedCostDeletedRowPolicy,
  type DecimalString, type FixedCostDeletedRowPolicy, type FixedCostRepresentation,
} from './monetary-contract.js';
import {
  fixedCostBreakdownMaxGroups, fixedCostBreakdownSortAvailability, fixedCostBreakdownTieBreaker,
  fixedCostComponentInventory, fixedCostGroupingAvailability, isGroupingAvailable,
  truckFixedCostBreakdownLimitations, truckFixedCostBreakdownPendingApprovals,
  TruckFixedCostBreakdownUnavailable,
  type TruckFixedCostBreakdownGroup, type TruckFixedCostBreakdownRequest,
  type TruckFixedCostBreakdownResponse, type TruckFixedCostBreakdownUnresolved,
} from './breakdown-contract.js';
import { assertSummaryPeriodMonths, orderFixedCostLimitations } from './summary-contract.js';

/**
 * Slice 7A — internal truck breakdown orchestration.
 *
 * Validates, bounds, orders and paginates grouped results behind an injected
 * executor. No production SQL is added: a truck grouping would still need the
 * month-filtered summary scan that FC-P17 leaves unresolved, so the executor stays
 * an injection point and the grouped statement belongs to Slice 7B.
 *
 * Nothing here is publicly reachable. Capability and policy gates run before the
 * executor is touched, and no amount, identifier, date or row is ever logged.
 */

/** One grouped read for a single representation, as the future repository will answer. */
export interface TruckBreakdownGroupRow {
  /** Verified master identifier, or null when the truck could not be resolved. */
  truckId: number | null;
  authoritativeTotal: DecimalString | null;
  taskCount: number;
  lockedRecords: number;
  unlockedRecords: number;
  unknownLockRecords: number;
  missingTaskCount: number;
  zeroTruckCount: number;
  reconciliation: TruckFixedCostBreakdownGroup['reconciliation']['current'];
}

export interface TruckBreakdownExecutorResult {
  representation: FixedCostRepresentation;
  periodMonth: string;
  rows: readonly TruckBreakdownGroupRow[];
  /** The executor must prove it enumerated every group before pagination. */
  complete: boolean;
  truncated: boolean;
  /**
   * Distinct groups the executor returned. It must equal `rows.length`: a count
   * that disagrees means the executor cannot prove it enumerated every group, and
   * the result is refused rather than paginated over an unproven population.
   */
  groupCount: number;
}

export type TruckBreakdownExecutor = (input: {
  allocationScope: 'truck';
  representation: FixedCostRepresentation;
  periodMonth: string;
  truckIds?: readonly number[];
}) => Promise<TruckBreakdownExecutorResult>;

export interface TruckFixedCostBreakdownInput {
  request: TruckFixedCostBreakdownRequest;
  /** Cost months from an internal caller; FC-P19 still blocks deriving them. */
  periodMonths: readonly string[];
  execute: TruckBreakdownExecutor;
  policy?: FixedCostDeletedRowPolicy;
  /**
   * Capability registry, defaulting to the real one. Injected only so the
   * orchestration below can be exercised; every entry in the real registry is
   * disabled, so the default path always refuses before any executor call.
   */
  capabilities?: Record<string, { enabled: boolean }>;
}

const decimalOrNull = (value: DecimalString | null, field: string): DecimalString | null =>
  value === null ? null : assertDecimalString(value, field);

/** Immutable integer ordering only. Monetary columns are never compared here. */
function orderGroups(
  rows: readonly TruckBreakdownGroupRow[],
  direction: 'asc' | 'desc',
): TruckBreakdownGroupRow[] {
  return [...rows].sort((left, right) => {
    const a = left.truckId ?? Number.MAX_SAFE_INTEGER;
    const b = right.truckId ?? Number.MAX_SAFE_INTEGER;
    // The tie-breaker is the sort key itself, so the order is already total.
    const primary = a === b ? 0 : a < b ? -1 : 1;
    return direction === 'desc' ? -primary : primary;
  });
}

function assertExecutorResult(
  result: TruckBreakdownExecutorResult,
  representation: FixedCostRepresentation,
  periodMonth: string,
): void {
  if (result.representation !== representation) {
    throw new InvalidFixedCostMonetaryResult('Representation mismatch between request and breakdown result');
  }
  if (result.periodMonth !== periodMonth) {
    throw new InvalidFixedCostMonetaryResult('Period mismatch between request and breakdown result');
  }
  // A partial aggregation is never presented as complete.
  if (result.truncated || !result.complete) {
    throw new TruckFixedCostBreakdownUnavailable('incomplete_grouping', ['FC-P17']);
  }
  if (result.groupCount !== result.rows.length) {
    throw new InvalidFixedCostMonetaryResult('Breakdown group count disagrees with the returned rows');
  }
  if (result.groupCount > fixedCostBreakdownMaxGroups) {
    throw new TruckFixedCostBreakdownUnavailable('group_count_exceeded', ['FC-P17']);
  }
  const identifiers = result.rows.map(row => row.truckId);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new InvalidFixedCostMonetaryResult('Breakdown returned duplicate groups');
  }
  for (const row of result.rows) {
    if (row.truckId !== null && (!Number.isSafeInteger(row.truckId) || row.truckId <= 0)) {
      throw new InvalidFixedCostMonetaryResult('Breakdown group carries an invalid truck identifier');
    }
    if (row.lockedRecords + row.unlockedRecords + row.unknownLockRecords !== row.taskCount) {
      throw new InvalidFixedCostMonetaryResult('Lock states do not cover the group task count');
    }
    decimalOrNull(row.authoritativeTotal, 'authoritativeTotal');
    // Reconciliation money is decimal text too. Without this a JavaScript number
    // would pass straight through into the response.
    for (const field of ['componentTotal', 'netDifference', 'grossAbsoluteDifference'] as const) {
      decimalOrNull(row.reconciliation[field], `reconciliation.${field}`);
    }
    // A resolved truck comes from uzdaviniai.uzdavinio_masina, so its task row
    // exists by construction. A resolved group claiming missing tasks would lose
    // that population silently, because only the unresolved bucket reports it.
    if (row.truckId !== null && row.missingTaskCount !== 0) {
      throw new InvalidFixedCostMonetaryResult('A resolved truck group cannot carry missing-task records');
    }
    // An empty comparable population never reports a zero difference.
    if (row.reconciliation.comparableRecords === 0) {
      for (const field of ['componentTotal', 'netDifference', 'grossAbsoluteDifference'] as const) {
        if (row.reconciliation[field] !== null) {
          throw new InvalidFixedCostMonetaryResult(`${field} must be null without comparable records`);
        }
      }
      if (row.reconciliation.status !== 'structurally_non_comparable') {
        throw new InvalidFixedCostMonetaryResult('A group without comparable records must be structurally non-comparable');
      }
    }
  }
}

/**
 * Builds a bounded, deterministically ordered truck breakdown.
 *
 * Gates first, then two independent reads, then invariant checks, then ordering
 * and pagination. Authoritative totals are copied from the stored total; component
 * sums never stand in for them, and no detail table is joined here, so a
 * one-to-many detail relationship cannot multiply a task total.
 */
export async function buildTruckFixedCostBreakdown(
  input: TruckFixedCostBreakdownInput,
): Promise<TruckFixedCostBreakdownResponse> {
  const { request, periodMonths, execute } = input;
  const policy = input.policy ?? unapprovedFixedCostDeletedRowPolicy;
  const capabilities = input.capabilities ?? fixedCostSemanticCapabilities;

  // 1. Capability gate. Every real registry entry is disabled, so this refuses.
  if (!capabilities[request.allocationScope]?.enabled) {
    throw new TruckFixedCostBreakdownUnavailable('grouping_not_activated', [
      ...fixedCostGroupingAvailability.truck.blockers,
    ]);
  }
  // 2. Policy gate, before any executor call.
  assertApprovedDeletedRowPolicy(policy);

  // 3. Grouping availability. A blocked grouping never proceeds silently.
  const availability = fixedCostGroupingAvailability[request.groupBy];
  if (availability.status === 'blocked') {
    throw new TruckFixedCostBreakdownUnavailable('grouping_blocked', availability.blockers);
  }
  if (!isGroupingAvailable(request.groupBy)) {
    throw new TruckFixedCostBreakdownUnavailable('grouping_not_activated', availability.blockers);
  }
  // 4. Monetary ordering needs SQL; money is never sorted in JavaScript.
  if (!fixedCostBreakdownSortAvailability[request.sortBy]) {
    throw new TruckFixedCostBreakdownUnavailable('sort_field_unavailable', ['FC-P17']);
  }

  assertSummaryPeriodMonths(periodMonths, { allocationScope: 'truck', dateFrom: request.dateFrom, dateTo: request.dateTo });
  if (periodMonths.length !== 1) {
    throw new TruckFixedCostBreakdownUnavailable('incomplete_grouping', ['FC-P19']);
  }
  const [periodMonth] = periodMonths;

  const results = {} as Record<FixedCostRepresentation, TruckBreakdownExecutorResult>;
  for (const representation of ['current', 'locked'] as const) {
    const result = await execute({
      allocationScope: 'truck', representation, periodMonth,
      ...(request.truckIds === undefined ? {} : { truckIds: request.truckIds }),
    });
    assertExecutorResult(result, representation, periodMonth);
    results[representation] = result;
  }

  // Both representations describe the same task population and the same groups.
  const currentRows = new Map(results.current.rows.map(row => [row.truckId, row]));
  const lockedRows = new Map(results.locked.rows.map(row => [row.truckId, row]));
  if (currentRows.size !== lockedRows.size) {
    throw new InvalidFixedCostMonetaryResult('Current and locked breakdowns describe different group sets');
  }
  for (const [truckId, current] of currentRows) {
    const locked = lockedRows.get(truckId);
    if (!locked) throw new InvalidFixedCostMonetaryResult('Current and locked breakdowns describe different group sets');
    for (const key of ['taskCount', 'lockedRecords', 'unlockedRecords', 'unknownLockRecords', 'missingTaskCount'] as const) {
      if (current[key] !== locked[key]) {
        throw new InvalidFixedCostMonetaryResult('Current and locked breakdowns describe different task populations');
      }
    }
  }

  const resolved = orderGroups(results.current.rows.filter(row => row.truckId !== null), request.sortDirection);
  const unresolvedRow = results.current.rows.find(row => row.truckId === null) ?? null;
  const unresolvedLocked = results.locked.rows.find(row => row.truckId === null) ?? null;

  const groupCount = resolved.length;
  const pageCount = groupCount === 0 ? 0 : Math.ceil(groupCount / request.perPage);
  if (groupCount > 0 && request.page > pageCount) {
    throw new TruckFixedCostBreakdownUnavailable('page_out_of_range', []);
  }
  const offset = (request.page - 1) * request.perPage;
  const pageRows = resolved.slice(offset, offset + request.perPage);

  const groups: TruckFixedCostBreakdownGroup[] = pageRows.map(row => {
    const locked = lockedRows.get(row.truckId)!;
    return {
      truckId: row.truckId as number,
      // Stored authoritative totals, copied as text. No arithmetic, no component sum.
      currentAmount: row.authoritativeTotal,
      lockedAmount: locked.authoritativeTotal,
      taskCount: row.taskCount,
      lockStates: { locked: row.lockedRecords, unlocked: row.unlockedRecords, unknown: row.unknownLockRecords },
      reconciliation: { current: row.reconciliation, locked: locked.reconciliation },
    };
  });

  const unresolved: TruckFixedCostBreakdownUnresolved | null = unresolvedRow === null ? null : {
    reason: 'truck_unresolved',
    taskCount: unresolvedRow.taskCount,
    missingTaskCount: unresolvedRow.missingTaskCount,
    zeroTruckCount: unresolvedRow.zeroTruckCount,
    currentAmount: unresolvedRow.authoritativeTotal,
    lockedAmount: unresolvedLocked?.authoritativeTotal ?? null,
  };

  const limitations = orderFixedCostLimitations([
    ...truckFixedCostBreakdownLimitations,
    ...(unresolved ? ['Some records could not be resolved to a truck; they are reported separately and carry no truck identifier.'] : []),
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
      groups: Object.freeze(groups),
      unresolved,
    },
    meta: {
      sourceFamily: 'fixed_cost_truck_allocation',
      authoritativeSource: fixedCostAuthoritativeSource,
      breakdownSources: fixedCostBreakdownSources,
      amountSemantics: 'stored_task_level_authoritative_total',
      dateBasis: 'kastai_data',
      semanticsVersion: null,
      classificationVersion: null,
      classificationApplied: false,
      reconciliationStatus: 'unreconciled',
      groupBy: request.groupBy,
      groupingAvailability: fixedCostGroupingAvailability,
      componentInventory: fixedCostComponentInventory,
      pagination: {
        page: request.page,
        perPage: request.perPage,
        groupCount,
        pageCount,
        maxGroups: fixedCostBreakdownMaxGroups,
      },
      sorting: {
        sortBy: request.sortBy,
        sortDirection: request.sortDirection,
        tieBreaker: fixedCostBreakdownTieBreaker,
      },
      periodMonths: Object.freeze([periodMonth]),
      complete: true,
      deletedRowPolicy: policy,
      pendingApprovals: truckFixedCostBreakdownPendingApprovals,
      limitations,
    },
  };
}
