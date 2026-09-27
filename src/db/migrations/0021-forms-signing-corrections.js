import { sql } from 'kysely';

/**
 * Corrections to 0019 and 0020, made after a design review and before either
 * feature shipped anywhere.
 *
 * ─── Why a new migration rather than an edit ────────────────────────────────
 *
 * Both earlier migrations had already run on the development and test
 * databases when the review landed, and the runner refuses an applied
 * migration whose body has changed — history is not edited here, even
 * unreleased history. So the corrections travel as their own step, and every
 * statement tolerates the table being in either state.
 *
 * ─── What changes ───────────────────────────────────────────────────────────
 *
 *   • form_template_fields.placeholder becomes a binary collation. It is an
 *     identifier matched byte for byte by the template renderer, so {{Name}}
 *     and {{name}} must be two rows and yaa/alef-maqsura variants must not be
 *     unified as they are in prose. It is half the primary key, so the key is
 *     dropped and rebuilt around it.
 *   • form_templates gains default_folder_id: where the fill screen proposes
 *     to file the letter. Advisory — filing stays a folder-permission matter.
 *   • document_signatures.pages_json becomes nvarchar(max): initialling every
 *     page of a long contract is the normal case, and the ledger row must
 *     never fail after the signed version has already been committed.
 *   • document_signatures gains from_sha256 and sha256: the recorded hashes
 *     of the version that was signed and the version that resulted, so the
 *     ledger answers "which bytes" without a join a restore could break.
 */
export const m0021FormsSigningCorrections = {
  id: '0021',
  name: 'forms and signing corrections from the design review',

  async up(trx) {
    // Binary collation on the placeholder identifier. The primary key holds
    // the column, so it goes first and comes back after.
    await sql`
      IF EXISTS (
        SELECT 1 FROM sys.columns c
         WHERE c.object_id = OBJECT_ID('dbo.form_template_fields')
           AND c.name = 'placeholder'
           AND c.collation_name <> 'Latin1_General_BIN2'
      )
      BEGIN
        ALTER TABLE dbo.form_template_fields DROP CONSTRAINT PK_form_template_fields;
        ALTER TABLE dbo.form_template_fields
          ALTER COLUMN placeholder nvarchar(100) COLLATE Latin1_General_BIN2 NOT NULL;
        ALTER TABLE dbo.form_template_fields
          ADD CONSTRAINT PK_form_template_fields PRIMARY KEY (template_id, placeholder);
      END
    `.execute(trx);

    await sql`
      IF COL_LENGTH('dbo.form_templates', 'default_folder_id') IS NULL
        ALTER TABLE dbo.form_templates ADD default_folder_id bigint NULL;
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_form_templates_folder')
        ALTER TABLE dbo.form_templates
          ADD CONSTRAINT FK_form_templates_folder FOREIGN KEY (default_folder_id)
            REFERENCES dbo.folders(folder_id);
    `.execute(trx);

    // COL_LENGTH reports -1 for (max) and the byte length otherwise.
    await sql`
      IF COL_LENGTH('dbo.document_signatures', 'pages_json') <> -1
        ALTER TABLE dbo.document_signatures ALTER COLUMN pages_json nvarchar(max) NOT NULL;
    `.execute(trx);

    await sql`
      IF COL_LENGTH('dbo.document_signatures', 'from_sha256') IS NULL
        ALTER TABLE dbo.document_signatures ADD from_sha256 char(64) NULL;
    `.execute(trx);

    await sql`
      IF COL_LENGTH('dbo.document_signatures', 'sha256') IS NULL
        ALTER TABLE dbo.document_signatures ADD sha256 char(64) NULL;
    `.execute(trx);
  },
};
