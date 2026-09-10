import { buildApp } from './app.js';
import { ConfigurationError, loadConfig } from './config.js';
import { checkReplicaConnectivity } from './db/replica.js';

async function start() {
  const config = loadConfig();
  const app = buildApp(config);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch {
      app.log.error('Application shutdown failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await checkReplicaConnectivity(app.replica);
    if (!closing) await app.listen({ host: '0.0.0.0', port: config.port });
  } catch {
    app.log.error('Application startup failed; check replica connectivity and server configuration');
    process.exitCode = 1;
    await shutdown();
  }
}

start().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError ? error.message : 'Application initialization failed');
  process.exitCode = 1;
});
