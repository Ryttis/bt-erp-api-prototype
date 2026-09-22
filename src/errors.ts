export type ApiErrorCode = 'UNAUTHORIZED' | 'INVALID_QUERY' | 'CATEGORY_LIMIT_EXCEEDED' | 'CURRENCY_SCOPE_REQUIRED' | 'SEMANTICS_UNVERIFIED' | 'REPLICA_UNAVAILABLE' | 'QUERY_TIMEOUT' | 'SERVICE_BUSY';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'ApiError';
  }
}

export const apiErrorBody = (error: ApiError) => ({ error: { code: error.code, message: error.publicMessage } });

// Codes cover MariaDB statement limits, driver socket/query timeouts and server interrupts.
export function isQueryTimeout(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as Record<string, unknown>;
    const code = String(value.code ?? '');
    const errno = value.errno;
    if (code.includes('TIMEOUT') || code === 'ER_QUERY_INTERRUPTED' || errno === 1969 || errno === 3024 || errno === 45026) return true;
    current = value.cause;
  }
  return false;
}
