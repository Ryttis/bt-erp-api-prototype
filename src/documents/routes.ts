import type { FastifyInstance } from "fastify";

import { documents } from "../data/mock-data.js";

export async function registerDocumentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tripId?: string } }>("/api/documents", async (request) => {
    return documents.filter(d => !request.query.tripId || d.tripId === request.query.tripId);
  });
}
