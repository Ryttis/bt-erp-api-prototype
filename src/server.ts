import Fastify from "fastify";

import { registerCustomerRoutes } from "./customers/routes.js";
import { registerDocumentRoutes } from "./documents/routes.js";
import { registerInvoiceRoutes } from "./invoices/routes.js";
import { registerOrderRoutes } from "./orders/routes.js";
import { registerTripRoutes } from "./trips/routes.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 3000);

app.get("/health", async () => ({ status: "ok" }));

await app.register(registerTripRoutes);
await app.register(registerOrderRoutes);
await app.register(registerCustomerRoutes);
await app.register(registerInvoiceRoutes);
await app.register(registerDocumentRoutes);

await app.listen({ host: "0.0.0.0", port });
