import type { FastifyInstance } from "fastify";

import { invoices } from "../data/mock-data.js";

interface InvoiceQuery {
  tripId?: string;
  orderId?: string;
  customerId?: string;
  type?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function registerInvoiceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: InvoiceQuery }>("/api/invoices", async (request) => {
    const { tripId, orderId, customerId, type, status, dateFrom, dateTo } = request.query;

    return invoices.filter((invoice) => (!tripId || invoice.tripId === tripId)
      && (!orderId || invoice.orderId === orderId)
      && (!customerId || invoice.customerId === customerId)
      && (!type || invoice.type === type)
      && (!status || invoice.status === status)
      && (!dateFrom || invoice.issueDate >= dateFrom)
      && (!dateTo || invoice.issueDate <= dateTo));
  });
}
