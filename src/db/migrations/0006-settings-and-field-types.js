/**
 * Migration 0006 — runtime settings, and the two remaining field types.
 *
 * ─── Settings ───────────────────────────────────────────────────────────────
 *
 * Everything configurable so far lives in .env, which means every change is a
 * file edit and a restart by someone with a shell on the server. For a system
 * whose administrator is often not its developer, that is the difference between
 * a setting existing and a setting being usable.
 *
 * Only settings that are safe to change at runtime live here. Connection
 * strings, the storage root and the SMTP password stay in .env: they are read
 * once at boot, a bad value must stop the process rather than break it mid-flight,
 * and a database that holds its own connection string cannot be read to find it.
 *
 * ─── Multi-select and user-picker ───────────────────────────────────────────
 *
 * document_field_values holds one row per (document, field), which cannot
 * represent a field with several values at once. Rather than relax that key —
 * it is what makes "exactly one value per field" checkable — multi-select gets
 * its own table. A user-picker is single-valued, so it is one more typed column
 * alongside the others.
 *
 * Adding that column means rebuilding CK_document_field_values_one_value, since
 * a CHECK constraint cannot be altered in place.
 */

import { sql } from 'kysely';

/** Settings the administrator may change without a restart. */
export const SETTING_KEYS = Object.freeze({
  ORGANISATION_NAME: 'organisation.name',
  DEFAULT_LANGUAGE: 'ui.default_language',
  UPLOAD_MAX_BYTES: 'upload.max_bytes',
  UPLOAD_ALLOWED_EXTENSIONS: 'upload.allowed_extensions',
  DUPLICATE_POLICY: 'upload.duplicate_policy',
  PURGE_GRACE_DAYS: 'storage.purge_grace_days',
  SESSION_TTL_HOURS: 'auth.session_ttl_hours',
  MAX_FAILED_LOGINS: 'auth.max_failed_logins',
  LOCKOUT_MINUTES: 'auth.lockout_minutes',
  MIN_PASSWORD_LENGTH: 'auth.min_password_length',
  OCR_ENABLED: 'ocr.enabled',
  EXTRACTION_ENABLED: 'extraction.enabled',
});

