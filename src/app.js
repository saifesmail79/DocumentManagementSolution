/**
 * Builds the Fastify instance.
 *
 * Kept separate from server.js so tests can exercise real routes through
 * app.inject() without opening a port or running the boot checks. Importing
 * server.js would start listening as a side effect, which makes it unusable from
 * a test file.
 *
 * Feature routes register here as they land.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';

import { config } from './config/index.js';
import { logger, moduleLogger } from './lib/logger.js';
import { verifyConnection } from './db/index.js';
import { registerAuth } from './modules/auth/routes.js';

const log = moduleLogger('server');

/**
 * @param {{logger?: boolean}} [options]
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({ logger: withLogger = true } = {}) {
  const app = Fastify({
    // Reuse the application pino instance so request logs carry the same
    // redaction rules — DB_PASSWORD and cookie headers must never reach a log
    // file. Tests pass false to keep their output readable.
    ...(withLogger ? { loggerInstance: logger } : { logger: false }),
    // Trust the reverse proxy in front of this in production so req.ip is the
    // real client rather than the proxy, which the audit trail depends on.
    trustProxy: config.isProduction,
    bodyLimit: config.storage.maxUploadBytes,
  });

  await app.register(cors, {
    origin: config.server.corsOrigins,
    credentials: true,
  });

  // Cookies must be registered before registerAuth: its onRequest hook reads
  // request.cookies, and Fastify runs hooks in registration order.
  await app.register(cookie);

  // Called with the root instance on purpose — see the note in modules/auth/routes.js.
  registerAuth(app);

  /**
   * Liveness and readiness in one. Returns 503 when the database is unreachable
   * so an orchestrator restarts the process instead of routing traffic to it.
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

  await app.ready();
  return app;
}
