/**
 * Integration tests for migration 0002 — documents, versions and typed metadata.
 *
 * Run with `npm run test:db`. Uses the same isolated test database as the
 * permission suite; see tests/helpers/test-database.js.
 *
 * These test the constraints, not the happy path. Every table in 0002 carries at
 * least one rule that exists to stop a specific class of silent corruption, and a
 * constraint nobody has ever seen fire is a constraint that might not work.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

let db;
let sql;

const id = {};

/** Truncates 0002's tables and creates the minimum 0001 rows they depend on. */
async function seed() {
  await resetDatabase(db, sql);

  const principal = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', N'منى')
  `.execute(db);
  id.user = principal.rows[0].pid;
  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash) VALUES (${id.user}, 'mona', 'x')
  `.execute(db);

  const folder = await sql`
    INSERT INTO dbo.folders (parent_id, name, mpath, depth)
    OUTPUT INSERTED.folder_id AS fid
    VALUES (NULL, N'الشؤون القانونية', '/pending/', 0)
  `.execute(db);
  id.folder = folder.rows[0].fid;
  await sql`
    UPDATE dbo.folders SET mpath = ${`/${id.folder}/`} WHERE folder_id = ${id.folder}
  `.execute(db);

  const type = await sql`
    INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (N'عقد')
  `.execute(db);
  id.type = type.rows[0].tid;
}

async function newDocument(title = N_TITLE) {
  const r = await sql`
    INSERT INTO dbo.documents (folder_id, type_id, title, created_by)
    OUTPUT INSERTED.document_id AS did
    VALUES (${id.folder}, ${id.type}, ${title}, ${id.user})
  `.execute(db);
  return r.rows[0].did;
}

async function newField(name, dataType, typeId = null) {
  const r = await sql`
    INSERT INTO dbo.custom_field_defs (type_id, name, data_type)
    OUTPUT INSERTED.field_id AS fid
    VALUES (${typeId}, ${name}, ${dataType})
  `.execute(db);
  return r.rows[0].fid;
}

/** Asserts that a statement fails, and that it fails for the expected reason. */
async function rejects(fn, expected) {
  await assert.rejects(fn, (error) => {
    assert.match(error.message, expected, `wrong failure reason: ${error.message}`);
    return true;
  });
}

const N_TITLE = 'عقد إيجار مبنى الإدارة';

