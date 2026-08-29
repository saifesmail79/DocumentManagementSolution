/**
 * Migration 0002 — documents, versions, document types and typed metadata.
 *
 * 0001 defined who may do what, and where. This defines what is actually filed.
 *
 * ─── Divergences from docs/schema-design-inputs.md ──────────────────────────
 *
 * That document is raw design input produced before 0001 was written, and 0001
 * reshaped the model. The differences below are deliberate, not oversights:
 *
 *   • The draft references filing_nodes(node_id) and INT keys. The tree that
 *     shipped is folders(folder_id) with bigint keys throughout.
 *
 *   • The draft stores the file path as VARCHAR(4000). That path contains the
 *     sanitised document title, which is Arabic — and tedious sends a JS string
 *     as VARCHAR in some paths, where a multi-byte character is measured by
 *     character count against a server expecting bytes. Every path column here is
 *     NVARCHAR. This is the single most expensive mistake available in this
 *     schema, because it corrupts silently and only for Arabic titles.
 *
 *   • The draft collates text as Arabic_100_CI_AI_SC. 0001 and the database
 *     itself use Arabic_CI_AI; mixing the two produces collation-conflict errors
 *     the moment a temp table joins a base table. Consistency wins.
 *
 *   • The draft carries a `status` column for pending/active/upload_failed. The
 *     storage driver writes the file, fsyncs it, renames it atomically and only
 *     THEN commits the row, so a committed document always has a durable file and
 *     there is no pending state to represent. An interrupted upload leaves an
 *     orphaned blob, which the sweep removes. Soft deletion uses the same
 *     is_deleted + deleted_at pair as folders.
 *
 * ─── Typed metadata: why not JSON, and why not plain EAV ────────────────────
 *
 * Metadata fields are admin-defined, because this system is not built for one
 * sector and the field set differs per deployment. That rules out fixed columns.
 *
 * SQL Server 2019 has no native json type (that is 2025), so a JSON column would
 * need PERSISTED computed columns per field to be indexable — which reintroduces
 * a schema change per field, the thing being avoided.
 *
 * Classic EAV with one nvarchar value column makes every filter a string
 * comparison: "invoices over 5,000" and "contracts signed before March" become
 * full scans with wrong ordering. So document_field_values keeps one column per
 * data type, with a CHECK that exactly one is populated. Each is separately
 * indexable and compares with correct type semantics, and adding a field stays
 * pure data.
 */

import { sql } from 'kysely';

/** Field data types. The value lands in the matching column of document_field_values. */
export const FIELD_TYPE = Object.freeze({
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
  BOOL: 'bool',
  CHOICE: 'choice',
});

