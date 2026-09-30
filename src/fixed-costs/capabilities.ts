import type { AppConfig } from '../config.js';
import type { FixedCostAllocationScope } from './contracts.js';

export interface FixedCostSemanticCapability {
  enabled: boolean;
  status: 'unverified';
}

/**
 * A recognized allocation scope is not a monetary capability. Each entry must
 * remain disabled until source, amount, currency, date, lock/status, and
 * reconciliation rules are approved together.
 *
 * Deeply frozen: the Slice 6P pilot is resolved per request from validated
 * configuration by `resolveFixedCostCapability`, never by editing this registry.
 */
export const fixedCostSemanticCapabilities: Readonly<Record<FixedCostAllocationScope, Readonly<FixedCostSemanticCapability>>> = Object.freeze({
  truck: Object.freeze({ enabled: false, status: 'unverified' }),
  trailer: Object.freeze({ enabled: false, status: 'unverified' }),
  department: Object.freeze({ enabled: false, status: 'unverified' }),
  support: Object.freeze({ enabled: false, status: 'unverified' }),
  expedition: Object.freeze({ enabled: false, status: 'unverified' }),
});

export const fixedCostEndpoints = ['summary', 'breakdown', 'dimensions'] as const;
export type FixedCostEndpoint = typeof fixedCostEndpoints[number];

export type FixedCostResolvedCapability =
  | { enabled: false }
  | { enabled: true; mode: 'truck_summary_pilot' | 'truck_breakdown_pilot' | 'trailer_summary_pilot' | 'trailer_breakdown_pilot' };

/**
 * Deterministic capability resolution from validated application configuration.
 *
 * Only two combinations can resolve as enabled, and only when the fail-closed pilot
 * flag is strictly `true`: the truck summary, and the truck breakdown for exactly one
 * validated `truckId`. Fleet-wide breakdown, dimensions and every other scope stay
 * disabled whatever the flag says. Beyond the parsed truck selector, request, model
 * or query input never reaches this function.
 *
 * The trailer scope has its own fail-closed flag and resolves only for exactly one
 * validated `trailerId`, on the summary and the breakdown. There is no fleet-wide
 * trailer capability, and neither flag can enable the other scope.
 */
export function resolveFixedCostCapability(
  endpoint: FixedCostEndpoint,
  scope: FixedCostAllocationScope,
  config: AppConfig['fixedCosts'],
  selection: { truckId?: number; trailerId?: number } = {},
): FixedCostResolvedCapability {
  if (scope === 'trailer') {
    if (config.trailerPilotEnabled !== true || selection.trailerId === undefined || selection.truckId !== undefined) return { enabled: false };
    if (endpoint === 'summary') return { enabled: true, mode: 'trailer_summary_pilot' };
    if (endpoint === 'breakdown') return { enabled: true, mode: 'trailer_breakdown_pilot' };
    return { enabled: false };
  }
  if (scope !== 'truck' || config.truckSummaryPilotEnabled !== true) return { enabled: false };
  if (endpoint === 'summary') return { enabled: true, mode: 'truck_summary_pilot' };
  if (endpoint === 'breakdown' && selection.truckId !== undefined) return { enabled: true, mode: 'truck_breakdown_pilot' };
  return { enabled: false };
}
