import type { FastifyInstance } from "fastify";

import { invoices } from "../data/mock-data.js";

export async function registerInvoiceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tripId?: string } }>("/api/invoices", async (request) => {
    return invoices.filter(i => !request.query.tripId || i.tripId === request.query.tripId);
  });
}
