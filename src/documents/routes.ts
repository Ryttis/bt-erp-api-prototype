import type { FastifyInstance } from "fastify";

import { documents } from "../data/mock-data.js";

interface DocumentQuery {
  tripId?: string;
  orderId?: string;
  type?: string;
  validationStatus?: string;
}

export async function registerDocumentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: DocumentQuery }>("/api/documents", async (request) => {
    const { tripId, orderId, type, validationStatus } = request.query;

    return documents.filter((document) => (!tripId || document.tripId === tripId)
      && (!orderId || document.orderId === orderId)
      && (!type || document.type === type)
      && (!validationStatus || document.validationStatus === validationStatus));
  });
}
