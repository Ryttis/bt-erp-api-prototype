import type { FastifyInstance } from "fastify";

import { customers } from "../data/mock-data.js";

export async function registerCustomerRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/customers/:id", async (request, reply) => {
    const customer = customers[request.params.id];
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    return customer;
  });
}
