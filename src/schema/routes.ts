import type { FastifyInstance } from 'fastify';
import { ApiError, apiErrorBody, isQueryTimeout } from '../errors.js';
import { safeDriverDiagnostics } from '../db/replica.js';
import { getSchemaTable, listSchemaTables, schemaTablePageLimit, searchSchema } from './repository.js';

class InvalidSchemaQuery extends Error {}

function integer(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new InvalidSchemaQuery();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new InvalidSchemaQuery();
  return result;
}

function schemaFailure(app: FastifyInstance, error: unknown, requestId: string, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }) {
  if (error instanceof ApiError) return reply.code(error.statusCode).send(apiErrorBody(error));
  if (isQueryTimeout(error)) return reply.code(504).send(apiErrorBody(new ApiError(504, 'QUERY_TIMEOUT', 'Schema query timed out')));
  app.log.warn({ request_id: requestId, endpoint: '/schema', diagnostics: safeDriverDiagnostics(error) }, 'Schema database request failed');
  return reply.code(503).send(apiErrorBody(new ApiError(503, 'REPLICA_UNAVAILABLE', 'Schema metadata temporarily unavailable')));
}

export async function registerSchemaRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, unknown> }>('/schema/tables', async (request, reply) => {
    try {
      if (Object.keys(request.query).some((key) => key !== 'page' && key !== 'per_page')) throw new InvalidSchemaQuery();
      const page = integer(request.query.page, 1, Number.MAX_SAFE_INTEGER);
      const perPage = integer(request.query.per_page, 50, schemaTablePageLimit);
      if (!Number.isSafeInteger((page - 1) * perPage)) throw new InvalidSchemaQuery();
      return await app.analyticsGate.run(() => listSchemaTables(app.replica, app.schemaDatabase, page, perPage));
    } catch (error) {
      if (error instanceof InvalidSchemaQuery) return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid schema query')));
      return schemaFailure(app, error, request.id, reply);
    }
  });
  app.get<{ Querystring: Record<string, unknown> }>('/schema/search', async (request, reply) => {
    try {
      if (Object.keys(request.query).length !== 1 || typeof request.query.q !== 'string') throw new InvalidSchemaQuery();
      const query = request.query.q.trim();
      if (!query || query.length > 100) throw new InvalidSchemaQuery();
      return await app.analyticsGate.run(() => searchSchema(app.replica, app.schemaDatabase, query));
    } catch (error) {
      if (error instanceof InvalidSchemaQuery) return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid schema query')));
      return schemaFailure(app, error, request.id, reply);
    }
  });
  app.get<{ Params: { table: string } }>('/schema/tables/:table', async (request, reply) => {
    try {
      // This validation only bounds input. The first parameterized TABLES lookup
      // remains the authority for whether a caller may request details.
      if (!request.params.table || request.params.table.length > 128) throw new InvalidSchemaQuery();
      const result = await app.analyticsGate.run(() => getSchemaTable(app.replica, app.schemaDatabase, request.params.table));
      if (!result) return reply.code(404).send(apiErrorBody(new ApiError(404, 'INVALID_QUERY', 'Schema table not found')));
      return result;
    } catch (error) {
      if (error instanceof InvalidSchemaQuery) return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid schema query')));
      return schemaFailure(app, error, request.id, reply);
    }
  });
}
