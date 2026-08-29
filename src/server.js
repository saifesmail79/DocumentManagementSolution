/**
 * HTTP entry point.
 *
 * Boot order is deliberate: configuration is validated on import (src/config
 * throws before anything else runs), then the database is checked, and only then
 * does the port open. A process that is listening but cannot reach SQL Server
 * looks healthy to a load balancer and fails every request — better to refuse to
 * start and say why.
 *
 * Feature routes live in src/modules/ and register here as plugins as they land.
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';

import { config } from './config/index.js';
import { logger, moduleLogger } from './lib/logger.js';
import { verifyConnection, checkFullTextSearch, closeDatabase } from './db/index.js';

const log = moduleLogger('server');

const app = Fastify({
  // Reuse the application pino instance so request logs carry the same redaction
  // rules — DB_PASSWORD and cookie headers must never reach a log file.
  loggerInstance: logger,
  // Trust the reverse proxy in front of this in production so req.ip is the real
  // client rather than the proxy, which the audit trail depends on.
  trustProxy: config.isProduction,
  bodyLimit: config.storage.maxUploadBytes,
});

await app.register(cors, {
  origin: config.server.corsOrigins,
  credentials: true,
});

/**
 * Liveness and readiness in one. Returns 503 when the database is unreachable so
 * an orchestrator restarts the process instead of routing traffic to it.
 */
app.get('/health', async (_request, reply) => {
  try {
    const info = await verifyConnection();
    return { status: 'ok', database: info };
  } catch (error) {
    log.error({ err: error }, 'health check failed');
    return reply.code(503).send({ status: 'unavailable', reason: 'database unreachable' });
  }
});

async function start() {
  // Fail loudly here rather than on the first user request.
  await verifyConnection();
  await checkFullTextSearch();

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
    await app.close();
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