export const m0006SettingsAndFieldTypes = {
  id: '0006',
  name: 'runtime settings, multi-select and user-picker fields',

  async up(trx) {
    // ── Settings ─────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.app_settings (
        setting_key   varchar(100)   NOT NULL,
        value         nvarchar(2000) COLLATE Arabic_CI_AI NULL,
        value_type    varchar(10)    NOT NULL,
        updated_at    datetime2(3)   NOT NULL CONSTRAINT DF_app_settings_updated_at DEFAULT SYSUTCDATETIME(),
        updated_by    bigint         NULL,
        CONSTRAINT PK_app_settings PRIMARY KEY (setting_key),
        CONSTRAINT FK_app_settings_user FOREIGN KEY (updated_by) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_app_settings_type CHECK (value_type IN ('string','int','bool','list'))
      );
    `.execute(trx);

    // Seeded with the same defaults the environment uses, so the panel opens
    // showing what is actually in effect rather than a set of blanks.
    const seed = [
      ['organisation.name', 'إدارة الوثائق', 'string'],
      ['ui.default_language', 'ar', 'string'],
      ['upload.max_bytes', '209715200', 'int'],
      ['upload.allowed_extensions', '', 'list'],
      ['upload.duplicate_policy', 'warn', 'string'],
      ['storage.purge_grace_days', '30', 'int'],
      ['auth.session_ttl_hours', '12', 'int'],
      ['auth.max_failed_logins', '5', 'int'],
      ['auth.lockout_minutes', '15', 'int'],
      ['auth.min_password_length', '12', 'int'],
      ['ocr.enabled', 'false', 'bool'],
      ['extraction.enabled', 'true', 'bool'],
    ];

    for (const [key, value, type] of seed) {
      await sql`
        INSERT INTO dbo.app_settings (setting_key, value, value_type)
        VALUES (${key}, ${value}, ${type})
      `.execute(trx);
    }

    // ── User-picker ──────────────────────────────────────────────────────
    await sql`
      ALTER TABLE dbo.document_field_values ADD value_principal_id bigint NULL;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.document_field_values
        ADD CONSTRAINT FK_document_field_values_principal
        FOREIGN KEY (value_principal_id) REFERENCES dbo.principals(principal_id);
    `.execute(trx);

    // A CHECK cannot be altered in place, so the old one goes and a new one
    // covering six columns replaces it. Same rule, one more column.
    await sql`
      ALTER TABLE dbo.document_field_values DROP CONSTRAINT CK_document_field_values_one_value;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.document_field_values
        ADD CONSTRAINT CK_document_field_values_one_value CHECK (
          (CASE WHEN value_text         IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_number       IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_date         IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_bool         IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_choice_id    IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_principal_id IS NULL THEN 0 ELSE 1 END) = 1
        );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_document_field_values_principal
        ON dbo.document_field_values (field_id, value_principal_id)
        INCLUDE (document_id) WHERE value_principal_id IS NOT NULL;
    `.execute(trx);

    // ── Multi-select ─────────────────────────────────────────────────────
    //
    // Its own table rather than relaxing the single-value key, which is what
    // makes "exactly one value per field" checkable for every other type.
    await sql`
      CREATE TABLE dbo.document_field_selections (
        document_id bigint NOT NULL,
        field_id    int    NOT NULL,
        choice_id   int    NOT NULL,
        CONSTRAINT PK_document_field_selections PRIMARY KEY (document_id, field_id, choice_id),
        CONSTRAINT FK_dfs_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_dfs_field    FOREIGN KEY (field_id)    REFERENCES dbo.custom_field_defs(field_id),
        CONSTRAINT FK_dfs_choice   FOREIGN KEY (choice_id)   REFERENCES dbo.custom_field_choices(choice_id)
      );
    `.execute(trx);

    // "Which documents have this option selected" — the filter direction.
    await sql`
      CREATE INDEX IX_dfs_choice ON dbo.document_field_selections (choice_id) INCLUDE (document_id);
    `.execute(trx);

    // The data_type CHECK is likewise rebuilt to admit the two new types.
    await sql`
      ALTER TABLE dbo.custom_field_defs DROP CONSTRAINT CK_custom_field_defs_data_type;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.custom_field_defs
        ADD CONSTRAINT CK_custom_field_defs_data_type
        CHECK (data_type IN ('text','number','date','bool','choice','multiselect','user'));
    `.execute(trx);

    // ── Restore, for the recycle bin ─────────────────────────────────────
    //
    // Who deleted a document is already recorded; who restored it was not, and
    // "this came back and nobody knows who did it" is exactly the question an
    // audit gets asked.
    await sql`
      ALTER TABLE dbo.documents ADD restored_at datetime2(3) NULL, restored_by bigint NULL;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.documents
        ADD CONSTRAINT FK_documents_restorer FOREIGN KEY (restored_by) REFERENCES dbo.users(user_id);
    `.execute(trx);

    // The recycle bin lists deleted documents newest-first, so it gets its own
    // filtered index rather than scanning a table that is mostly live rows.
    await sql`
      CREATE INDEX IX_documents_deleted
        ON dbo.documents (deleted_at DESC)
        INCLUDE (folder_id, title, deleted_by, current_version)
        WHERE is_deleted = 1;
    `.execute(trx);

    // ── Duplicate detection ──────────────────────────────────────────────
    //
    // The hash index from 0002 covers lookup by content, but a duplicate check
    // runs on every upload and only ever asks about live documents.
    await sql`
      CREATE INDEX IX_document_versions_sha256_live
        ON dbo.document_versions (sha256)
        INCLUDE (document_id, version_number, file_size_bytes, uploaded_at);
    `.execute(trx);
  },
};
