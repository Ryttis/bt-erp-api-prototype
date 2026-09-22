export const fixedCostAllocationScopes = ['truck', 'trailer', 'department', 'support', 'expedition'] as const;
export type FixedCostAllocationScope = typeof fixedCostAllocationScopes[number];

export const fixedCostMaximumDateRangeDays = 366;

export interface FixedCostRequest {
  allocationScope: FixedCostAllocationScope;
  dateFrom?: string;
  dateTo?: string;
}

export interface FixedCostCurrencyScope {
  mode: 'single' | 'grouped' | 'converted';
  value?: string;
  conversionVersion?: string;
}

/** Metadata required on a future successful fixed-cost response.
 *
 * This is a contract only. No values are emitted until the source and
 * monetary semantics are approved for a scope.
 */
export interface FixedCostResponseMetadata {
  allocationScope: FixedCostAllocationScope;
  sourceFamily: string;
  amountSemantics: string;
  currencyScope: FixedCostCurrencyScope;
  dateBasis: string;
  valueSelection: string;
  classificationVersion: string | number;
  semanticsVersion: string;
  reconciliationStatus: string;
  complete: boolean;
  limitations: string[];
}

export interface FixedCostResponse<TData> {
  data: TData;
  meta: FixedCostResponseMetadata;
}

export class InvalidFixedCostQuery extends Error {}

const isIsoDate = (value: string) => {
  const match = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-3][0-9])$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const dateRangeDays = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/**
 * Fixed-cost monetary requests deliberately expose no pagination, grouping,
 * dimensions, sorting, filters, measures, or field selection yet. Their
 * mappings are financial semantics, not generic caller-selected columns.
 */
export function parseFixedCostRequest(input: Record<string, unknown>): FixedCostRequest {
  const parameters = new Set(['allocationScope', 'dateFrom', 'dateTo']);
  for (const [key, value] of Object.entries(input)) {
    if (!parameters.has(key) || typeof value !== 'string') throw new InvalidFixedCostQuery();
  }

  const allocationScope = input.allocationScope;
  if (typeof allocationScope !== 'string' || !(fixedCostAllocationScopes as readonly string[]).includes(allocationScope)) {
    throw new InvalidFixedCostQuery();
  }

  const rawDateFrom = input.dateFrom;
  const rawDateTo = input.dateTo;
  if ((rawDateFrom === undefined) !== (rawDateTo === undefined)) throw new InvalidFixedCostQuery();
  if (rawDateFrom !== undefined && (typeof rawDateFrom !== 'string' || typeof rawDateTo !== 'string')) throw new InvalidFixedCostQuery();
  const dateFrom = rawDateFrom as string | undefined;
  const dateTo = rawDateTo as string | undefined;
  if (dateFrom !== undefined && (!isIsoDate(dateFrom) || !isIsoDate(dateTo!))) throw new InvalidFixedCostQuery();
  if (dateFrom !== undefined && (dateFrom > dateTo! || dateRangeDays(dateFrom, dateTo!) > fixedCostMaximumDateRangeDays)) {
    throw new InvalidFixedCostQuery();
  }

  return { allocationScope: allocationScope as FixedCostAllocationScope, ...(dateFrom === undefined ? {} : { dateFrom, dateTo: dateTo! }) };
}
