import type { AnalyticsGate } from '../analytics-gate.js';
import type { ReplicaPool } from '../db/replica.js';
import { InvalidFixedCostQuery, parseFixedCostRequest } from './contracts.js';
import { fixedCostMonetaryMaxRecords } from './monetary-contract.js';
import {
  pilotIncludedStateGroup, resolveTruckFixedCostPilotMonth, TruckFixedCostPilotRefused,
  type FixedCostPilotPopulationCounts,
} from './pilot-summary.js';
import { trailerFixedCostPilotDeletedRowPolicy } from './pilot-trailer.js';
import { parseFixedCostReconciliationMonth } from './reconciliation-contract.js';
import { queryTrailerAvailablePeriods } from './trailer-available-periods-repository.js';

/**
 * Single-trailer available-period discovery (MP-8), behind the trailer pilot flag
 * `ERP_FIXED_COST_TRAILER_PILOT_ENABLED`.
 *
 * A month is listed exactly when the single-trailer monthly summary for that month
 * would return data: it must pass the summary's own month resolver (complete and
 * settled), stay within the monthly read's record bound, and be accepted by the
 * same population rules (`pilotIncludedStateGroup`) over the same locked trailer
 * population. Months the summary would refuse — no included rows, deleted-only,
 * not fully locked, undeclared row state, missing stored total — are simply absent.
 * Nothing is probed month by month and nothing is guessed.
 */

export const trailerAvailablePeriodsSemanticsVersion = 'trailer-fixed-cost-available-periods-pilot-v1' as const;

/** Oldest accepted year. A sanity bound on input, not a statement about ERP history. */
export const trailerAvailablePeriodsMinYear = 2000;

export interface TrailerAvailablePeriodsRequest {
  allocationScope: 'trailer';
  trailerId: number;
  year: number;
}

export interface TrailerAvailablePeriodsResponse {
  data: {
    allocationScope: 'trailer';
    trailerId: number;
    year: number;
    /** Unique `YYYY-MM` months, ascending. Empty when no month is available. */
    availableMonths: string[];
  };
  meta: {
    sourceFamily: 'trailer_fixed_costs';
    semanticsVersion: typeof trailerAvailablePeriodsSemanticsVersion;
    pilot: true;
  };
}

const parameters = new Set(['allocationScope', 'trailerId', 'year']);

/**
 * Exactly `allocationScope=trailer`, one canonical positive `trailerId` and one
 * `year` from `trailerAvailablePeriodsMinYear` to the current UTC year. Repeated
 * parameters arrive as arrays and are refused; any other parameter, including
 * `truckId` or a date range, is refused.
 */
export function parseTrailerAvailablePeriodsRequest(input: Record<string, unknown>, now: Date = new Date()): TrailerAvailablePeriodsRequest {
  for (const [key, value] of Object.entries(input)) {
    if (!parameters.has(key) || typeof value !== 'string') throw new InvalidFixedCostQuery();
  }
  // Scope and identifier rules are the summary contract's, unchanged.
  const parsed = parseFixedCostRequest({ allocationScope: input.allocationScope, trailerId: input.trailerId }, { allowTrailerId: true });
  if (parsed.allocationScope !== 'trailer' || parsed.trailerId === undefined) throw new InvalidFixedCostQuery();
  if (typeof input.year !== 'string' || !/^[1-9][0-9]{3}$/.test(input.year)) throw new InvalidFixedCostQuery();
  const year = Number(input.year);
  if (year < trailerAvailablePeriodsMinYear || year > now.getUTCFullYear()) throw new InvalidFixedCostQuery();
  return { allocationScope: 'trailer', trailerId: parsed.trailerId, year };
}

/** The year's months that the summary's own period resolver accepts, ascending. */
export function trailerAvailablePeriodCandidateMonths(year: number, now: Date = new Date()): string[] {
  const months: string[] = [];
  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const dateFrom = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10);
    const dateTo = new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);
    try {
      months.push(resolveTruckFixedCostPilotMonth({ dateFrom, dateTo }, now));
    } catch (error) {
      if (!(error instanceof TruckFixedCostPilotRefused)) throw error;
    }
  }
  return months;
}

/** Whether the monthly summary's population rules accept a month's groups. */
export function trailerPilotMonthEligible(groups: readonly FixedCostPilotPopulationCounts[], recordsRead: number): boolean {
  // The monthly read refuses a truncated period as INCOMPLETE_RESULT.
  if (recordsRead > fixedCostMonetaryMaxRecords) return false;
  try {
    pilotIncludedStateGroup(groups);
    return true;
  } catch (error) {
    if (error instanceof TruckFixedCostPilotRefused) return false;
    throw error;
  }
}

/** One gated read for the whole year; no read at all when the year has no settled month. */
export async function runTrailerAvailablePeriods(
  pool: ReplicaPool, gate: AnalyticsGate, request: TrailerAvailablePeriodsRequest, now: Date = new Date(),
): Promise<TrailerAvailablePeriodsResponse> {
  const months = trailerAvailablePeriodCandidateMonths(request.year, now);
  const available = months.length === 0 ? [] : (await queryTrailerAvailablePeriods(pool, gate, {
    trailerId: request.trailerId,
    months,
    periodEnd: parseFixedCostReconciliationMonth(months[months.length - 1], now).monthEnd,
  }, trailerFixedCostPilotDeletedRowPolicy)).filter(month => trailerPilotMonthEligible(month.groups, month.recordsRead));
  return {
    data: {
      allocationScope: 'trailer',
      trailerId: request.trailerId,
      year: request.year,
      availableMonths: [...new Set(available.map(({ month }) => month.slice(0, 7)))].sort(),
    },
    meta: {
      sourceFamily: 'trailer_fixed_costs',
      semanticsVersion: trailerAvailablePeriodsSemanticsVersion,
      pilot: true,
    },
  };
}
