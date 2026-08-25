import type { FastifyInstance } from "fastify";

import { orders } from "../data/mock-data.js";

export async function registerOrderRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
    const order = orders[request.params.id];
    if (!order) return reply.code(404).send({ error: "Order not found" });
    return order;
  });
}
