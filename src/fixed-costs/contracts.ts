export const fixedCostAllocationScopes = ['truck', 'trailer', 'department', 'support', 'expedition'] as const;
export type FixedCostAllocationScope = typeof fixedCostAllocationScopes[number];

export const fixedCostMaximumDateRangeDays = 366;

export interface FixedCostRequest {
  allocationScope: FixedCostAllocationScope;
  dateFrom?: string;
  dateTo?: string;
  /** Canonical ERP truck ID (`uzdaviniai.uzdavinio_masina`); summary endpoint only. */
  truckId?: number;
  /** Canonical ERP trailer ID (`uzdaviniai.uzdavinio_priekaba`); trailer scope only. */
  trailerId?: number;
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
 * dimensions, sorting, measures, or field selection yet. Their mappings are
 * financial semantics, not generic caller-selected columns. The only filters are an
 * optional single `truckId` and a single `trailerId`, admitted only where the caller
 * allows them. `trailerId` is valid only with `allocationScope=trailer` and never
 * together with `truckId`, so one request can never name both populations.
 */
export function parseFixedCostRequest(
  input: Record<string, unknown>, options: { allowTruckId?: boolean; allowTrailerId?: boolean } = {},
): FixedCostRequest {
  const parameters = new Set([
    'allocationScope', 'dateFrom', 'dateTo',
    ...(options.allowTruckId === true ? ['truckId'] : []), ...(options.allowTrailerId === true ? ['trailerId'] : []),
  ]);
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

  // Canonical decimal digits only: no sign, leading zero, whitespace, exponent or fraction.
  const identifier = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new InvalidFixedCostQuery();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new InvalidFixedCostQuery();
    return parsed;
  };
  const truckId = identifier(input.truckId);
  const trailerId = identifier(input.trailerId);
  if (trailerId !== undefined && (allocationScope !== 'trailer' || truckId !== undefined)) throw new InvalidFixedCostQuery();

  return {
    allocationScope: allocationScope as FixedCostAllocationScope,
    ...(dateFrom === undefined ? {} : { dateFrom, dateTo: dateTo! }),
    ...(truckId === undefined ? {} : { truckId }),
    ...(trailerId === undefined ? {} : { trailerId }),
  };
}