describe('documents and typed metadata', { skip: CONFIGURED ? false : target.reason }, () => {
  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await seed();
  });

  after(async () => {
    if (db) await db.destroy();
  });

  // ── The decision this migration is built around ────────────────────────
  //
  // storage_path holds a sanitised Arabic title. If that column were VARCHAR,
  // tedious would measure the parameter in characters where the server counts
  // bytes and truncate mid-string — silently, and only for Arabic. This test is
  // the reason the column is NVARCHAR.
  test('an Arabic storage path round-trips byte-for-byte', async () => {
    const documentId = await newDocument();
    const path = `2026/08/${documentId}_v1_عقد_إيجار_مبنى_الإدارة.pdf`;

    await sql`
      INSERT INTO dbo.document_versions
        (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
      VALUES (${documentId}, 1, ${path}, 1024, ${'a'.repeat(64)}, ${id.user})
    `.execute(db);

    const r = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);

    assert.equal(r.rows[0].storage_path, path);
    assert.ok(r.rows[0].storage_path.includes('عقد_إيجار'), 'Arabic survived the round trip');
  });

  test('an Arabic title round-trips unchanged', async () => {
    const documentId = await newDocument('مكتبة الوثائق');
    const r = await sql`SELECT title FROM dbo.documents WHERE document_id = ${documentId}`.execute(db);
    assert.equal(r.rows[0].title, 'مكتبة الوثائق');
  });

  /**
   * Measured against this server, not assumed — the answer decides whether
   * src/lib/arabic.js is an optimisation or load-bearing.
   *
   * Arabic_CI_AI closes only two of the six equivalences Arabic readers expect.
   * Notably "accent-insensitive" does NOT mean tashkeel-insensitive: a title
   * carrying diacritics will not match the same word without them. Relying on the
   * collation alone would silently lose most Arabic recall, which is exactly the
   * gap normalizeArabic() exists to close — at index time AND query time, since a
   * normalised query cannot match an unnormalised stored value.
   */
  test('the collation alone does not close the Arabic recall gap', async () => {
    const eq = async (a, b) => {
      const r = await sql`SELECT CASE WHEN ${a} = ${b} THEN 1 ELSE 0 END AS eq`.execute(db);
      return Number(r.rows[0].eq) === 1;
    };

    // What the collation does handle.
    assert.ok(await eq('على', 'علي'), 'yaa vs alef maqsura');
    assert.ok(await eq('مكــتبة', 'مكتبة'), 'tatweel');

    // What it does not — each of these is a document a user would fail to find.
    assert.ok(!(await eq('مكتبة', 'مكتبه')), 'taa marbuta vs haa is NOT handled');
    assert.ok(!(await eq('مَكْتَبَة', 'مكتبة')), 'tashkeel is NOT stripped by CI_AI');
    assert.ok(!(await eq('أحمد', 'احمد')), 'alef hamza is NOT unified');
    assert.ok(!(await eq('آدم', 'ادم')), 'alef madda is NOT unified');

    // The pipeline closes every one of them.
    const { normalizeArabic } = await import('../src/lib/arabic.js');
    for (const [a, b] of [
      ['مكتبة', 'مكتبه'],
      ['مَكْتَبَة', 'مكتبة'],
      ['أحمد', 'احمد'],
      ['آدم', 'ادم'],
    ]) {
      assert.equal(normalizeArabic(a), normalizeArabic(b), `normalizeArabic should unify ${a}/${b}`);
    }
  });

  // ── document_field_values ──────────────────────────────────────────────

  test('a metadata value must populate exactly one typed column', async () => {
    const documentId = await newDocument();
    const field = await newField('المبلغ', 'number');

    await rejects(
      () =>
        sql`
          INSERT INTO dbo.document_field_values (document_id, field_id, value_text, value_number)
          VALUES (${documentId}, ${field}, N'5000', 5000)
        `.execute(db),
      /CK_document_field_values_one_value/,
    );

    await rejects(
      () =>
        sql`
          INSERT INTO dbo.document_field_values (document_id, field_id) VALUES (${documentId}, ${field})
        `.execute(db),
      /CK_document_field_values_one_value/,
    );
  });

  test('numbers compare numerically, not as strings', async () => {
    const field = await newField('القيمة', 'number');
    const small = await newDocument('صغير');
    const large = await newDocument('كبير');

    // '900' > '5000' as text. This is the whole reason for typed columns.
    await sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_number)
              VALUES (${small}, ${field}, 900)`.execute(db);
    await sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_number)
              VALUES (${large}, ${field}, 5000)`.execute(db);

    const r = await sql`
      SELECT document_id FROM dbo.document_field_values
      WHERE field_id = ${field} AND value_number > 1000
    `.execute(db);

    assert.equal(r.rows.length, 1);
    assert.equal(String(r.rows[0].document_id), String(large));
  });

  test('a document carries each field at most once', async () => {
    const documentId = await newDocument();
    const field = await newField('المرجع', 'text');

    await sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_text)
              VALUES (${documentId}, ${field}, N'L-2026-118')`.execute(db);

    await rejects(
      () =>
        sql`INSERT INTO dbo.document_field_values (document_id, field_id, value_text)
            VALUES (${documentId}, ${field}, N'L-2026-119')`.execute(db),
      /PK_document_field_values|duplicate key/i,
    );
  });

  // ── custom_field_defs ──────────────────────────────────────────────────

  test('a global field name cannot be defined twice', async () => {
    await newField('القسم', 'text');
    await rejects(() => newField('القسم', 'text'), /UX_custom_field_defs_global_name|duplicate key/i);
  });

  test('the same field name may exist under two different document types', async () => {
    const other = await sql`
      INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (N'فاتورة')
    `.execute(db);

    const a = await newField('التاريخ', 'date', id.type);
    const b = await newField('التاريخ', 'date', other.rows[0].tid);
    assert.notEqual(String(a), String(b));
  });

  test('an unknown data type is refused', async () => {
    await rejects(() => newField('غريب', 'jsonb'), /CK_custom_field_defs_data_type/);
  });

  // ── document_versions ──────────────────────────────────────────────────

  test('two versions cannot claim the same file on disk', async () => {
    const first = await newDocument('أول');
    const second = await newDocument('ثاني');
    const path = '2026/08/shared_path.pdf';

    await sql`INSERT INTO dbo.document_versions
                (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
              VALUES (${first}, 1, ${path}, 10, ${'b'.repeat(64)}, ${id.user})`.execute(db);

    // Without this constraint the two documents silently share one blob, and
    // deleting either takes out the other's content.
    await rejects(
      () =>
        sql`INSERT INTO dbo.document_versions
              (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
            VALUES (${second}, 1, ${path}, 10, ${'b'.repeat(64)}, ${id.user})`.execute(db),
      /UQ_document_versions_path|duplicate key/i,
    );
  });

  test('a version number is unique within its document but repeats across documents', async () => {
    const a = await newDocument('وثيقة أ');
    const b = await newDocument('وثيقة ب');

    await sql`INSERT INTO dbo.document_versions
                (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
              VALUES (${a}, 1, ${`2026/08/${a}_v1.pdf`}, 10, ${'c'.repeat(64)}, ${id.user})`.execute(db);

    await rejects(
      () =>
        sql`INSERT INTO dbo.document_versions
              (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
            VALUES (${a}, 1, ${`2026/08/${a}_v1_again.pdf`}, 10, ${'c'.repeat(64)}, ${id.user})`.execute(db),
      /PK_document_versions|duplicate key/i,
    );

    // Same version number, different document — must be allowed.
    await sql`INSERT INTO dbo.document_versions
                (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
              VALUES (${b}, 1, ${`2026/08/${b}_v1.pdf`}, 10, ${'c'.repeat(64)}, ${id.user})`.execute(db);
  });

  test('a zero-byte version is refused', async () => {
    const documentId = await newDocument('فارغ');
    await rejects(
      () =>
        sql`INSERT INTO dbo.document_versions
              (document_id, version_number, storage_path, file_size_bytes, sha256, uploaded_by)
            VALUES (${documentId}, 1, ${`2026/08/${documentId}_empty.pdf`}, 0, ${'d'.repeat(64)}, ${id.user})`.execute(db),
      /CK_document_versions_size/,
    );
  });

  // ── documents ──────────────────────────────────────────────────────────

  test('a deleted document must carry a deletion timestamp', async () => {
    const documentId = await newDocument('للحذف');

    // Setting the flag without the timestamp would make the purge sweep unable to
    // tell when the grace period started, so the row would never be swept.
    await rejects(
      () => sql`UPDATE dbo.documents SET is_deleted = 1 WHERE document_id = ${documentId}`.execute(db),
      /CK_documents_deleted_pair/,
    );

    await sql`
      UPDATE dbo.documents SET is_deleted = 1, deleted_at = SYSUTCDATETIME(), deleted_by = ${id.user}
      WHERE document_id = ${documentId}
    `.execute(db);

    const r = await sql`
      SELECT is_deleted, deleted_at FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(r.rows[0].is_deleted), 1);
    assert.ok(r.rows[0].deleted_at instanceof Date);
  });

  test('a document cannot be filed outside the tree', async () => {
    await rejects(
      () =>
        sql`INSERT INTO dbo.documents (folder_id, title, created_by)
            VALUES (999999, N'يتيم', ${id.user})`.execute(db),
      /FK_documents_folder/,
    );
  });

  // ── sensitivity_labels ─────────────────────────────────────────────────

  test('sensitivity labels are data, ordered by severity', async () => {
    for (const [name, rank] of [
      ['عام', 1],
      ['داخلي', 2],
      ['سري', 3],
    ]) {
      await sql`INSERT INTO dbo.sensitivity_labels (name, severity_rank) VALUES (${name}, ${rank})`.execute(db);
    }

    // "at or above Internal" without hardcoding any deployment's label names.
    const r = await sql`
      SELECT name FROM dbo.sensitivity_labels WHERE severity_rank >= 2 ORDER BY severity_rank
    `.execute(db);
    assert.deepEqual(
      r.rows.map((row) => row.name),
      ['داخلي', 'سري'],
    );

    await rejects(
      () => sql`INSERT INTO dbo.sensitivity_labels (name, severity_rank) VALUES (N'مكرر', 3)`.execute(db),
      /UQ_sensitivity_labels_rank|duplicate key/i,
    );
  });

  test('a malformed label colour is refused', async () => {
    await rejects(
      () =>
        sql`INSERT INTO dbo.sensitivity_labels (name, severity_rank, colour)
            VALUES (N'أحمر', 9, 'red')`.execute(db),
      /CK_sensitivity_labels_colour/,
    );
  });
});
