import { sql } from 'kysely';

/**
 * Official letter formats (النماذج) — phase 3 of the correspondence plan.
 *
 * ─── The shape, and why ─────────────────────────────────────────────────────
 *
 * A format is a Word file the institute designed itself, with placeholders
 * written as {{name}}. Word is the form designer: no visual editor is built
 * here, because the institute already knows Word and a template that looks
 * right in Word looks right when LibreOffice prints it. The server merges the
 * values, converts to PDF and files the result through the ordinary document
 * path, so the generated letter is a document like any other from then on.
 *
 * Each template carries its own list of placeholders, discovered from the
 * file when it is uploaded: the Arabic label the form shows, whether the value
 * is one line or many, whether it is required, and optionally which custom
 * field of the template's document type the value is also stored in — so a
 * letter's subject or addressee is searchable metadata, not only ink on a
 * page. Access is a plain principal list (groups or users), the same shape as
 * folder permissions, and templates are deactivated, never deleted, so the
 * letters they produced keep a valid reference.
 *
 * form_letters records which template and which values produced a document.
 * It is the provenance a records office asks for ("which form was this
 * written on?") and what a re-generation would start from.
 */
export const m0019FormsTemplates = {
  id: '0019',
  name: 'letter format templates, their fields, access and provenance',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.form_templates', 'U') IS NULL
      CREATE TABLE dbo.form_templates (
        template_id           int            IDENTITY(1,1) NOT NULL,
        name                  nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        description           nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        -- The .docx blob, relative to the storage root, under templates/.
        storage_path          nvarchar(400)  NOT NULL,
        original_filename     nvarchar(255)  COLLATE Arabic_CI_AI NOT NULL,
        sha256                char(64)       NOT NULL,
        bytes                 bigint         NOT NULL,
        -- The document type a generated letter is filed as; NULL means untyped.
        type_id               int            NULL,
        -- An approval that starts by itself once the letter exists; NULL means none.
        approval_template_id  int            NULL,
        is_active             bit            NOT NULL CONSTRAINT DF_form_templates_active DEFAULT 1,
        created_by            bigint         NOT NULL,
        created_at            datetime2(3)   NOT NULL CONSTRAINT DF_form_templates_created DEFAULT SYSUTCDATETIME(),
        updated_at            datetime2(3)   NOT NULL CONSTRAINT DF_form_templates_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_form_templates PRIMARY KEY (template_id),
        CONSTRAINT FK_form_templates_type FOREIGN KEY (type_id)
          REFERENCES dbo.document_types(type_id),
        CONSTRAINT FK_form_templates_approval FOREIGN KEY (approval_template_id)
          REFERENCES dbo.approval_templates(template_id),
        CONSTRAINT FK_form_templates_creator FOREIGN KEY (created_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.form_template_fields', 'U') IS NULL
      CREATE TABLE dbo.form_template_fields (
        template_id   int            NOT NULL,
        -- The placeholder name as written between the braces in the file.
        placeholder   nvarchar(100)  COLLATE Arabic_CI_AI NOT NULL,
        label         nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        is_multiline  bit            NOT NULL CONSTRAINT DF_form_template_fields_multiline DEFAULT 0,
        is_required   bit            NOT NULL CONSTRAINT DF_form_template_fields_required DEFAULT 0,
        -- date and author are filled by the server and never asked of anyone.
        is_built_in   bit            NOT NULL CONSTRAINT DF_form_template_fields_built_in DEFAULT 0,
        -- Also store the value as this custom field of the template's type.
        field_id      int            NULL,
        sort_order    int            NOT NULL CONSTRAINT DF_form_template_fields_sort DEFAULT 0,
        CONSTRAINT PK_form_template_fields PRIMARY KEY (template_id, placeholder),
        CONSTRAINT FK_form_template_fields_template FOREIGN KEY (template_id)
          REFERENCES dbo.form_templates(template_id),
        CONSTRAINT FK_form_template_fields_field FOREIGN KEY (field_id)
          REFERENCES dbo.custom_field_defs(field_id)
      );
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.form_template_access', 'U') IS NULL
      CREATE TABLE dbo.form_template_access (
        template_id   int     NOT NULL,
        -- A group or a user; groups expand through fn_expand_principals.
        principal_id  bigint  NOT NULL,
        CONSTRAINT PK_form_template_access PRIMARY KEY (template_id, principal_id),
        CONSTRAINT FK_form_template_access_template FOREIGN KEY (template_id)
          REFERENCES dbo.form_templates(template_id),
        CONSTRAINT FK_form_template_access_principal FOREIGN KEY (principal_id)
          REFERENCES dbo.principals(principal_id)
      );
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.form_letters', 'U') IS NULL
      CREATE TABLE dbo.form_letters (
        document_id   bigint         NOT NULL,
        template_id   int            NOT NULL,
        -- { placeholder: value } exactly as merged, for provenance.
        values_json   nvarchar(max)  NOT NULL,
        created_by    bigint         NOT NULL,
        created_at    datetime2(3)   NOT NULL CONSTRAINT DF_form_letters_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_form_letters PRIMARY KEY (document_id),
        CONSTRAINT FK_form_letters_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_form_letters_template FOREIGN KEY (template_id)
          REFERENCES dbo.form_templates(template_id),
        CONSTRAINT FK_form_letters_creator FOREIGN KEY (created_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_form_letters_template')
        CREATE INDEX IX_form_letters_template ON dbo.form_letters (template_id, created_at);
    `.execute(trx);
  },
};
