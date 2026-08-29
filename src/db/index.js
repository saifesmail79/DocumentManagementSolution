/**
 * Database connection.
 *
 * Kysely as a query builder over tedious — deliberately NOT an ORM. Every major
 * ORM carries an open SQL Server-specific defect (Prisma has no Json column type
 * for mssql, TypeORM pins a tedious version below a CVE fix, Sequelize's pool
 * validation broke on tedious 13.1, Drizzle's mssql support is beta). A query
 * builder gives composable SQL with none of that surface.
 *
 * Two settings below are load-bearing and easy to get wrong:
 *
 *   • NVARCHAR, always. tedious sends a JS string as VARCHAR by default in some
 *     paths, and VARCHAR under a UTF-8 collation silently corrupts multi-byte
 *     Arabic because the driver measures character count where the server expects
 *     byte count. Everything text is NVARCHAR, end to end.
 *   • useUTC. Timestamps are stored and compared in UTC and converted for display
 *     only. A previous project lost a day to a driver reading DATETIME in the wrong
 *     zone; pinning it here removes the question.
 */

import { Kysely, MssqlDialect, sql } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';
import { config } from '../config/index.js';
import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('db');

function connectionFactory() {
  return new Tedious.Connection({
    server: config.db.server,
    authentication: {
      type: 'default',
      options: { userName: config.db.user, password: config.db.password },
    },
    options: {
      port: config.db.port,
      database: config.db.database,
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      requestTimeout: config.db.requestTimeoutMs,
      // Store and compare in UTC; convert for display in the UI only.
      useUTC: true,
      // Return DECIMAL/NUMERIC as strings rather than lossy JS numbers.
      enableArithAbort: true,
      rowCollectionOnRequestCompletion: false,
      validateBulkLoadParameters: true,
    },
  });
}

export const db = new Kysely({
  dialect: new MssqlDialect({
    tarn: {
      ...Tarn,
      options: {
        min: config.db.poolMin,
        max: config.db.poolMax,
        // Fail fast rather than letting a request hang forever waiting for a
        // connection that a stalled query is holding.
        acquireTimeoutMillis: 30_000,
      },
    },
    tedious: {
      ...Tedious,
      connectionFactory,
    },
  }),
});

export { sql };

/** Verifies the database is reachable and reports what we are connected to. */
export async function verifyConnection() {
  const result = await sql`
    SELECT
      DB_NAME()                                AS [database],
      CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64))   AS [version],
      CAST(SERVERPROPERTY('Edition') AS nvarchar(128))         AS [edition],
      CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS [collation]
  `.execute(db);

  const info = result.rows[0];
  log.info(info, 'connected to SQL Server');
  return info;
}

/**
 * Reports whether full-text search is installed and whether the Arabic word
 * breaker (LCID 1025) is present.
 *
 * Full-text search is included in every SQL Server edition but is an OPTIONAL
 * installer component, so a fresh instance frequently lacks it. Content search
 * silently returns nothing without it, which is a confusing failure — so we check
 * at boot and warn loudly rather than letting users conclude search is broken.
 */
export async function checkFullTextSearch() {
  try {
    const installed = await sql`SELECT SERVERPROPERTY('IsFullTextInstalled') AS installed`.execute(db);
    const isInstalled = Number(installed.rows[0]?.installed) === 1;

    if (!isInstalled) {
      log.warn(
        'Full-Text Search is NOT installed on this SQL Server instance. Document CONTENT search ' +
          'will return no results. Re-run the SQL Server installer, choose "Add features to an ' +
          'existing instance", and select "Full-Text and Semantic Extractions for Search". ' +
          'It is included in every edition at no extra licence cost.',
      );
      return { installed: false, arabic: false };
    }

    const arabic = await sql`SELECT lcid, name FROM sys.fulltext_languages WHERE lcid = 1025`.execute(db);
    const hasArabic = arabic.rows.length > 0;

    if (!hasArabic) {
      log.warn(
        'Full-Text Search is installed but the Arabic word breaker (LCID 1025) is not registered. ' +
          'Arabic content search will fall back to neutral word breaking and match poorly.',
      );
    } else {
      log.info('full-text search ready, Arabic word breaker (LCID 1025) present');
    }

    return { installed: true, arabic: hasArabic };
  } catch (error) {
    log.warn({ err: error }, 'could not determine full-text search status');
    return { installed: false, arabic: false, error: error.message };
  }
}

export async function closeDatabase() {
  await db.destroy();
  log.info('database connections closed');
}
