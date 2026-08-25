import type { FastifyInstance } from "fastify";

import { orders } from "../data/mock-data.js";
import type { Order } from "../domain/order.js";

interface OrderQuery {
  customerId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function registerOrderRoutes(app: FastifyInstance) {
  app.get<{ Querystring: OrderQuery }>("/api/orders", async (request) => {
    const { customerId, status, dateFrom, dateTo } = request.query;

    return Object.values(orders)
      .filter((order): order is Order => order !== undefined)
      .filter((order) => {
        const createdDate = order.createdAt.slice(0, 10);

        return (!customerId || order.customerId === customerId)
          && (!status || order.status === status)
          && (!dateFrom || createdDate >= dateFrom)
          && (!dateTo || createdDate <= dateTo);
      });
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
    const order = orders[request.params.id];
    if (!order) return reply.code(404).send({ error: "Order not found" });
    return order;
  });
}
