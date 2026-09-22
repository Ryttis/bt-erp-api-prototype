export const fixedCostDiagnosticTaskLimit = 20;
export const fixedCostDiagnosticDetailLimit = 100;

export interface FixedCostDiagnosticInput { taskIds: number[]; }

export class InvalidFixedCostDiagnosticInput extends Error {
  constructor() {
    super('Expected between 1 and 20 distinct positive safe integer task IDs');
    this.name = 'InvalidFixedCostDiagnosticInput';
  }
}

/** Separate from the public monetary request contract. Copy before any await. */
export function parseFixedCostDiagnosticInput(input: unknown): FixedCostDiagnosticInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new InvalidFixedCostDiagnosticInput();
  }
  const keys = Reflect.ownKeys(input);
  const property = Object.getOwnPropertyDescriptor(input, 'taskIds');
  if (keys.length !== 1 || keys[0] !== 'taskIds' || !property || !('value' in property)) {
    throw new InvalidFixedCostDiagnosticInput();
  }
  const values: unknown = property.value;
  if (!Array.isArray(values) || values.length < 1 || values.length > fixedCostDiagnosticTaskLimit) {
    throw new InvalidFixedCostDiagnosticInput();
  }
  const taskIds: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || taskIds.includes(value)) {
      throw new InvalidFixedCostDiagnosticInput();
    }
    taskIds.push(value);
  }
  return { taskIds };
}

/** Canonical comma-separated decimal integers only; no whitespace or coercion. */
export function parseFixedCostDiagnosticTaskIds(value: unknown): FixedCostDiagnosticInput {
  if (typeof value !== 'string' || value.length > 339
    || !/^[1-9][0-9]{0,15}(?:,[1-9][0-9]{0,15}){0,19}$/.test(value)) {
    throw new InvalidFixedCostDiagnosticInput();
  }
  return parseFixedCostDiagnosticInput({ taskIds: value.split(',').map(Number) });
}

const comparison = ['both_missing', 'left_missing', 'right_missing', 'equal', 'different'] as const;
// Sign classes only: no magnitude ranges, tolerances or business meaning.
const valueClass = ['missing', 'negative', 'zero', 'positive'] as const;
const dateState = ['missing', 'zero_date', 'valid_date', 'other'] as const;
// Relative to the summary date columns; neither date is treated as authoritative.
const detailDate = ['no_details', 'unclassified', 'summary_date_unusable', 'detail_date_unusable', 'all_equal', 'none_equal', 'mixed'] as const;
export const fixedCostDiagnosticCategories = {
  task: ['present', 'missing'],
  summary: ['present', 'missing'],
  // PRIMARY(uzdavinys) structurally excludes multiple summary rows.
  summaryCardinality: ['zero', 'one'],
  truckTotals: comparison,
  currentLocked: comparison,
  assignedTruck: ['missing', 'zero', 'populated_with_master', 'populated_without_master'],
  details: ['present', 'missing'],
  detailCardinality: ['zero', 'one', 'multiple', 'over_limit'],
  // Slice 3A: characterize the observed differences without selecting a value.
  taskLockedTotals: comparison,
  taskTruckValue: valueClass,
  summaryCurrentValue: valueClass,
  summaryLockedValue: valueClass,
  // Raw tinyint(1) flag state; the meaning of `deleted` is unapproved.
  summaryDeletedFlag: ['missing', 'zero', 'one', 'other'],
  summaryCurrentDate: dateState,
  summaryLockedDate: dateState,
  currentLockedDate: ['both_missing', 'left_missing', 'right_missing', 'equal', 'current_before_locked', 'current_after_locked', 'unclassified'],
  detailCurrentDate: detailDate,
  detailLockedDate: detailDate,
} as const;

export type FixedCostDiagnosticCategories = {
  [K in keyof typeof fixedCostDiagnosticCategories]: typeof fixedCostDiagnosticCategories[K][number];
};
export interface FixedCostDiagnosticResult {
  data: (FixedCostDiagnosticCategories & { inputPosition: number })[];
  meta: { sampleSize: number; complete: boolean };
}
