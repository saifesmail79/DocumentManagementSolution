/**
 * Test database isolation.
 *
 * The integration suite truncates every identity and filing-tree table in the
 * database it connects to. That was safe while those tests ran against a
 * disposable container, but .env now points at a real SQL Server instance, so
 * the suite must never inherit the application's DB_NAME.
 *
 * This module redirects the suite to a dedicated database (DB_NAME + "_test" by
 * default) and refuses to run if that resolves to the application database. It
 * has to run BEFORE src/config is imported, because config reads process.env at
 * import time and freezes the result.
 *
 * tedious is used directly rather than the app's pool: the target database may
 * not exist yet, and the pool cannot connect to a database that is missing.
 *
 * Every integration file shares this one database and truncates it in its own
 * before() hook, so they must not run at the same time. `node --test` runs files
 * concurrently by default; the npm scripts pass --test-concurrency=1 for exactly
 * this reason. Removing that flag produces foreign-key violations during seeding
 * that look like schema bugs and are not.
 */

import { Connection, Request } from 'tedious';

/** Collation for the test database. Must match production so collation-conflict bugs surface here. */
const TEST_COLLATION = 'Arabic_CI_AI';

/**
 * Decides which database the integration suite should use, and rewrites
 * process.env.DB_NAME so every later import picks it up.
 *
 * @returns {{configured: boolean, reason?: string, database?: string, appDatabase?: string}}
 */
export function resolveTestDatabase() {
  const appDatabase = process.env.DB_NAME;

  if (!process.env.DB_SERVER) {
    return { configured: false, reason: 'DB_SERVER not set' };
  }

  const database = process.env.TEST_DB_NAME || (appDatabase ? `${appDatabase}_test` : undefined);

  if (!database) {
    return { configured: false, reason: 'neither DB_NAME nor TEST_DB_NAME is set' };
  }

  // The whole point of this module. A misconfigured TEST_DB_NAME must stop the
  // run, not quietly delete production data.
  if (appDatabase && database.toLowerCase() === appDatabase.toLowerCase()) {
    throw new Error(
      `Refusing to run integration tests against "${database}" — it is the application database ` +
        `(DB_NAME). These tests DELETE every row in principals, users, groups, folders and ` +
        `access_control_entries. Set TEST_DB_NAME to a disposable database.`,
    );
  }

  process.env.DB_NAME = database;
  return { configured: true, database, appDatabase };
}

/**
 * Table truncation order, children before parents.
 *
 * This lives here rather than in each test file so that adding a migration means
 * updating one list. When it was per-file, migration 0002 broke the permission
 * suite: its seed deleted folders that documents still referenced, and the
 * foreign-key error read like a schema bug rather than stale test setup.
 *
 * Folders are handled separately — the tree is self-referencing and arbitrarily
 * deep, so a single DELETE cannot satisfy FK_folders_parent.
 */
const TRUNCATION_ORDER = [
  'document_tags',
  'tags',
  'document_field_values',
  'document_versions',
  'documents',
  'custom_field_choices',
  'custom_field_defs',
  'document_types',
  'sensitivity_labels',
  'effective_permissions',
  'access_control_entries',
  'group_members',
  'user_roles',
  'roles',
];

/**
 * Empties every application table. Skips tables a migration has not created yet,
 * so an older test file still runs against a partially migrated database.
 *
 * @param {unknown} db   the Kysely instance
 * @param {(strings: TemplateStringsArray, ...values: unknown[]) => any} sql
 */
export async function resetDatabase(db, sql) {
  const present = new Set(
    (
      await sql`SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`.execute(
        db,
      )
    ).rows.map((r) => r.name),
  );

  for (const table of TRUNCATION_ORDER) {
    if (present.has(table)) await sql.raw(`DELETE FROM dbo.${table}`).execute(db);
  }

  // Peel the tree from the leaves inward. A depth-ordered delete would also work,
  // but this does not assume `depth` is maintained correctly — which is one of the
  // things the tests are checking.
  if (present.has('folders')) {
    await sql`
      WHILE EXISTS (SELECT 1 FROM dbo.folders)
        DELETE FROM dbo.folders
        WHERE folder_id NOT IN (SELECT parent_id FROM dbo.folders WHERE parent_id IS NOT NULL);
    `.execute(db);
  }

  for (const table of ['users', 'groups', 'principals']) {
    if (present.has(table)) await sql.raw(`DELETE FROM dbo.${table}`).execute(db);
  }
}

/** Runs one statement on `master` over a short-lived tedious connection. */
function executeOnMaster(statement) {
  return new Promise((resolve, reject) => {
    const connection = new Connection({
      server: process.env.DB_SERVER,
      authentication: {
        type: 'default',
        options: { userName: process.env.DB_USER, password: process.env.DB_PASSWORD },
      },
      options: {
        port: Number(process.env.DB_PORT || 1433),
        database: 'master',
        encrypt: String(process.env.DB_ENCRYPT ?? 'true') !== 'false',
        trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE ?? 'true') !== 'false',
        rowCollectionOnRequestCompletion: true,
      },
    });

    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      connection.close();
      error ? reject(error) : resolve(value);
    };

    connection.on('connect', (error) => {
      if (error) return finish(error);

      const rows = [];
      const request = new Request(statement, (err) => (err ? finish(err) : finish(null, rows)));
      request.on('row', (columns) => rows.push(columns.map((c) => c.value)));
      connection.execSql(request);
    });

    connection.on('error', finish);

    // Required since tedious 11 — constructing a Connection no longer connects,
    // so without this the 'connect' handler above never fires and the suite hangs
    // with no output.
    connection.connect();
  });
}

/**
 * Creates the test database if it does not exist.
 *
 * CREATE DATABASE is not idempotent and cannot run inside a transaction, so the
 * existence check and the create are separate statements. A race between two
 * concurrent test runs would surface as a plain "database already exists" error,
 * which is acceptable for a developer-run suite.
 */
export async function ensureTestDatabase(database) {
  const existing = await executeOnMaster(
    `SELECT name FROM sys.databases WHERE name = '${database.replace(/'/g, "''")}'`,
  );

  if (existing.length > 0) return { created: false };

  // The name is an identifier, not a parameter — sp_executesql cannot parameterise
  // it. It comes from TEST_DB_NAME or DB_NAME (developer-controlled, not user
  // input), and the bracket-escape below closes the injection path regardless.
  const safeName = database.replace(/]/g, ']]');
  await executeOnMaster(`CREATE DATABASE [${safeName}] COLLATE ${TEST_COLLATION}`);
  return { created: true };
}
