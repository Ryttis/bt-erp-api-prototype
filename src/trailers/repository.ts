import { queryReadOnly, type ReplicaPool } from '../db/replica.js';

// Verified from schema metadata: infot_2.priekabos.id is the primary key and
// priekabos.masinos_nr is the indexed trailer registration/number column.
export const trailerFields = {
  id: { sql: 't.id', kind: 'id' },
  registration_number: { sql: 't.masinos_nr', kind: 'text' },
} as const;

export type TrailerField = keyof typeof trailerFields;
export const allTrailerFields = Object.keys(trailerFields) as TrailerField[];
export const defaultTrailerFields: TrailerField[] = ['id', 'registration_number'];

export interface TrailerQuery {
  registration_number?: string;
  registration_numbers?: string[];
  fields?: TrailerField[];
  page: number;
  per_page: number;
}

function canonicalTrailer(row: Record<string, unknown>, fields: TrailerField[]) {
  const output: Partial<{ id: number; registration_number: string | null }> = {};
  for (const key of fields) {
    const value = row[key];
    if (key === 'id') {
      const id = Number(value);
      if (!Number.isSafeInteger(id)) throw new Error('Invalid trailer ID');
      output.id = id;
    } else {
      output.registration_number = value === null || value === undefined ? null : String(value);
    }
  }
  return output;
}

const substring = (value: string) => `%${value.replace(/[!%_]/g, '!$&')}%`;

function trailerFilters(query: TrailerQuery) {
  const conditions: string[] = [];
  const values: string[] = [];
  if (query.registration_number !== undefined) {
    conditions.push("LOWER(t.masinos_nr) LIKE LOWER(?) ESCAPE '!'");
    values.push(substring(query.registration_number));
  }
  if (query.registration_numbers !== undefined) {
    conditions.push(`t.masinos_nr IN (${query.registration_numbers.map(() => '?').join(', ')})`);
    values.push(...query.registration_numbers);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export async function listTrailers(pool: ReplicaPool, query: TrailerQuery) {
  const { where, values } = trailerFilters(query);
  const fields = query.fields ?? defaultTrailerFields;
  if (!fields.length || fields.length > allTrailerFields.length || fields.some((key) => !Object.hasOwn(trailerFields, key))) throw new Error('Invalid trailer projection');
  const counts = await queryReadOnly<{ total: unknown }[]>(pool,
    `SELECT COUNT(*) AS total FROM infot_2.priekabos t ${where}`, values);
  const total = Number(counts[0]?.total);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid trailer count');
  const rows = await queryReadOnly<Record<string, unknown>[]>(pool,
    `SELECT ${fields.map((key) => `${trailerFields[key].sql} AS \`${key}\``).join(', ')}
      FROM infot_2.priekabos t ${where}
      ORDER BY t.masinos_nr IS NULL ASC, t.masinos_nr ASC, t.id ASC
      LIMIT ? OFFSET ?`, [...values, query.per_page, (query.page - 1) * query.per_page]);
  return {
    data: rows.map((row) => canonicalTrailer(row, fields)),
    meta: {
      page: query.page, per_page: query.per_page, total, last_page: Math.ceil(total / query.per_page),
      sort: { field: 'registration_number', direction: 'asc' as const },
    },
  };
}
