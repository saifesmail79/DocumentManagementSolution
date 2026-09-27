import { sql } from 'kysely';

/**
 * Ink signatures (التوقيع) — phase 4 of the correspondence plan.
 *
 * ─── The shape, and why ─────────────────────────────────────────────────────
 *
 * A signature is strokes drawn on a page and flattened into the PDF as a NEW
 * VERSION of the document. The stored bytes of every earlier version stay
 * exactly what they were, so the recorded SHA-256 of each version keeps
 * telling the truth, and "what did this letter look like before it was
 * signed" is answered by the version history rather than by trust.
 *
 * This table is the ledger beside that: who signed, when, which version
 * carries the ink and which pages were touched. The audit log records the
 * same event, but a records office wants to list a document's signatures
 * without filtering an audit trail, and a version comment cannot be queried.
 *
 * It is a facsimile with an audit trail, not a cryptographic signature: the
 * page shows a drawing, and this row plus the version history say who drew it.
 */
export const m0020DocumentSignatures = {
  id: '0020',
  name: 'ink signatures ledger',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.document_signatures', 'U') IS NULL
      CREATE TABLE dbo.document_signatures (
        signature_id    bigint        IDENTITY(1,1) NOT NULL,
        document_id     bigint        NOT NULL,
        -- The version that carries the ink (the one addVersion created).
        version_number  smallint      NOT NULL,
        signed_by       bigint        NOT NULL,
        signed_at       datetime2(3)  NOT NULL CONSTRAINT DF_document_signatures_signed DEFAULT SYSUTCDATETIME(),
        -- JSON array of 1-based page numbers that received strokes, e.g. [1,3].
        pages_json      nvarchar(200) NOT NULL,
        note            nvarchar(500) COLLATE Arabic_CI_AI NULL,
        CONSTRAINT PK_document_signatures PRIMARY KEY (signature_id),
        CONSTRAINT FK_document_signatures_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_document_signatures_signer FOREIGN KEY (signed_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_document_signatures_document')
        CREATE INDEX IX_document_signatures_document ON dbo.document_signatures (document_id, signed_at);
    `.execute(trx);
  },
};
