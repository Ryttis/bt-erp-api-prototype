import Fastify from 'fastify';
import { registerVehicleRoutes } from './vehicles/routes.js';
import type { AppConfig } from './config.js';
import { createReplicaPool, type ReplicaPool } from './db/replica.js';
import { AnalyticsGate } from './analytics-gate.js';
import { ApiError, apiErrorBody } from './errors.js';
import { registerCustomerRoutes } from './customers/routes.js';
import { registerDocumentRoutes } from './documents/routes.js';
import { registerInvoiceRoutes } from './invoices/routes.js';
import { registerBillingInvoiceRoutes } from './billing-invoices/routes.js';
import { registerOrderRoutes } from './orders/routes.js';
import { registerTripRoutes } from './trips/routes.js';
import { isAuthorizedServiceRequest } from './auth.js';
import { registerSchemaRoutes } from './schema/routes.js';
import { registerFixedCostRoutes } from './fixed-costs/routes.js';
import { registerTrailerRoutes } from './trailers/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    replica: ReplicaPool;
    analyticsGate: AnalyticsGate;
    vehicleSafety: AppConfig['safety'];
    schemaDatabase: string;
  }
}

/** The optional override exists solely for isolated route tests; server startup always uses authentication. */
export function buildApp(config: AppConfig, poolFactory = createReplicaPool, options: { authenticate?: boolean } = {}) {
  // Fastify's default request log includes the full URL, which may contain
  // plate lists or free-text lookup filters. Endpoint telemetry supplies safe metadata.
  const app = Fastify({
    logger: { redact: { paths: ['req.url', 'req.headers.authorization'], remove: true } },
    routerOptions: { maxParamLength: 200 },
    bodyLimit: 1024,
  });
  const pool = poolFactory(config.replica, config.safety.queryTimeoutMs);
  app.decorate('replica', pool);
  app.decorate('analyticsGate', new AnalyticsGate(config.safety.analyticsConcurrency, config.safety.analyticsQueueLimit, config.safety.analyticsQueueTimeoutMs));
  app.decorate('vehicleSafety', config.safety);
  app.decorate('schemaDatabase', config.replica.database);
  app.addHook('onRequest', async (request, reply) => {
    if (request.raw.url && request.raw.url.length > config.safety.maxRequestUrlLength) {
      return reply.code(400).send(apiErrorBody(new ApiError(400, 'INVALID_QUERY', 'Invalid vehicle query')));
    }
  });
  app.addHook('onRequest', async (request, reply) => {
    // Health is intentionally the only unauthenticated endpoint: it reveals no
    // configuration, dependency, build, or replica state and is suitable for a local probe.
    if (request.url.split('?', 1)[0] === '/health') return;
    if (options.authenticate !== false && !isAuthorizedServiceRequest(request.headers.authorization, config.auth.serviceToken)) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send(apiErrorBody(new ApiError(401, 'UNAUTHORIZED', 'Authentication required')));
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  app.addHook('onClose', async () => { await pool.end(); });
  app.get('/health', async () => ({ status: 'ok' }));
  app.register(registerVehicleRoutes);
  app.register(registerTrailerRoutes);
  app.register(registerBillingInvoiceRoutes);
  app.register(registerTripRoutes);
  app.register(registerOrderRoutes);
  app.register(registerCustomerRoutes);
  app.register(registerInvoiceRoutes);
  app.register(registerDocumentRoutes);
  app.register(registerSchemaRoutes);
  // Only the validated configuration reaches the fixed-cost capability resolver.
  app.register(registerFixedCostRoutes, { fixedCosts: config.fixedCosts });
  return app;
}
