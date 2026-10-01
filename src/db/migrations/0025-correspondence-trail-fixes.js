import { sql } from 'kysely';

/**
 * Corrections to 0024, made after a design review and before the paper trail
 * shipped anywhere.
 *
 * ─── Why a new migration rather than an edit ────────────────────────────────
 *
 * 0024 had already run on the development and test databases when the review
 * landed, and the runner refuses an applied migration whose body has changed.
 * So the corrections travel as their own step, and every statement tolerates
 * the schema being in either state.
 *
 * ─── What changes, and why ──────────────────────────────────────────────────
 *
 *   • FK_correspondence_version_actions_version is DROPPED.
 *
 *     It pointed at dbo.document_versions(document_id, version_number) with no
 *     cascade, and nothing ever deletes a trail row. That made it the one
 *     constraint in the schema capable of jamming the storage purge sweep
 *     forever: the sweep deletes the version row of a binned document
 *     (storage-maintenance/purge.js), the FK refuses, the whole purge
 *     transaction rolls back, and the bytes are never reclaimed — for every
 *     document that was ever a letter, on this sweep and every sweep after it,
 *     with «الوارد والصادر» switched off as well, because the trail rows
 *     outlive the switch.
 *
 *     document_id/version_number stay as plain columns, exactly as
 *     dbo.document_signatures stores them, and FK_correspondence_version_actions_letter
 *     keeps the integrity that matters. A trail entry whose bytes were purged
 *     is a TOMBSTONE: «في ٣ أيلول عاد الكتاب مهمّشاً من د. حسين» is worth
 *     keeping after the scan itself has been destroyed, and the core purge
 *     must stay completely ignorant of correspondence.
 *
 *     The UNIQUE (document_id, version_number) stays — one act per version is
 *     what makes the trail readable — as do the letter and recorder keys.
 *
 *   • correspondence gains reply_to_id: «رد على الوارد …» owned by the
 *     register itself.
 *
 *     The link used to live only in dbo.document_relations, a generic table
 *     whose DELETE route took any relation id from any signed-in user. So
 *     «مُجاب» — a statement about the official book — could be forged or
 *     erased by anybody, unaudited. A register fact belongs to the register.
 *     The core relation is still written for the document page's «مرتبطة»
 *     list, but it is now DISPLAY ONLY: nothing in the register reads it.
 *
 *   • correspondence_movements.note widens to nvarchar(1000), matching the
 *     trail's own note and what the hand-over dialog already accepts. A note
 *     silently cut in half is worse than one refused.
 */
export const m0025CorrespondenceTrailFixes = {
  id: '0025',
  name: 'correspondence trail fixes: purge-safe trail, register-owned reply link, wider note',

  async up(trx) {
    // ── The trail must survive a purge ───────────────────────────────────
    await sql`
      IF EXISTS (
        SELECT 1 FROM sys.foreign_keys
         WHERE name = 'FK_correspondence_version_actions_version'
           AND parent_object_id = OBJECT_ID('dbo.correspondence_version_actions')
      )
        ALTER TABLE dbo.correspondence_version_actions
          DROP CONSTRAINT FK_correspondence_version_actions_version;
    `.execute(trx);

    // ── The reply link, owned by the register ────────────────────────────
    await sql`
      IF COL_LENGTH('dbo.correspondence', 'reply_to_id') IS NULL
        ALTER TABLE dbo.correspondence ADD reply_to_id bigint NULL;
    `.execute(trx);

    // A self-reference: an outgoing letter points at the incoming one it
    // answers. Nullable, because most letters answer nothing, and NO ACTION on
    // delete because the register never deletes a row — an annulled entry is
    // struck through in place and keeps its number.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_correspondence_reply_to')
        ALTER TABLE dbo.correspondence
          ADD CONSTRAINT FK_correspondence_reply_to FOREIGN KEY (reply_to_id)
            REFERENCES dbo.correspondence(correspondence_id);
    `.execute(trx);

    // Filtered: the question is always «ما الصادر الذي أجاب هذا الوارد؟», and
    // the overwhelming majority of rows answer nothing at all.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_correspondence_reply_to')
        CREATE INDEX IX_correspondence_reply_to ON dbo.correspondence (reply_to_id)
          INCLUDE (direction, status)
          WHERE reply_to_id IS NOT NULL;
    `.execute(trx);

    /*
     * Backfill from the relations already written by the pilot: an outgoing
     * letter whose document is the FROM end of a 'reply_to' relation whose TO
     * end is an incoming letter. Anything else in that table was never a
     * register link and must not become one. Oldest relation wins, so a
     * document carrying two of them backfills deterministically, and
     * `reply_to_id IS NULL` keeps the step re-runnable.
     */
    await sql`
      IF COL_LENGTH('dbo.correspondence', 'reply_to_id') IS NOT NULL
        UPDATE c
           SET reply_to_id = answered.correspondence_id
          FROM dbo.correspondence c
         CROSS APPLY (
           SELECT TOP (1) target.correspondence_id
             FROM dbo.document_relations r
             JOIN dbo.correspondence target
               ON target.document_id = r.to_document AND target.direction = 'in'
            WHERE r.from_document = c.document_id
              AND r.relation_type = 'reply_to'
            ORDER BY r.created_at, r.relation_id
         ) answered
         WHERE c.direction = 'out' AND c.reply_to_id IS NULL;
    `.execute(trx);

    // ── The custody note, as wide as the trail's own ─────────────────────
    // COL_LENGTH reports bytes: nvarchar(500) is 1000, nvarchar(1000) is 2000.
    await sql`
      IF COL_LENGTH('dbo.correspondence_movements', 'note') < 2000
        ALTER TABLE dbo.correspondence_movements
          ALTER COLUMN note nvarchar(1000) COLLATE Arabic_CI_AI NULL;
    `.execute(trx);
  },
};
