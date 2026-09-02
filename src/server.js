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
import { storage } from './storage/index.js';
import { startExtractionWorker } from './modules/extraction/worker.js';
import { startMaintenance } from './modules/storage-maintenance/purge.js';
import { startNotificationMailer } from './modules/notifications/service.js';
import { startRenditionWorker } from './modules/renditions/service.js';
import { startClassificationWorker } from './modules/classification/worker.js';

const log = moduleLogger('server');

let app;
let extraction;
let maintenance;
let mailer;
let renditions;
let classification;

async function start() {
  // Fail loudly here rather than on the first user request.
  await verifyConnection();

  /*
   * The schema is brought up to date before anything is served.
   *
   * ─── Why this belongs at boot and not only in `npm run migrate` ─────────
   *
   * It used to be only there, and the result was a deployment step that looked
   * automatic and was not. Starting the application loaded new code against an
   * old schema: routes that reference a table nobody created answer every
   * request with a 500, and the failure surfaces as a feature that silently does
   * not work rather than as a system that will not start. That is precisely how
   * the tile arrangement shipped, passed its tests, and could not save.
   *
   * Two instances starting at the same moment are safe: the runner holds an
   * application lock on one pinned connection, so the second waits and then
   * finds nothing pending. `npm run migrate` still exists for applying the
   * schema without opening a port.
   */
  const { runMigrations } = await import('./db/migrate.js');
  const migrations = await runMigrations();
  if (migrations.applied.length > 0) {
    log.info({ applied: migrations.applied }, 'schema brought up to date');
  }

  await checkFullTextSearch();

  // Probes that the storage root is reachable, writable, and honours flushes.
  // On-prem this is where a misconfigured STORAGE_ROOT surfaces -- at startup
  // with a clear message, rather than on the first user's upload.
  await storage.init();

  /*
   * A stored root overrides the environment one, once the database is reachable.
   *
   * The environment value is probed first and stays the fallback: if the stored
   * location is gone — an unmounted share, a replaced NAS — this logs which one
   * it could not reach and carries on with the environment's. A system that
   * starts and reports unreachable documents beats one that refuses to start at
   * all, because the second cannot even show an administrator the setting that
   * is wrong.
   */
  const { applyStoredRoot } = await import('./modules/storage-maintenance/relocation.js');
  await applyStoredRoot().catch((error) => {
    log.error({ err: error }, 'could not apply the stored storage root; using the environment value');
  });

  app = await buildApp();

  // Started after the database and storage checks pass: a worker polling a
  // database that is not reachable just logs errors on a timer.
  extraction = startExtractionWorker();
  maintenance = startMaintenance();
  mailer = startNotificationMailer();
  renditions = startRenditionWorker();
  // Always started; it idles until the stored switch turns the pilot on.
  classification = startClassificationWorker();

  await app.listen({ host: config.server.host, port: config.server.port });
  log.info(
    { url: `http://localhost:${config.server.port}`, storageRoot: storage.root },
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
    extraction?.stop();
    maintenance?.stop();
    mailer?.stop();
    renditions?.stop();
    classification?.stop();
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
