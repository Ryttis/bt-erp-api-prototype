import mariadb, { type Pool } from 'mariadb';
import type { ReplicaConfig } from '../config.js';

// Narrow injectable interface; each app owns its pool, with no global DB state.
export type ReplicaPool = Pick<Pool, 'query' | 'end'>;

/** Repository queries are an allowlisted read-only boundary in addition to DB grants. */
export async function queryReadOnly<T>(pool: ReplicaPool, sql: string, values?: unknown[]): Promise<T> {
  if (!/^\s*(SELECT|SHOW|EXPLAIN)\b/i.test(sql)) throw new Error('Replica operation is not read-only');
  return pool.query<T>(sql, values);
}

export function createReplicaPool(config: ReplicaConfig, queryTimeoutMs = 30000): ReplicaPool {
  return mariadb.createPool({
    ...config,
    minimumIdle: 0,
    connectTimeout: 5000,
    acquireTimeout: 10000,
    idleTimeout: 60,
    queryTimeout: queryTimeoutMs,
  });
}

interface SafeDriverDiagnostic {
  name?: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  fatal?: boolean;
  message?: string;
}

// Copy only diagnostic metadata, never raw errors, stacks, SQL, or connection data.
// Pool acquisition failures wrap the actual connection error in `cause`.
export function safeDriverDiagnostics(error: unknown): SafeDriverDiagnostic[] {
  const diagnostics: SafeDriverDiagnostic[] = [];
  const seen = new Set<object>();
  while (error && typeof error === 'object' && !seen.has(error) && diagnostics.length < 5) {
    seen.add(error);
    const source = error as Record<string, unknown>;
    const safe: SafeDriverDiagnostic = {};
    if (typeof source.name === 'string' && ['Error', 'SqlError', 'TypeError', 'AggregateError'].includes(source.name)) safe.name = source.name;
    if (typeof source.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(source.code)) safe.code = source.code;
    if (typeof source.errno === 'number' && Number.isSafeInteger(source.errno)) safe.errno = source.errno;
    if (typeof source.sqlState === 'string' && /^[A-Z0-9]{5}$/.test(source.sqlState)) safe.sqlState = source.sqlState;
    if (typeof source.fatal === 'boolean') safe.fatal = source.fatal;
    // Exact allowlist: arbitrary driver messages can embed accounts, hosts or SQL.
    if (typeof source.message === 'string' && [
      'self-signed certificate',
      'certificate has expired',
      'unable to verify the first certificate',
      'unable to get local issuer certificate',
      'connect ETIMEDOUT',
      'connect ECONNREFUSED',
    ].includes(source.message)) safe.message = source.message;
    diagnostics.push(safe);
    error = source.cause;
  }
  return diagnostics;
}

export class ReplicaDiagnosticError extends Error {
  readonly diagnostics: SafeDriverDiagnostic[];

  constructor(operation: string, error: unknown) {
    const diagnostics = safeDriverDiagnostics(error);
    super(`${operation}: ${JSON.stringify(diagnostics)}`);
    this.name = 'ReplicaDiagnosticError';
    this.diagnostics = diagnostics;
  }
}

export async function checkReplicaConnectivity(pool: ReplicaPool): Promise<void> {
  try {
    await pool.query('SELECT VERSION() AS version, CURRENT_USER() AS currentUser, DATABASE() AS databaseName');
  } catch (error) {
    throw new ReplicaDiagnosticError('Replica connectivity check failed', error);
  }
}

export async function readReplicaGrants(pool: ReplicaPool): Promise<string[]> {
  try {
    const rows = await pool.query('SHOW GRANTS FOR CURRENT_USER()');
    return rows.map((row: Record<string, unknown>) => String(Object.values(row)[0]));
  } catch (error) {
    throw new ReplicaDiagnosticError('Replica grant inspection failed', error);
  }
}

// Conservative verification: roles, broader scopes and unknown grant formats fail
// verification rather than being assumed read-only. Never return grants publicly.
export function hasSelectOnlyInfot2Grants(grants: string[]): boolean {
  let hasSelect = false;
  for (const grant of grants) {
    const match = /^GRANT (.+?) ON (.+?) TO /i.exec(grant);
    if (!match || /WITH GRANT OPTION/i.test(grant)) return false;
    const [, privileges, scope] = match;
    if (privileges.toUpperCase() === 'USAGE' && scope === '*.*') continue;
    if (privileges.toUpperCase() !== 'SELECT' || scope !== '`infot_2`.*') return false;
    hasSelect = true;
  }
  return hasSelect;
}
