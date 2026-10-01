import type { FastifyInstance } from 'fastify';
import { ApiError, apiErrorBody, isQueryTimeout } from '../errors.js';
import { safeDriverDiagnostics } from '../db/replica.js';
import { allTrailerFields, trailerFields, type TrailerField, type TrailerQuery, listTrailers } from './repository.js';

const parameters = new Set(['registration_number', 'registration_numbers', 'page', 'per_page', 'fields']);
class InvalidTrailerQuery extends Error {}

function parseQuery(input: Record<string, unknown>): TrailerQuery {
  for (const [key, value] of Object.entries(input)) {
    if (!parameters.has(key) || typeof value !== 'string') throw new InvalidTrailerQuery();
  }
  const integer = (key: 'page' | 'per_page', fallback: number, max: number) => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value as string)) throw new InvalidTrailerQuery();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new InvalidTrailerQuery();
    return result;
  };
  const page = integer('page', 1, Number.MAX_SAFE_INTEGER);
  const per_page = integer('per_page', 50, 200);
  if (!Number.isSafeInteger((page - 1) * per_page)) throw new InvalidTrailerQuery();
  // Trailer registrations are identifiers, not arbitrary search expressions.
  // This also rejects SQL punctuation while permitting customary letters, digits,
  // spaces, dots, and hyphens.
  const registration = (key: 'registration_number' | 'registration_numbers') => {
    const value = input[key];
    if (value === undefined) return undefined;
    const normalized = (value as string).trim();
    if (!normalized || normalized.length > 50 || !/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u.test(normalized)) throw new InvalidTrailerQuery();
    return normalized;
  };
  const registration_number = registration('registration_number');
  const registrations = input.registration_numbers === undefined ? undefined : (input.registration_numbers as string).split(',').map((value) => value.trim());
  if (registrations && (registrations.length > 100 || registrations.some((value) => !value || value.length > 50 || !/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u.test(value)))) throw new InvalidTrailerQuery();
  let fields: TrailerField[] | undefined;
  if (input.fields !== undefined) {
    const requested = (input.fields as string).split(',').map((key) => key.trim());
    if (!requested.length || requested.length > allTrailerFields.length || requested.some((key) => !Object.hasOwn(trailerFields, key))) throw new InvalidTrailerQuery();
    fields = [...new Set(requested)] as TrailerField[];
  }
  return { registration_number, registration_numbers: registrations, fields, page, per_page };
}

export async function registerTrailerRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, unknown> }>('/trailers', async (request, reply) => {
    let query: TrailerQuery;
    try { query = parseQuery(request.query); } catch {
      return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid trailer query')));
    }
    try {
      return await listTrailers(app.replica, query);
    } catch (error) {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(apiErrorBody(error));
      if (isQueryTimeout(error)) return reply.code(504).send(apiErrorBody(new ApiError(504, 'QUERY_TIMEOUT', 'Trailer query timed out')));
      request.log.warn({ request_id: request.id, endpoint: '/trailers', diagnostics: safeDriverDiagnostics(error) }, 'Trailer database request failed');
      return reply.code(503).send(apiErrorBody(new ApiError(503, 'REPLICA_UNAVAILABLE', 'Trailer data temporarily unavailable')));
    }
  });
}
