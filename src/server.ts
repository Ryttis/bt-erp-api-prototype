import Fastify from "fastify";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 3000);

const trips = {
  "313": {
    id: "313",
    number: "E101809996",
    orderId: "A4029709",
    carrierCustomerId: "carrier-1",
    status: "approved"
  }
};

const orders = {
  "A4029709": {
    id: "A4029709",
    number: "A4029709",
    customerId: "customer-1"
  }
};

const customers = {
  "carrier-1": { id: "carrier-1", name: "Carrier One", country: "LT" },
  "customer-1": { id: "customer-1", name: "Customer One", country: "LT" }
};

const invoices = [
  {
    id: "invoice-1",
    tripId: "313",
    number: "INV-001",
    amount: 1250.50,
    currency: "EUR",
    status: "open"
  }
];

const documents = [
  {
    id: "document-1",
    tripId: "313",
    type: "cmr",
    fileName: "cmr.pdf",
    validationStatus: "validated"
  }
];

app.get("/health", async () => ({ status: "ok" }));

app.get<{ Params: { id: string } }>("/api/trips/:id", async (request, reply) => {
  const trip = trips[request.params.id as keyof typeof trips];
  if (!trip) return reply.code(404).send({ error: "Trip not found" });
  return trip;
});

app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
  const order = orders[request.params.id as keyof typeof orders];
  if (!order) return reply.code(404).send({ error: "Order not found" });
  return order;
});

app.get<{ Params: { id: string } }>("/api/customers/:id", async (request, reply) => {
  const customer = customers[request.params.id as keyof typeof customers];
  if (!customer) return reply.code(404).send({ error: "Customer not found" });
  return customer;
});

app.get<{ Querystring: { tripId?: string } }>("/api/invoices", async (request) => {
  return invoices.filter(i => !request.query.tripId || i.tripId === request.query.tripId);
});

app.get<{ Querystring: { tripId?: string } }>("/api/documents", async (request) => {
  return documents.filter(d => !request.query.tripId || d.tripId === request.query.tripId);
});

await app.listen({ host: "0.0.0.0", port });
