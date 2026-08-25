import type { FastifyInstance } from "fastify";

import { customers } from "../data/mock-data.js";
import type { Customer } from "../domain/customer.js";

interface CustomerQuery {
  type?: string;
  countryCode?: string;
  status?: string;
}

export async function registerCustomerRoutes(app: FastifyInstance) {
  app.get<{ Querystring: CustomerQuery }>("/api/customers", async (request) => {
    const { type, countryCode, status } = request.query;

    return Object.values(customers)
      .filter((customer): customer is Customer => customer !== undefined)
      .filter((customer) => (!type || customer.type === type)
        && (!countryCode || customer.countryCode === countryCode)
        && (!status || customer.status === status));
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (request, reply) => {
    const customer = customers[request.params.id];
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    return customer;
  });
}