export const m0002DocumentsAndMetadata = {
  id: '0002',
  name: 'documents, versions, types and typed metadata',

  async up(trx) {
    // ─────────────────────────────────────────────────────────────────────
    // Document types — admin-defined, not an enum.
    //
    // "All sectors, not government-specific" means the type list is data. A
    // hardcoded enum would need a migration per customer.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.document_types (
        type_id      int            IDENTITY(1,1) NOT NULL,
        name         nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        description  nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        is_active    bit            NOT NULL CONSTRAINT DF_document_types_is_active DEFAULT 1,
        sort_order   int            NOT NULL CONSTRAINT DF_document_types_sort_order DEFAULT 0,
        created_at   datetime2(3)   NOT NULL CONSTRAINT DF_document_types_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_document_types PRIMARY KEY (type_id),
        CONSTRAINT UQ_document_types_name UNIQUE (name)
      );
    `.execute(trx);

    // Sensitivity labels are also data. The reported requirement was explicitly
    // NOT to hardcode Public/Internal/Confidential/Restricted, because the label
    // set is one of the things that differs most between sectors.
    //
    // severity_rank orders them so a query can ask "at or above Confidential"
    // without knowing the deployment's names. Named that way because RANK is a
    // reserved word in T-SQL and would need bracketing at every use site.
    await sql`
      CREATE TABLE dbo.sensitivity_labels (
        label_id    int            IDENTITY(1,1) NOT NULL,
        name        nvarchar(100)  COLLATE Arabic_CI_AI NOT NULL,
        severity_rank smallint     NOT NULL,
        colour      varchar(7)     NULL,
        is_active   bit            NOT NULL CONSTRAINT DF_sensitivity_labels_is_active DEFAULT 1,
        created_at  datetime2(3)   NOT NULL CONSTRAINT DF_sensitivity_labels_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_sensitivity_labels PRIMARY KEY (label_id),
        CONSTRAINT UQ_sensitivity_labels_name UNIQUE (name),
        CONSTRAINT UQ_sensitivity_labels_rank UNIQUE (severity_rank),
        CONSTRAINT CK_sensitivity_labels_colour CHECK (colour IS NULL OR colour LIKE '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')
      );
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Custom field definitions.
    //
    // type_id NULL means the field applies to every document type — the common
    // case for things like Reference Number or Department.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.custom_field_defs (
        field_id      int            IDENTITY(1,1) NOT NULL,
        type_id       int            NULL,
        name          nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        data_type     varchar(10)    NOT NULL,
        is_required   bit            NOT NULL CONSTRAINT DF_custom_field_defs_required DEFAULT 0,
        is_searchable bit            NOT NULL CONSTRAINT DF_custom_field_defs_searchable DEFAULT 1,
        sort_order    int            NOT NULL CONSTRAINT DF_custom_field_defs_sort_order DEFAULT 0,
        is_active     bit            NOT NULL CONSTRAINT DF_custom_field_defs_is_active DEFAULT 1,
        created_at    datetime2(3)   NOT NULL CONSTRAINT DF_custom_field_defs_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_custom_field_defs PRIMARY KEY (field_id),
        CONSTRAINT FK_custom_field_defs_type FOREIGN KEY (type_id) REFERENCES dbo.document_types(type_id),
        CONSTRAINT CK_custom_field_defs_data_type
          CHECK (data_type IN ('text','number','date','bool','choice'))
      );
    `.execute(trx);

    // A field name must be unique within its type. Two NULLs are distinct under a
    // plain UNIQUE constraint, so global fields need a filtered unique index to be
    // constrained at all — without this, "Department" could be defined twice.
    await sql`
      CREATE UNIQUE INDEX UX_custom_field_defs_type_name
        ON dbo.custom_field_defs (type_id, name) WHERE type_id IS NOT NULL;
    `.execute(trx);

    await sql`
      CREATE UNIQUE INDEX UX_custom_field_defs_global_name
        ON dbo.custom_field_defs (name) WHERE type_id IS NULL;
    `.execute(trx);

    // Options for data_type = 'choice'. Kept as rows rather than a delimited
    // string so a value can reference one by id and renaming an option does not
    // rewrite every document that uses it.
    await sql`
      CREATE TABLE dbo.custom_field_choices (
        choice_id   int            IDENTITY(1,1) NOT NULL,
        field_id    int            NOT NULL,
        label       nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        sort_order  int            NOT NULL CONSTRAINT DF_custom_field_choices_sort_order DEFAULT 0,
        is_active   bit            NOT NULL CONSTRAINT DF_custom_field_choices_is_active DEFAULT 1,
        CONSTRAINT PK_custom_field_choices PRIMARY KEY (choice_id),
        CONSTRAINT FK_custom_field_choices_field FOREIGN KEY (field_id)
          REFERENCES dbo.custom_field_defs(field_id),
        CONSTRAINT UQ_custom_field_choices_label UNIQUE (field_id, label)
      );
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Documents.
    //
    // A document has no ACL of its own — 0001 attaches permissions to folders
    // only, so a document's permission is its folder's permission. Moving a
    // document between folders therefore changes its permissions, which is the
    // behaviour users expect from a filing cabinet.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.documents (
        document_id          bigint         IDENTITY(1,1) NOT NULL,
        folder_id            bigint         NOT NULL,
        type_id              int            NULL,
        sensitivity_label_id int            NULL,
        title                nvarchar(500)  COLLATE Arabic_CI_AI NOT NULL,
        -- Denormalised pointer to the newest row in document_versions. Maintained
        -- in the same transaction as the version insert, so it cannot drift. It
        -- exists to keep folder listing off a MAX() subquery per row.
        current_version      smallint       NOT NULL CONSTRAINT DF_documents_current_version DEFAULT 0,
        is_deleted           bit            NOT NULL CONSTRAINT DF_documents_is_deleted DEFAULT 0,
        deleted_at           datetime2(3)   NULL,
        deleted_by           bigint         NULL,
        created_by           bigint         NOT NULL,
        created_at           datetime2(3)   NOT NULL CONSTRAINT DF_documents_created_at DEFAULT SYSUTCDATETIME(),
        updated_by           bigint         NULL,
        updated_at           datetime2(3)   NOT NULL CONSTRAINT DF_documents_updated_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_documents PRIMARY KEY (document_id),
        CONSTRAINT FK_documents_folder  FOREIGN KEY (folder_id) REFERENCES dbo.folders(folder_id),
        CONSTRAINT FK_documents_type    FOREIGN KEY (type_id)   REFERENCES dbo.document_types(type_id),
        CONSTRAINT FK_documents_label   FOREIGN KEY (sensitivity_label_id)
          REFERENCES dbo.sensitivity_labels(label_id),
        CONSTRAINT FK_documents_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_documents_updater FOREIGN KEY (updated_by) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_documents_deleter FOREIGN KEY (deleted_by) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_documents_deleted_pair
          CHECK ((is_deleted = 0 AND deleted_at IS NULL) OR (is_deleted = 1 AND deleted_at IS NOT NULL))
      );
    `.execute(trx);

    // The hot path: list one folder, newest first, excluding deleted. Filtered so
    // the index holds only live rows, and covering so the listing never touches
    // the base table.
    await sql`
      CREATE INDEX IX_documents_folder_created
        ON dbo.documents (folder_id, created_at DESC)
        INCLUDE (title, type_id, sensitivity_label_id, current_version, updated_at)
        WHERE is_deleted = 0;
    `.execute(trx);

    // Title search within the permitted folder set, used by the attribute search
    // that must work whether or not full-text indexing is available.
    await sql`
      CREATE INDEX IX_documents_title
        ON dbo.documents (title) INCLUDE (folder_id, type_id) WHERE is_deleted = 0;
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Versions.
    //
    // Immutable: a new upload is a new row, never an overwrite. storage_path is
    // the path RELATIVE to config.storage.root, exactly what buildRelativePath()
    // returns — storing an absolute path would break the moment the NAS mount
    // point or drive letter changes, which is precisely what a configurable
    // storage root is meant to allow.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.document_versions (
        version_id      bigint         IDENTITY(1,1) NOT NULL,
        document_id     bigint         NOT NULL,
        version_number  smallint       NOT NULL,
        -- NVARCHAR: this contains the sanitised Arabic title. See the header.
        storage_path    nvarchar(1000) NOT NULL,
        original_filename nvarchar(400) COLLATE Arabic_CI_AI NULL,
        file_size_bytes bigint         NOT NULL,
        sha256          char(64)       COLLATE Latin1_General_BIN2 NOT NULL,
        mime_type       varchar(150)   NOT NULL CONSTRAINT DF_document_versions_mime DEFAULT 'application/octet-stream',
        comment         nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        uploaded_by     bigint         NOT NULL,
        uploaded_at     datetime2(3)   NOT NULL CONSTRAINT DF_document_versions_uploaded_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_document_versions PRIMARY KEY (document_id, version_number),
        CONSTRAINT FK_document_versions_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_document_versions_uploader FOREIGN KEY (uploaded_by)
          REFERENCES dbo.users(user_id),
        CONSTRAINT UQ_document_versions_id UNIQUE (version_id),
        -- Two rows must never claim the same file. A duplicate here means a bug
        -- in path construction, and the alternative is two documents silently
        -- sharing one blob and a delete taking out both.
        CONSTRAINT UQ_document_versions_path UNIQUE (storage_path),
        CONSTRAINT CK_document_versions_number CHECK (version_number >= 1),
        CONSTRAINT CK_document_versions_size CHECK (file_size_bytes > 0)
      );
    `.execute(trx);

    // Integrity sweeps and orphan detection walk by hash.
    await sql`
      CREATE INDEX IX_document_versions_sha256
        ON dbo.document_versions (sha256) INCLUDE (document_id, version_number, file_size_bytes);
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Metadata values — one column per data type, exactly one populated.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.document_field_values (
        document_id     bigint          NOT NULL,
        field_id        int             NOT NULL,
        value_text      nvarchar(1000)  COLLATE Arabic_CI_AI NULL,
        value_number    decimal(38,10)  NULL,
        value_date      datetime2(3)    NULL,
        value_bool      bit             NULL,
        value_choice_id int             NULL,
        updated_at      datetime2(3)    NOT NULL CONSTRAINT DF_document_field_values_updated_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_document_field_values PRIMARY KEY (document_id, field_id),
        CONSTRAINT FK_document_field_values_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_document_field_values_field FOREIGN KEY (field_id)
          REFERENCES dbo.custom_field_defs(field_id),
        CONSTRAINT FK_document_field_values_choice FOREIGN KEY (value_choice_id)
          REFERENCES dbo.custom_field_choices(choice_id),
        -- Exactly one value column carries data. Without this the table degrades
        -- into "whichever column the last writer happened to fill".
        CONSTRAINT CK_document_field_values_one_value CHECK (
          (CASE WHEN value_text      IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_number    IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_date      IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_bool      IS NULL THEN 0 ELSE 1 END
         + CASE WHEN value_choice_id IS NULL THEN 0 ELSE 1 END) = 1
        )
      );
    `.execute(trx);

    // One index per value column, filtered to rows that use it. "All invoices over
    // 5,000" and "contracts dated before March" are index seeks with correct type
    // ordering — the thing a single nvarchar value column cannot do.
    await sql`
      CREATE INDEX IX_document_field_values_text
        ON dbo.document_field_values (field_id, value_text)
        INCLUDE (document_id) WHERE value_text IS NOT NULL;
    `.execute(trx);

    await sql`
      CREATE INDEX IX_document_field_values_number
        ON dbo.document_field_values (field_id, value_number)
        INCLUDE (document_id) WHERE value_number IS NOT NULL;
    `.execute(trx);

    await sql`
      CREATE INDEX IX_document_field_values_date
        ON dbo.document_field_values (field_id, value_date)
        INCLUDE (document_id) WHERE value_date IS NOT NULL;
    `.execute(trx);

    await sql`
      CREATE INDEX IX_document_field_values_choice
        ON dbo.document_field_values (field_id, value_choice_id)
        INCLUDE (document_id) WHERE value_choice_id IS NOT NULL;
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Tags — a flat, user-driven cross-cutting label, separate from the
    // admin-defined type/field system.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.tags (
        tag_id     int            IDENTITY(1,1) NOT NULL,
        name       nvarchar(100)  COLLATE Arabic_CI_AI NOT NULL,
        created_at datetime2(3)   NOT NULL CONSTRAINT DF_tags_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_tags PRIMARY KEY (tag_id),
        CONSTRAINT UQ_tags_name UNIQUE (name)
      );
    `.execute(trx);

    await sql`
      CREATE TABLE dbo.document_tags (
        document_id bigint NOT NULL,
        tag_id      int    NOT NULL,
        CONSTRAINT PK_document_tags PRIMARY KEY (document_id, tag_id),
        CONSTRAINT FK_document_tags_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_document_tags_tag FOREIGN KEY (tag_id) REFERENCES dbo.tags(tag_id)
      );
    `.execute(trx);

    // Reverse lookup: "which documents carry this tag".
    await sql`
      CREATE INDEX IX_document_tags_tag ON dbo.document_tags (tag_id) INCLUDE (document_id);
    `.execute(trx);
  },
};
