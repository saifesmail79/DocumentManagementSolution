/**
 * Migration 0007 — widen custom_field_defs.data_type.
 *
 * 0002 declared the column varchar(10), which fitted every type name it knew:
 * text, number, date, bool, choice. 0006 added 'multiselect', which is eleven
 * characters, so the CHECK constraint admitted a value the column could not
 * store and every attempt failed with a truncation error at insert time.
 *
 * A separate migration rather than a correction to 0006 because migrations are
 * append-only: 0006 has already run, and the runner compares checksums and
 * refuses to start if an applied migration changes underneath it. That guard is
 * doing its job here.
 *
 * varchar(20) leaves room for a longer type name without a third migration.
 */

import { sql } from 'kysely';

export const m0007WidenDataType = {
  id: '0007',
  name: 'widen custom_field_defs.data_type for longer type names',

  async up(trx) {
    // The CHECK references the column, so it has to come off before the type
    // changes and go back afterwards.
    await sql`
      ALTER TABLE dbo.custom_field_defs DROP CONSTRAINT CK_custom_field_defs_data_type;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.custom_field_defs ALTER COLUMN data_type varchar(20) NOT NULL;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.custom_field_defs
        ADD CONSTRAINT CK_custom_field_defs_data_type
        CHECK (data_type IN ('text','number','date','bool','choice','multiselect','user'));
    `.execute(trx);
  },
};
