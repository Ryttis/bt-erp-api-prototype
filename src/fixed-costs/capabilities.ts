import type { FixedCostAllocationScope } from './contracts.js';

export interface FixedCostSemanticCapability {
  enabled: boolean;
  status: 'unverified';
}

/**
 * A recognized allocation scope is not a monetary capability. Each entry must
 * remain disabled until source, amount, currency, date, lock/status, and
 * reconciliation rules are approved together.
 */
export const fixedCostSemanticCapabilities: Record<FixedCostAllocationScope, FixedCostSemanticCapability> = {
  truck: { enabled: false, status: 'unverified' },
  trailer: { enabled: false, status: 'unverified' },
  department: { enabled: false, status: 'unverified' },
  support: { enabled: false, status: 'unverified' },
  expedition: { enabled: false, status: 'unverified' },
};
