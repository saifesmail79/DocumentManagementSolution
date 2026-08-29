/**
 * Migration runner.
 *
 * Every schema change lives in the MIGRATIONS manifest in ./migrations/index.js and
 * runs automatically at boot. There is no separate "apply the SQL by hand" step —
 * a change that is not in the manifest does not exist, and a deployment cannot
 * drift from the code because the code is what creates the schema.
 *
 * Design notes:
 *
 *   • Migrations run on ONE pinned connection holding an application lock, so two
 *     app instances starting at the same moment cannot both apply the same
 *     migration. The second waits, then finds nothing pending.
 *
 *   • Each migration runs in its own transaction and is recorded in the same
 *     transaction, so a failure can never leave a migration half-applied yet
 *     marked as done. SQL Server DDL is transactional, which makes this safe.
 *
 *   • A few statements cannot run inside a transaction — CREATE FULLTEXT INDEX and
 *     CREATE FULLTEXT CATALOG are the ones we hit. Those migrations set
 *     `transactional: false` and are responsible for their own idempotency.
 *
 *   • Migrations are append-only. Never edit an applied migration; add a new one.
 *     The runner verifies this by comparing checksums and refuses to start if a
 *     migration that has already run has been changed underneath it.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db, sql } from './index.js';
import { MIGRATIONS } from './migrations/index.js';
import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('migrate');

/** Arbitrary but stable name for the application lock. */
const LOCK_RESOURCE = 'dms_schema_migrations';
const LOCK_TIMEOUT_MS = 60_000;

function checksum(migration) {
  return createHash('sha256').update(String(migration.up)).digest('hex').slice(0, 16);
}

async function ensureMigrationsTable(executor) {
  await sql`
    IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.schema_migrations (
        id           varchar(20)    NOT NULL CONSTRAINT PK_schema_migrations PRIMARY KEY,
        name         nvarchar(200)  NOT NULL,
        checksum     varchar(64)    NOT NULL,
        applied_at   datetime2(3)   NOT NULL CONSTRAINT DF_schema_migrations_applied_at DEFAULT SYSUTCDATETIME(),
        duration_ms  int            NOT NULL
      );
    END
  `.execute(executor);
}

async function getApplied(executor) {
  const result = await sql`
    SELECT id, name, checksum FROM dbo.schema_migrations
  `.execute(executor);
  return new Map(result.rows.map((r) => [r.id, r]));
}

