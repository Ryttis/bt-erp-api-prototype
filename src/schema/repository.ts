import type { ReplicaPool } from '../db/replica.js';
import { queryReadOnly } from '../db/replica.js';

export const schemaTablePageLimit = 100;
export const schemaSearchLimit = 100;
const detailLimit = 500;
const detailQueryLimit = detailLimit + 1;

type Row = Record<string, unknown>;

const number = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
// Defaults are schema metadata, but an arbitrary string default could itself be
// a credential. Expose only non-sensitive structural defaults.
function safeDefault(value: unknown): { value: string | number | null; redacted: boolean } {
  if (value === null || value === undefined) return { value: null, redacted: false };
  const candidate = String(value).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(candidate)) return { value: Number(candidate), redacted: false };
  if (/^(CURRENT_TIMESTAMP(?:\(\))?|NULL)$/i.test(candidate)) return { value: candidate.toUpperCase(), redacted: false };
  return { value: null, redacted: true };
}

export async function listSchemaTables(pool: ReplicaPool, database: string, page: number, perPage: number) {
  const countRows = await queryReadOnly<Row[]>(pool, 'SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?', [database]);
  const rows = await queryReadOnly<Row[]>(pool, `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS
    FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME ASC LIMIT ? OFFSET ?`, [database, perPage, (page - 1) * perPage]);
  return {
    data: rows.map((row) => ({ name: String(row.TABLE_NAME), type: String(row.TABLE_TYPE), approximate_row_count: number(row.TABLE_ROWS) })),
    meta: { page, per_page: perPage, total: number(countRows[0]?.total), complete: page * perPage >= number(countRows[0]?.total) },
  };
}

/** Escapes LIKE metacharacters; the SQL itself remains static and parameterized. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export async function searchSchema(pool: ReplicaPool, database: string, term: string) {
  const pattern = `%${escapeLike(term)}%`;
  const rows = await queryReadOnly<Row[]>(pool, `SELECT t.TABLE_NAME, t.TABLE_TYPE, t.TABLE_ROWS, c.COLUMN_NAME
    FROM INFORMATION_SCHEMA.TABLES t
    LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      AND c.COLUMN_NAME LIKE ? ESCAPE '\\\\'
    WHERE t.TABLE_SCHEMA = ?
      AND (t.TABLE_NAME LIKE ? ESCAPE '\\\\' OR c.COLUMN_NAME IS NOT NULL)
    ORDER BY t.TABLE_NAME ASC, c.ORDINAL_POSITION ASC
    LIMIT ?`, [pattern, database, pattern, schemaSearchLimit + 1]);
  const tables = new Map<string, { name: string; type: string; approximate_row_count: number; matching_columns: string[] }>();
  for (const row of rows) {
    const name = String(row.TABLE_NAME);
    const item = tables.get(name) ?? { name, type: String(row.TABLE_TYPE), approximate_row_count: number(row.TABLE_ROWS), matching_columns: [] };
    const column = text(row.COLUMN_NAME);
    if (column && column.toLocaleLowerCase().includes(term.toLocaleLowerCase()) && item.matching_columns.length < detailLimit) item.matching_columns.push(column);
    tables.set(name, item);
  }
  const data = [...tables.values()].slice(0, schemaSearchLimit);
  return { data, meta: { query: term, result_count: data.length, limit: schemaSearchLimit, complete: rows.length <= schemaSearchLimit } };
}

export async function getSchemaTable(pool: ReplicaPool, database: string, table: string) {
  const tableRows = await queryReadOnly<Row[]>(pool, `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS
    FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`, [database, table]);
  const base = tableRows[0];
  if (!base) return undefined;
  const [columns, indexes, foreignKeys] = await Promise.all([
    queryReadOnly<Row[]>(pool, `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, ORDINAL_POSITION
      FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION ASC LIMIT ?`, [database, table, detailQueryLimit]),
    queryReadOnly<Row[]>(pool, `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
      FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC LIMIT ?`, [database, table, detailQueryLimit]),
    queryReadOnly<Row[]>(pool, `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME ASC, ORDINAL_POSITION ASC LIMIT ?`, [database, table, detailQueryLimit]),
  ]);
  const columnsComplete = columns.length <= detailLimit;
  const indexesComplete = indexes.length <= detailLimit;
  const foreignKeysComplete = foreignKeys.length <= detailLimit;
  const boundedColumns = columns.slice(0, detailLimit);
  const boundedIndexes = indexes.slice(0, detailLimit);
  const boundedForeignKeys = foreignKeys.slice(0, detailLimit);
  const indexMap = new Map<string, { name: string; unique: boolean; columns: string[] }>();
  for (const row of boundedIndexes) {
    const name = String(row.INDEX_NAME);
    const index = indexMap.get(name) ?? { name, unique: Number(row.NON_UNIQUE) === 0, columns: [] };
    index.columns.push(String(row.COLUMN_NAME)); indexMap.set(name, index);
  }
  const foreignKeyMap = new Map<string, { name: string; columns: string[]; referenced_table: string; referenced_columns: string[] }>();
  for (const row of boundedForeignKeys) {
    const name = String(row.CONSTRAINT_NAME);
    const key = foreignKeyMap.get(name) ?? { name, columns: [], referenced_table: String(row.REFERENCED_TABLE_NAME), referenced_columns: [] };
    key.columns.push(String(row.COLUMN_NAME)); key.referenced_columns.push(String(row.REFERENCED_COLUMN_NAME)); foreignKeyMap.set(name, key);
  }
  return {
    data: {
      name: String(base.TABLE_NAME), type: String(base.TABLE_TYPE), approximate_row_count: number(base.TABLE_ROWS),
      columns: boundedColumns.map((row) => {
        const defaultMetadata = safeDefault(row.COLUMN_DEFAULT);
        return { name: String(row.COLUMN_NAME), data_type: String(row.DATA_TYPE), column_type: String(row.COLUMN_TYPE), nullable: row.IS_NULLABLE === 'YES', default: defaultMetadata.value, default_redacted: defaultMetadata.redacted, primary_key: row.COLUMN_KEY === 'PRI', auto_increment: String(row.EXTRA ?? '').toLowerCase().includes('auto_increment') };
      }),
      indexes: [...indexMap.values()], foreign_keys: [...foreignKeyMap.values()],
    },
    meta: { columns_complete: columnsComplete, indexes_complete: indexesComplete, foreign_keys_complete: foreignKeysComplete },
  };
}
