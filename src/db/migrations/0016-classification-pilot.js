import { sql } from 'kysely';

/**
 * The document-recognition pilot.
 *
 * ─── What this is for ───────────────────────────────────────────────────────
 *
 * A customer with hundreds of thousands of historical scans cannot classify
 * them one at a time. The pilot measures whether the system can recognise a
 * document's type from the look of its first page and read the header fields
 * — number, date, subject, addressee — well enough to be worth building on.
 * Nothing here routes a document anywhere or writes its metadata: the tables
 * hold fingerprints and measurements, and a person reads the numbers.
 *
 * ─── Two tables ─────────────────────────────────────────────────────────────
 *
 * `classification_queue` is the work list, shaped exactly like the extraction
 * and rendition queues so the same claim-under-READPAST worker pattern applies
 * and a dead worker's claim is recovered the same way.
 *
 * `classification_pages` holds one row per document: what page one looked like
 * (the fingerprints), what Tesseract read from it (the words, with positions),
 * and what the header extractor made of that. One row, not one per version —
 * the pilot compares documents, and a document is one thing. `version_number`
 * records which version the row was computed from so a re-upload is visibly
 * stale rather than silently wrong.
 *
 * The three JSON columns are NVARCHAR(MAX) on purpose. Their shape belongs to
 * the classifier and will change as the pilot learns what matters; a column
 * per feature would mean a migration per experiment.
 */
export const m0016ClassificationPilot = {
  id: '0016',
  name: 'document classification pilot',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.classification_queue', 'U') IS NULL
      CREATE TABLE dbo.classification_queue (
        queue_id     bigint         IDENTITY(1,1) NOT NULL,
        document_id  bigint         NOT NULL,
        status       tinyint        NOT NULL CONSTRAINT DF_classification_queue_status DEFAULT 0,
        attempts     int            NOT NULL CONSTRAINT DF_classification_queue_attempts DEFAULT 0,
        last_error   nvarchar(2000) NULL,
        queued_at    datetime2(3)   NOT NULL CONSTRAINT DF_classification_queue_queued_at DEFAULT SYSUTCDATETIME(),
        started_at   datetime2(3)   NULL,
        finished_at  datetime2(3)   NULL,
        CONSTRAINT PK_classification_queue PRIMARY KEY (queue_id),
        CONSTRAINT FK_classification_queue_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        -- One entry per document. A rebuild updates the row rather than adding
        -- another, the same as the other queues.
        CONSTRAINT UQ_classification_queue_document UNIQUE (document_id)
      );
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.classification_pages', 'U') IS NULL
      CREATE TABLE dbo.classification_pages (
        document_id    bigint        NOT NULL,
        -- The version the fingerprint was taken from; 0 for a multi-file
        -- document, whose first constituent stands in for page one.
        version_number smallint      NOT NULL,
        file_id        bigint        NULL,
        page_width     int           NOT NULL,
        page_height    int           NOT NULL,
        -- Which Tesseract segmentation mode read the page. Diagnostic: a page
        -- that only reads at mode 11 is a page the layout analysis gave up on.
        ocr_psm        varchar(4)    NOT NULL,
        word_count     int           NOT NULL,
        char_count     int           NOT NULL,
        -- JSON: the text and layout fingerprints the classifier compares.
        features       nvarchar(max) NOT NULL,
        -- JSON: every recognised word with its box, so the header extractor can
        -- be improved and re-run without another OCR pass.
        words          nvarchar(max) NOT NULL,
        -- JSON: the header fields as read, each with its confidence.
        extracted      nvarchar(max) NOT NULL,
        computed_at    datetime2(3)  NOT NULL CONSTRAINT DF_classification_pages_computed_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_classification_pages PRIMARY KEY (document_id),
        CONSTRAINT FK_classification_pages_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id)
      );
    `.execute(trx);
  },
};
