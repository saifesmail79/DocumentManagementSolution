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
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config/index.js';
import { logger, moduleLogger } from './lib/logger.js';
import { verifyConnection } from './db/index.js';
import { registerAuth } from './modules/auth/routes.js';
import { treeRoutes } from './modules/tree/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import {
  metadataRoutes,
  documentMetadataRoutes,
  folderDefaultsRoutes,
} from './modules/metadata/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { collaborationRoutes } from './modules/collaboration/routes.js';
import { integrationRoutes, shareRoutes } from './modules/integration/routes.js';
import { classificationRoutes, classificationAdminRoutes } from './modules/classification/routes.js';

const log = moduleLogger('server');

/**
 * @param {{logger?: boolean}} [options]
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
/** 4 GiB. See the multipart `fileSize` note below. */
const UPLOAD_HARD_CEILING = 4 * 1024 * 1024 * 1024;

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

  // Uploads stream to storage rather than buffering: a 200MB scan batch held in
  // memory is 200MB of heap per concurrent upload.
  //
  // `files` is the batch cap, not one: selecting several documents at once and
  // being asked whether they are one entry or many is the ordinary filing
  // action here. At files:1 the plugin silently stops yielding after the first
  // part, so a batch would have been truncated rather than refused — the
  // handler counts parts itself for exactly that reason.
  await app.register(multipart, {
    // One over the batch cap, deliberately: the plugin's own limit produces a
    // truncated request rather than a message anyone can read, so the extra slot
    // lets the handler's counter see the overflow and refuse it by name.
    limits: {
      /*
       * A hard ceiling, not the working limit.
       *
       * The working limit is the upload.max_bytes *setting*, enforced when each
       * upload is staged — this value is fixed when the process starts and
       * cannot follow the setting up or down. So it is set well above any
       * reasonable working limit and serves one purpose: an absolute bound on
       * what a single request may stream at the server, whatever the settings
       * table says or fails to say.
       */
      fileSize: UPLOAD_HARD_CEILING,
      files: config.storage.maxFilesPerUpload + 1,
    },
  });

  /**
   * Raw binary bodies, for resumable upload chunks.
   *
   * The parser hands the stream through untouched rather than buffering it: a
   * chunk can be several megabytes, and the point of chunked upload is to avoid
   * holding a whole file in memory. Without this Fastify refuses the request
   * with 415 before the handler ever runs.
   */
  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    done(null, payload);
  });

  // Called with the root instance on purpose — see the note in modules/auth/routes.js.
  registerAuth(app);

  await app.register(treeRoutes, { prefix: '/api/folders' });
  await app.register(documentRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api/search' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(metadataRoutes, { prefix: '/api/metadata' });
  await app.register(folderDefaultsRoutes, { prefix: '/api/folders' });
  await app.register(documentMetadataRoutes, { prefix: '/api/documents' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(collaborationRoutes, { prefix: '/api' });
  await app.register(integrationRoutes, { prefix: '/api' });

  // The recognition pilot. Both scopes answer "disabled" while its switch is
  // off, so registering them on a production install changes nothing there.
  await app.register(classificationRoutes, { prefix: '/api' });
  await app.register(classificationAdminRoutes, { prefix: '/api/admin/classification' });

  // Public: the one route that serves document bytes without a session. It
  // enforces its own expiry, password and download cap.
  await app.register(shareRoutes, { prefix: '/api/share' });

  await registerClient(app);

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

/**
 * Serves the built React client, when it has been built.
 *
 * One process serving both the API and the UI is the right shape for an on-prem
 * Windows install: one service to register, one port to open in the firewall,
 * and the session cookie is first-party because there is only one origin.
 *
 * In development the client runs under Vite on :5173 and proxies /api here, so
 * dist/ is usually absent — hence the check rather than a hard failure.
 */
async function registerClient(app) {
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/dist');

  if (!existsSync(path.join(clientDist, 'index.html'))) {
    log.warn(
      { clientDist },
      'client not built - API only. Run "npm run build:client" to serve the UI from this process.',
    );
    return;
  }

  await app.register(fastifyStatic, { root: clientDist, prefix: '/' });

  // SPA fallback: the router owns /folders/123, which is not a file on disk.
  // Anything under /api is left alone so a bad API path still 404s as JSON
  // rather than returning index.html, which would surface as a JSON parse error
  // in the client and hide the real problem.
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
}
