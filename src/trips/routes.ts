import type { FastifyInstance } from "fastify";

import { trips } from "../data/mock-data.js";

export async function registerTripRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/trips/:id", async (request, reply) => {
    const trip = trips[request.params.id as keyof typeof trips];
    if (!trip) return reply.code(404).send({ error: "Trip not found" });
    return trip;
  });
}
