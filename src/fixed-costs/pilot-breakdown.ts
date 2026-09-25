import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import { fixedCostBreakdownDefaultPageSize, type TruckFixedCostBreakdownResponse } from './breakdown-contract.js';
import { buildTruckFixedCostBreakdown, type TruckBreakdownExecutor } from './breakdown-service.js';
import { fixedCostMonetaryMaxRecords } from './monetary-contract.js';
import { queryFixedCostMonetaryTotals } from './monetary-repository.js';
import {
  pilotIncludedGroup, resolveTruckFixedCostPilotMonth, truckFixedCostPilotDeletedRowPolicy,
} from './pilot-summary.js';
import type { TruckFixedCostSummaryRequest } from './summary-contract.js';

/**
 * Single-truck breakdown pilot (MP-8), behind the same fail-closed pilot flag.
 *
 * Only `allocationScope=truck` with one `truckId` and one settled complete month.
 * The response is the unchanged Slice 7A breakdown contract with exactly one truck
 * group. Pilot decision recorded here: unlike the summary pilot, this reads the
 * current representation too, because the 7A shape reports current and locked
 * separately. They are never added or substituted for each other.
 *
 * Both reads reuse the existing repository with its bound truck allowlist
 * (`t.uzdavinio_masina IN (?)`) and apply the summary pilot's population rules, so
 * absent data, unlocked tasks and incomplete reads refuse exactly as the summary does.
 * Per-component amounts are not exposed: component additivity is unapproved (FC-06/FC-07).
 */
export async function runTruckFixedCostPilotBreakdown(
  pool: ReplicaPool,
  gate: AnalyticsGate,
  request: TruckFixedCostSummaryRequest & { truckId: number },
  now: Date = new Date(),
): Promise<TruckFixedCostBreakdownResponse> {
  // Period rules run before any gate or replica access.
  const periodMonth = resolveTruckFixedCostPilotMonth(request, now);
  const { truckId } = request;

  const execute: TruckBreakdownExecutor = async ({ representation }) => {
    const result = await queryFixedCostMonetaryTotals(pool, gate, {
      allocationScope: 'truck', representation, periodMonth, limit: fixedCostMonetaryMaxRecords, truckIds: [truckId],
    }, truckFixedCostPilotDeletedRowPolicy, now);
    const group = pilotIncludedGroup(result, representation, periodMonth, truckId);
    return {
      representation, periodMonth, complete: result.meta.complete, truncated: result.meta.truncated, groupCount: 1,
      rows: [{
        truckId,
        authoritativeTotal: group.authoritativeTotal,
        taskCount: group.authoritativeRecords,
        lockedRecords: group.lockedRecords,
        unlockedRecords: group.unlockedRecords,
        unknownLockRecords: group.unknownLockRecords,
        missingTaskCount: group.missingTaskCount,
        zeroTruckCount: 0,
        reconciliation: {
          status: group.reconciliationStatus,
          comparableRecords: group.comparableRecords,
          affectedRecords: group.affectedRecords,
          componentTotal: group.componentTotal,
          netDifference: group.netDifference,
          grossAbsoluteDifference: group.grossAbsoluteDifference,
          buckets: group.buckets,
          noDetailRecords: group.noDetailRecords,
          multipleDetailRecords: group.multipleDetailRecords,
        },
      }],
    };
  };

  return buildTruckFixedCostBreakdown({
    request: {
      allocationScope: 'truck', dateFrom: request.dateFrom, dateTo: request.dateTo, groupBy: 'truck',
      page: 1, perPage: fixedCostBreakdownDefaultPageSize, sortBy: 'truckId', sortDirection: 'asc', truckIds: [truckId],
    },
    periodMonths: [periodMonth],
    execute,
    policy: truckFixedCostPilotDeletedRowPolicy,
    // The pilot enables this one path explicitly; the shared registry stays all-disabled.
    capabilities: { truck: { enabled: true } },
  });
}
