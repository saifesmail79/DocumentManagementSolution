/**
 * Migration 0012 — constituent files, and the indexes parameter filters seek on.
 *
 * ─── Why a second file table, and not more versions ─────────────────────────
 *
 * Someone selects five scans of one contract and says "file these as one entry".
 * Those five files are peers: they exist at the same time and all of them are
 * the document. That is a different relationship from the one
 * dbo.document_versions models, where row N supersedes row N-1 and only the
 * newest is current.
 *
 * Reusing versions for this would have been free in schema terms and wrong in
 * every other: the version panel would present five simultaneous pages as five
 * revisions, `current_version` would point at the last file that happened to be
 * uploaded, and restoring "an earlier version" would restore a different page.
 *
 * So the two tables are deliberately disjoint axes:
 *
 *   document_versions  — one file, revised over time      (version_number >= 1)
 *   document_files     — N files, all current, ordered     (sort_order 0..N-1)
 *
 * A document uses one axis or the other, never both. A multi-file document
 * keeps `current_version = 0`, which is the existing default and already means
 * "no version row" — every LEFT JOIN on current_version therefore yields NULL
 * for these documents rather than a wrong row, and callers branch on the
 * document_files EXISTS instead. Nothing that reads a single-file document
 * changes shape.
 *
 * ─── Ordering is data, not an accident ──────────────────────────────────────
 *
 * sort_order is the upload position, and it is what extraction concatenates by
 * and what the file list renders by. It is NOT file_id: identity values are
 * assigned by the database and carry no promise of matching the order the user
 * chose. UNIQUE (document_id, sort_order) makes a gap or a collision a write
 * error rather than a silently reshuffled document.
 *
 * ─── storage_path is NVARCHAR ───────────────────────────────────────────────
 *
 * Same reason as document_versions: the path embeds the sanitised Arabic title,
 * and tedious can send a JS string as VARCHAR, where a multi-byte character is
 * measured by character count against a server counting bytes. This corrupts
 * silently and only for Arabic titles, which is the worst possible combination.
 *
 * ─── The indexes at the bottom ──────────────────────────────────────────────
 *
 * Filtering a listing by uploader or by last-modified had no supporting index:
 * dbo.documents carries (folder_id, created_at DESC) and a title index, so
 * `created_by = ?` was a residual predicate evaluated against every live row in
 * the folder. That is survivable at a thousand documents and not at a hundred
 * thousand, and it degrades quietly — the query keeps returning correct rows,
 * just slower every month.
 */

import { sql } from 'kysely';

export const m0012MultiFileDocuments = {
  id: '0012',
  name: 'document_files, plus the indexes parameter filters seek on',

  async up(trx) {
    // ─────────────────────────────────────────────────────────────────────
    // Constituent files.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      IF OBJECT_ID('dbo.document_files', 'U') IS NULL
      CREATE TABLE dbo.document_files (
        file_id           bigint         IDENTITY(1,1) NOT NULL,
        document_id       bigint         NOT NULL,
        -- Upload position, 0-based. See the header: this is the reading order,
        -- and it is not interchangeable with file_id.
        sort_order        int            NOT NULL,
        -- NVARCHAR: contains the sanitised Arabic title. See the header.
        storage_path      nvarchar(1000) NOT NULL,
        original_filename nvarchar(400)  COLLATE Arabic_CI_AI NULL,
        file_size_bytes   bigint         NOT NULL,
        sha256            char(64)       COLLATE Latin1_General_BIN2 NOT NULL,
        mime_type         varchar(150)   NOT NULL
          CONSTRAINT DF_document_files_mime DEFAULT 'application/octet-stream',
        uploaded_by       bigint         NOT NULL,
        uploaded_at       datetime2(3)   NOT NULL
          CONSTRAINT DF_document_files_uploaded_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_document_files PRIMARY KEY (file_id),
        CONSTRAINT FK_document_files_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_document_files_uploader FOREIGN KEY (uploaded_by)
          REFERENCES dbo.users(user_id),
        -- Two rows must never claim the same blob: a delete would take out both.
        -- Identical to the guarantee document_versions makes for the same reason.
        CONSTRAINT UQ_document_files_path UNIQUE (storage_path),
        -- Ordering is a promise, so a duplicate position is a write error rather
        -- than a document whose pages silently swap on the next read.
        CONSTRAINT UQ_document_files_order UNIQUE (document_id, sort_order),
        CONSTRAINT CK_document_files_order CHECK (sort_order >= 0),
        CONSTRAINT CK_document_files_size CHECK (file_size_bytes > 0)
      );
    `.execute(trx);

    // The hot path: fetch one document's files in reading order. Covering, so
    // rendering a file list never touches the base table.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_document_files_document')
        CREATE INDEX IX_document_files_document
          ON dbo.document_files (document_id, sort_order)
          INCLUDE (storage_path, original_filename, file_size_bytes, sha256, mime_type);
    `.execute(trx);

    // Duplicate detection and the integrity sweep both walk by hash. Without
    // this, filing a constituent file that already exists elsewhere is a scan.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_document_files_sha256')
        CREATE INDEX IX_document_files_sha256
          ON dbo.document_files (sha256)
          INCLUDE (document_id, sort_order);
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Indexes for parameter filtering.
    //
    // Filtered on is_deleted = 0 to match IX_documents_folder_created, which is
    // filtered the same way: a listing never wants deleted rows, and excluding
    // them keeps the index proportional to live data rather than to history.
    // ─────────────────────────────────────────────────────────────────────

    // "Documents in this folder uploaded by X". created_by appears in no
    // existing key or INCLUDE, so this filter was a full folder scan.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_documents_folder_creator')
        CREATE INDEX IX_documents_folder_creator
          ON dbo.documents (folder_id, created_by)
          INCLUDE (created_at, updated_at, type_id, sensitivity_label_id, title)
          WHERE is_deleted = 0;
    `.execute(trx);

    // "Changed between these dates". updated_at is only in the INCLUDE of the
    // existing listing index, so a range on it could not seek.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_documents_folder_updated')
        CREATE INDEX IX_documents_folder_updated
          ON dbo.documents (folder_id, updated_at DESC)
          INCLUDE (created_at, created_by, type_id, sensitivity_label_id, title)
          WHERE is_deleted = 0;
    `.execute(trx);

    // Filtering by file type or size across folders — the Search page's
    // parameter mode, which has no folder to narrow by first.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_document_versions_mime')
        CREATE INDEX IX_document_versions_mime
          ON dbo.document_versions (mime_type)
          INCLUDE (document_id, version_number, file_size_bytes);
    `.execute(trx);
  },
};
