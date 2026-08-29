/**
 * HTTP entry point.
 *
 * Boot order is deliberate: configuration is validated on import (src/config
 * throws before anything else runs), then the database is checked, and only then
 * does the port open. A process that is listening but cannot reach SQL Server
 * looks healthy to a load balancer and fails every request — better to refuse to
 * start and say why.
 *
 * The routes themselves live in app.js so tests can reach them without a port.
 */

import 'dotenv/config';

import { config } from './config/index.js';
import { moduleLogger } from './lib/logger.js';
import { verifyConnection, checkFullTextSearch, closeDatabase } from './db/index.js';
import { buildApp } from './app.js';

const log = moduleLogger('server');

let app;

async function start() {
  // Fail loudly here rather than on the first user request.
  await verifyConnection();
  await checkFullTextSearch();

  app = await buildApp();

  await app.listen({ host: config.server.host, port: config.server.port });
  log.info(
    { url: `http://localhost:${config.server.port}`, storageRoot: config.storage.root },
    'DMS API listening',
  );
}

/**
 * Close the listener before the pool. Draining in the other order lets an
 * in-flight request reach a destroyed pool and fail with a confusing error
 * instead of completing.
 */
async function shutdown(signal) {
  log.info({ signal }, 'shutting down');
  try {
    if (app) await app.close();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(signal));
}

try {
  await start();
} catch (error) {
  log.error({ err: error }, 'failed to start');
  await closeDatabase().catch(() => {});
  process.exit(1);
}
