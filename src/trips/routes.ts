import type { FastifyInstance } from "fastify";

import { trips } from "../data/mock-data.js";
import type { Trip } from "../domain/trip.js";

interface TripQuery {
  carrierId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function registerTripRoutes(app: FastifyInstance) {
  app.get<{ Querystring: TripQuery }>("/api/trips", async (request) => {
    const { carrierId, status, dateFrom, dateTo } = request.query;

    return Object.values(trips)
      .filter((trip): trip is Trip => trip !== undefined)
      .filter((trip) => {
        const loadingDate = trip.loading.plannedAt.slice(0, 10);

        return (!carrierId || trip.carrierId === carrierId)
          && (!status || trip.status === status)
          && (!dateFrom || loadingDate >= dateFrom)
          && (!dateTo || loadingDate <= dateTo);
      });
  });

  app.get<{ Params: { id: string } }>("/api/trips/:id", async (request, reply) => {
    const trip = trips[request.params.id];
    if (!trip) return reply.code(404).send({ error: "Trip not found" });
    return trip;
  });
}
