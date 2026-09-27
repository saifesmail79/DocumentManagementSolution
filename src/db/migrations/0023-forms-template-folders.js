import { sql } from 'kysely';

/**
 * A letter format is assigned to the folders its letters may be filed into.
 *
 * ─── What changes, and why ──────────────────────────────────────────────────
 *
 * 0019/0021 gave a template one advisory default folder. The institute's
 * question was different: an official format belongs to particular places —
 * the outgoing-letters folder of each department that may use it — and a
 * letter written on it must land in one of those, not wherever the writer
 * happens to hold upload permission. So the single default becomes a list,
 * and the list is a rule: while it is non-empty the fill screen offers only
 * those folders and the server refuses any other. An empty list keeps the
 * earlier behaviour (any folder the person may upload into), so nothing
 * already configured changes meaning.
 *
 * The old default is carried into the list as its only entry, then the
 * column is dropped: two places for the same fact is how they drift apart.
 * The copy runs as dynamic SQL because a column named in a plain statement
 * must exist at compile time, even inside an IF that would skip it.
 */
export const m0023FormsTemplateFolders = {
  id: '0023',
  name: 'letter formats assigned to folders',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.form_template_folders', 'U') IS NULL
      CREATE TABLE dbo.form_template_folders (
        template_id  int     NOT NULL,
        folder_id    bigint  NOT NULL,
        CONSTRAINT PK_form_template_folders PRIMARY KEY (template_id, folder_id),
        CONSTRAINT FK_form_template_folders_template FOREIGN KEY (template_id)
          REFERENCES dbo.form_templates(template_id),
        CONSTRAINT FK_form_template_folders_folder FOREIGN KEY (folder_id)
          REFERENCES dbo.folders(folder_id)
      );
    `.execute(trx);

    await sql`
      IF COL_LENGTH('dbo.form_templates', 'default_folder_id') IS NOT NULL
        EXEC('
          INSERT INTO dbo.form_template_folders (template_id, folder_id)
          SELECT t.template_id, t.default_folder_id
            FROM dbo.form_templates t
           WHERE t.default_folder_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM dbo.form_template_folders f
                              WHERE f.template_id = t.template_id AND f.folder_id = t.default_folder_id)
        ');
    `.execute(trx);

    await sql`
      IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_form_templates_folder')
        ALTER TABLE dbo.form_templates DROP CONSTRAINT FK_form_templates_folder;
    `.execute(trx);

    await sql`
      IF COL_LENGTH('dbo.form_templates', 'default_folder_id') IS NOT NULL
        ALTER TABLE dbo.form_templates DROP COLUMN default_folder_id;
    `.execute(trx);
  },
};
