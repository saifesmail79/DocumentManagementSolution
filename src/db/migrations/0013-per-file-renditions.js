/**
 * Migration 0013 — renditions for one constituent file.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * `document_renditions` and `rendition_queue` are keyed
 * (document_id, version_number, kind), and the worker renders whatever
 * `document_versions.storage_path` points at. That works for the single-file
 * axis and cannot describe the other one at all.
 *
 * A multi-file document deliberately has no version row — migration 0012 keeps
 * `current_version = 0` precisely so nothing joins to a wrong one. So five
 * scans filed as one entry had no renderable source and nowhere to record a
 * result, and every constituent that a browser cannot open natively — a .docx,
 * a .xlsx, a TIFF — showed "cannot be displayed" with a download button, even
 * though LibreOffice on the same machine converts it in about five seconds.
 *
 * ─── Nullable, and part of the key ──────────────────────────────────────────
 *
 * `file_id` is NULL for a whole-document rendition and set for a constituent's,
 * so both axes live in one table and one queue with one worker.
 *
 * SQL Server treats NULLs as equal for uniqueness, which is what is wanted
 * here: exactly one document-level rendition per (document, version, kind), and
 * one per file besides. A filtered unique index would have allowed a second
 * NULL row and reintroduced the duplicate the constraint exists to prevent.
 *
 * ─── Why the constraints are dropped and rebuilt ────────────────────────────
 *
 * SQL Server cannot alter a UNIQUE constraint in place. Dropping and recreating
 * is the only route, and it is safe here because the new key is a superset of
 * the old one: every existing row keeps file_id NULL and therefore keeps
 * satisfying it.
 */

import { sql } from 'kysely';

export const m0013PerFileRenditions = {
  id: '0013',
  name: 'renditions and their queue can address one constituent file',

  async up(trx) {
    // ── The stored rendition ───────────────────────────────────────────
    await sql`
      IF NOT EXISTS (
        SELECT 1 FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.document_renditions') AND name = 'file_id')
      BEGIN
        ALTER TABLE dbo.document_renditions ADD file_id bigint NULL;
      END
    `.execute(trx);

    await sql`
      IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_renditions' AND type = 'UQ')
      BEGIN
        ALTER TABLE dbo.document_renditions DROP CONSTRAINT UQ_renditions;
      END
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_renditions_scoped' AND type = 'UQ')
      BEGIN
        ALTER TABLE dbo.document_renditions
          ADD CONSTRAINT UQ_renditions_scoped UNIQUE (document_id, version_number, kind, file_id);
      END
    `.execute(trx);

    await sql`
      IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_renditions_file')
      BEGIN
        ALTER TABLE dbo.document_renditions
          ADD CONSTRAINT FK_renditions_file FOREIGN KEY (file_id)
            REFERENCES dbo.document_files(file_id);
      END
    `.execute(trx);

    // ── The queue ──────────────────────────────────────────────────────
    await sql`
      IF NOT EXISTS (
        SELECT 1 FROM sys.columns
         WHERE object_id = OBJECT_ID('dbo.rendition_queue') AND name = 'file_id')
      BEGIN
        ALTER TABLE dbo.rendition_queue ADD file_id bigint NULL;
      END
    `.execute(trx);

    await sql`
      IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_rendition_queue' AND type = 'UQ')
      BEGIN
        ALTER TABLE dbo.rendition_queue DROP CONSTRAINT UQ_rendition_queue;
      END
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_rendition_queue_scoped' AND type = 'UQ')
      BEGIN
        ALTER TABLE dbo.rendition_queue
          ADD CONSTRAINT UQ_rendition_queue_scoped UNIQUE (document_id, version_number, kind, file_id);
      END
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_rendition_queue_file')
      BEGIN
        ALTER TABLE dbo.rendition_queue
          ADD CONSTRAINT FK_rendition_queue_file FOREIGN KEY (file_id)
            REFERENCES dbo.document_files(file_id);
      END
    `.execute(trx);
  },
};