function validateManifest() {
  const seen = new Set();
  for (const m of MIGRATIONS) {
    if (!m.id || !m.name || typeof m.up !== 'function') {
      throw new Error(`Invalid migration entry: ${JSON.stringify({ id: m.id, name: m.name })}`);
    }
    if (seen.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
    seen.add(m.id);
  }

  const ids = MIGRATIONS.map((m) => m.id);
  const sorted = [...ids].sort();
  if (ids.join() !== sorted.join()) {
    throw new Error(`MIGRATIONS must be listed in ascending id order. Got: ${ids.join(', ')}`);
  }
}

/**
 * Applies every pending migration. Safe to call on every boot and safe to call
 * concurrently from multiple instances.
 *
 * @returns {Promise<{ applied: string[], alreadyApplied: number }>}
 */
export async function runMigrations() {
  validateManifest();

  return db.connection().execute(async (conn) => {
    // Session-scoped lock held for the life of this pinned connection.
    const lock = await sql`
      DECLARE @rc int;
      EXEC @rc = sp_getapplock
        @Resource = ${LOCK_RESOURCE},
        @LockMode = 'Exclusive',
        @LockOwner = 'Session',
        @LockTimeout = ${LOCK_TIMEOUT_MS};
      SELECT @rc AS result;
    `.execute(conn);

    const lockResult = Number(lock.rows[0]?.result ?? -999);
    if (lockResult < 0) {
      throw new Error(
        `Could not acquire the migration lock (sp_getapplock returned ${lockResult}). ` +
          'Another instance may be migrating; retry shortly.',
      );
    }

    try {
      await ensureMigrationsTable(conn);
      const applied = await getApplied(conn);

      // An applied migration whose body has changed means someone edited history.
      // Refuse to run rather than silently diverging from what is in the database.
      for (const migration of MIGRATIONS) {
        const record = applied.get(migration.id);
        if (record && record.checksum !== checksum(migration)) {
          throw new Error(
            `Migration ${migration.id} (${migration.name}) has been modified after it was applied ` +
              `on this database. Migrations are append-only — revert the edit and add a new ` +
              `migration instead.`,
          );
        }
      }

      const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
      if (pending.length === 0) {
        log.info({ alreadyApplied: applied.size }, 'schema is up to date');
        return { applied: [], alreadyApplied: applied.size };
      }

      log.info({ pending: pending.map((m) => m.id) }, `applying ${pending.length} migration(s)`);
      const done = [];

      for (const migration of pending) {
        const started = Date.now();
        log.info({ id: migration.id, name: migration.name }, 'applying migration');

        try {
          if (migration.transactional === false) {
            // Statements SQL Server forbids inside a transaction (full-text DDL).
            // These must be written to be safely re-runnable themselves.
            await migration.up(conn);
            await recordMigration(conn, migration, Date.now() - started);
          } else {
            await conn.transaction().execute(async (trx) => {
              await migration.up(trx);
              await recordMigration(trx, migration, Date.now() - started);
            });
          }
        } catch (error) {
          const detail = describeSqlError(error);
          log.error(
            { id: migration.id, name: migration.name, sqlErrors: detail, err: error },
            'migration failed — schema left unchanged by this migration',
          );
          throw new Error(
            `Migration ${migration.id} (${migration.name}) failed: ${detail.join(' | ')}`,
            { cause: error },
          );
        }

        const ms = Date.now() - started;
        log.info({ id: migration.id, name: migration.name, ms }, 'migration applied');
        done.push(migration.id);
      }

      return { applied: done, alreadyApplied: applied.size };
    } finally {
      await sql`EXEC sp_releaseapplock @Resource = ${LOCK_RESOURCE}, @LockOwner = 'Session';`
        .execute(conn)
        .catch((error) => log.warn({ err: error }, 'failed to release migration lock'));
    }
  });
}

/**
 * Extracts something readable from a tedious failure.
 *
 * tedious raises an AggregateError whose own `message` is undefined and whose
 * detail lives in `.errors[]`. Reporting error.message alone yields
 * "failed: undefined", which says nothing about what SQL was wrong — so unpack
 * the number, line and text that actually identify the problem.
 */
function describeSqlError(error) {
  const parts = [];
  const collect = (e) => {
    if (!e) return;
    if (Array.isArray(e.errors)) {
      e.errors.forEach(collect);
      return;
    }
    const bits = [];
    if (e.number !== undefined) bits.push(`SQL ${e.number}`);
    if (e.lineNumber !== undefined) bits.push(`line ${e.lineNumber}`);
    if (e.procName) bits.push(`in ${e.procName}`);
    const text = e.message ?? String(e);
    parts.push(bits.length > 0 ? `${bits.join(' ')}: ${text}` : text);
  };
  collect(error);
  if (error?.cause) collect(error.cause);
  return parts.length > 0 ? [...new Set(parts)] : [String(error?.message ?? error)];
}

async function recordMigration(executor, migration, durationMs) {
  await sql`
    INSERT INTO dbo.schema_migrations (id, name, checksum, duration_ms)
    VALUES (${migration.id}, ${migration.name}, ${checksum(migration)}, ${durationMs})
  `.execute(executor);
}

/** `npm run migrate` — apply migrations and exit. */
async function main() {
  try {
    const result = await runMigrations();
    if (result.applied.length > 0) {
      log.info({ applied: result.applied }, 'migrations complete');
    }
    await db.destroy();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'migration run failed');
    await db.destroy().catch(() => {});
    process.exit(1);
  }
}

// Run main() only when this file is the entry point, not when it is imported.
// Build the comparison with pathToFileURL rather than string concatenation: on
// Windows import.meta.url is file:///C:/... (three slashes) and a hand-built
// file://C:/... never matches, which makes `npm run migrate` a silent no-op.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  await main();
}
