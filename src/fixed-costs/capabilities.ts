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
  | { enabled: true; mode: 'truck_summary_pilot' };

/**
 * Deterministic capability resolution from validated application configuration.
 *
 * Exactly one combination can resolve as enabled: the truck summary, and only when
 * the fail-closed Slice 6P pilot flag is strictly `true`. Breakdown, dimensions and
 * every other scope stay disabled whatever the flag says. Request, model or query
 * input never reaches this function; only `AppConfig` does.
 */
export function resolveFixedCostCapability(
  endpoint: FixedCostEndpoint,
  scope: FixedCostAllocationScope,
  config: AppConfig['fixedCosts'],
): FixedCostResolvedCapability {
  if (endpoint === 'summary' && scope === 'truck' && config.truckSummaryPilotEnabled === true) {
    return { enabled: true, mode: 'truck_summary_pilot' };
  }
  return { enabled: false };
}
