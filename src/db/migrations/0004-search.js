/**
 * Migration 0004 — full-text search over Arabic.
 *
 * ─── Why there are separate "normalized" columns ────────────────────────────
 *
 * Measured on this server: Arabic_CI_AI unifies only ى/ي and tatweel. It does
 * NOT unify ة/ه, alef hamza forms (أ/ا/آ), or — the counter-intuitive one —
 * tashkeel. "Accent-insensitive" does not mean diacritic-insensitive for Arabic,
 * so مَكْتَبَة does not match مكتبة under the collation alone.
 *
 * That is four of the six commonest spelling variants passing straight through,
 * which is why normalizeArabic() is load-bearing rather than an optimisation.
 * It is JavaScript, so it cannot be a computed column — the normalised form is
 * written by the application alongside the original, and the full-text index is
 * built over the normalised columns only.
 *
 * The original title is what users see; the normalised copy is what they search.
 * Both must be written together or search silently misses documents.
 *
 * ─── CHANGE_TRACKING AUTO, against the design draft ─────────────────────────
 *
 * docs/schema-design-inputs.md proposes MANUAL tracking with a scheduled
 * population, to keep the full-text daemon from competing with writes. That is
 * the right call at high ingest rates and the wrong one here: MANUAL means a
 * document is unsearchable until a job runs, so "I just uploaded it and search
 * cannot find it" becomes the normal experience. At this scale the daemon is not
 * the bottleneck. If ingest volume ever makes it one, switching to MANUAL plus a
 * population schedule is a later migration, not a redesign.
 *
 * ─── Not transactional ──────────────────────────────────────────────────────
 *
 * Full-text catalogue and index DDL cannot run inside a transaction, so this
 * migration cannot roll back and every statement is guarded to be re-runnable.
 */

import { sql } from 'kysely';

/** Arabic word breaker. Confirmed registered on this server. */
export const ARABIC_LCID = 1025;

export const m0004Search = {
  id: '0004',
  name: 'full-text search over normalized Arabic',
  // CREATE FULLTEXT CATALOG / INDEX are forbidden inside a transaction.
  transactional: false,

  async up(conn) {
    // ── Normalised search columns ────────────────────────────────────────
    await sql`
      IF COL_LENGTH('dbo.documents', 'title_normalized') IS NULL
        ALTER TABLE dbo.documents
          ADD title_normalized nvarchar(500) COLLATE Arabic_CI_AI NULL;
    `.execute(conn);

    // Extracted document text, already normalised. NVARCHAR(MAX) because a
    // scanned contract can run to hundreds of kilobytes of text.
    await sql`
      IF COL_LENGTH('dbo.documents', 'content_normalized') IS NULL
        ALTER TABLE dbo.documents
          ADD content_normalized nvarchar(max) COLLATE Arabic_CI_AI NULL;
    `.execute(conn);

    // 0 = pending, 1 = extracted, 2 = unsupported type, 3 = failed.
    // Deliberately not an FK to a lookup table: this is internal pipeline state,
    // never shown to a user, and a join for it would be noise on every query.
    await sql`
      IF COL_LENGTH('dbo.documents', 'extraction_status') IS NULL
        ALTER TABLE dbo.documents
          ADD extraction_status tinyint NOT NULL
            CONSTRAINT DF_documents_extraction_status DEFAULT 0;
    `.execute(conn);

    await sql`
      IF COL_LENGTH('dbo.documents', 'extracted_at') IS NULL
        ALTER TABLE dbo.documents ADD extracted_at datetime2(3) NULL;
    `.execute(conn);

    // Prefix matching on the normalised title, for the type-ahead that must work
    // whether or not full-text indexing is available on the instance.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_documents_title_normalized')
        CREATE INDEX IX_documents_title_normalized
          ON dbo.documents (title_normalized)
          INCLUDE (folder_id, title, current_version)
          WHERE is_deleted = 0;
    `.execute(conn);

    // ── The extraction queue ─────────────────────────────────────────────
    //
    // A table rather than Redis: there is already exactly one durable store here,
    // and adding a second process to keep alive on a Windows server -- with its
    // own failure mode, backup story and version -- to hold a work list of a few
    // thousand rows is not a trade worth making.
    await sql`
      IF OBJECT_ID('dbo.extraction_queue', 'U') IS NULL
      CREATE TABLE dbo.extraction_queue (
        queue_id     bigint        IDENTITY(1,1) NOT NULL,
        document_id  bigint        NOT NULL,
        version_number smallint    NOT NULL,
        status       tinyint       NOT NULL CONSTRAINT DF_extraction_queue_status DEFAULT 0,
        attempts     int           NOT NULL CONSTRAINT DF_extraction_queue_attempts DEFAULT 0,
        last_error   nvarchar(2000) NULL,
        queued_at    datetime2(3)  NOT NULL CONSTRAINT DF_extraction_queue_queued_at DEFAULT SYSUTCDATETIME(),
        started_at   datetime2(3)  NULL,
        finished_at  datetime2(3)  NULL,
        CONSTRAINT PK_extraction_queue PRIMARY KEY (queue_id),
        CONSTRAINT FK_extraction_queue_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        -- One queue entry per version. A re-upload of the same version cannot
        -- enqueue twice, and a retry updates the row rather than adding another.
        CONSTRAINT UQ_extraction_queue_version UNIQUE (document_id, version_number)
      );
    `.execute(conn);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_extraction_queue_pending')
        CREATE INDEX IX_extraction_queue_pending
          ON dbo.extraction_queue (status, queued_at)
          INCLUDE (document_id, version_number, attempts)
          WHERE status IN (0, 3);
    `.execute(conn);

    // ── Full-text catalogue and index ────────────────────────────────────
    //
    // Skipped entirely when full-text search is not installed. It is an optional
    // installer component, and refusing to migrate would make the whole system
    // un-runnable over a feature that only affects content search. Attribute
    // search keeps working; boot warns loudly.
    const installed = await sql`
      SELECT CAST(SERVERPROPERTY('IsFullTextInstalled') AS int) AS installed
    `.execute(conn);

    if (Number(installed.rows[0]?.installed) !== 1) return;

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = 'dms_ft_catalog')
        CREATE FULLTEXT CATALOG dms_ft_catalog;
    `.execute(conn);

    // LANGUAGE 1025 selects the Arabic word breaker for both columns. Without it
    // SQL Server falls back to neutral breaking, which splits on whitespace only
    // and loses Arabic prefix and suffix handling.
    await sql`
      IF NOT EXISTS (
        SELECT 1 FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID('dbo.documents')
      )
      CREATE FULLTEXT INDEX ON dbo.documents (
        title_normalized   LANGUAGE ${sql.raw(String(ARABIC_LCID))},
        content_normalized LANGUAGE ${sql.raw(String(ARABIC_LCID))}
      )
      KEY INDEX PK_documents
      ON dms_ft_catalog
      WITH STOPLIST = OFF, CHANGE_TRACKING AUTO;
    `.execute(conn);
  },
};
