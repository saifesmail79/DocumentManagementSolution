import { sql } from 'kysely';

/**
 * The paper trail (رحلة الورقة) — the physical journey of a registered letter.
 *
 * ─── The shape, and why ─────────────────────────────────────────────────────
 *
 * A paper letter does not stand still. It is scanned and registered, then it
 * travels: to the deputy for initials, to the director who writes his
 * instruction (التهميش), back up again when the instruction changes, and
 * between departments — and each trip may be rescanned. All of those scans are
 * the SAME letter, so each one is added as a NEW VERSION of the letter's
 * existing document through the core version mechanism. Never a new document:
 * a second document would spend a second book number, split the search hits,
 * and leave «أين كتاب ٤٨٣؟» with two answers.
 *
 * What the core version row cannot say is WHAT WAS DONE on the paper, so this
 * module says it beside the version, in `correspondence_version_actions`: one
 * row per version, naming the act (تهميش / توقيع / إعادة مسح …), optionally
 * the person who acted on it — free text, because the director need not be a
 * system user — and a note.
 *
 * The same words are ALSO written into the core version's `comment`. That
 * duplication is deliberate and is the whole isolation story: with the
 * correspondence area switched off at the master setting, the ordinary version
 * list still reads «تهميش — د. حسين: الموارد البشرية للإجراء» and nothing in
 * the core ever reads the table below.
 *
 * ─── Where the paper is ─────────────────────────────────────────────────────
 *
 * `correspondence_movements` is the custody log: 'out' (سُلّمت الورقة إلى …)
 * and 'back' (عادت الورقة من …), by name, in order. The current location is
 * simply the latest row — 'out' means the paper is with that person since
 * then, 'back' or no rows at all means it is in the mail room. A derived
 * answer rather than a stored `location` column, because a stored one would
 * have to be kept true by every path that writes a movement, and the log has
 * to be written anyway for «مرّ بأي يد؟» to be answerable later.
 *
 * Nothing here is mandatory and nothing blocks routing: the clerk records what
 * she knows, and a letter with no movements at all behaves exactly as it did
 * before this migration.
 */
export const m0024CorrespondencePaperTrail = {
  id: '0024',
  name: 'correspondence paper trail: version actions and paper movements',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.correspondence_version_actions', 'U') IS NULL
      CREATE TABLE dbo.correspondence_version_actions (
        action_id         bigint         IDENTITY(1,1) NOT NULL,
        correspondence_id bigint         NOT NULL,
        -- The version this act produced. Both halves of the key are stored so
        -- the FK can point at the version row itself: a trail entry that
        -- outlived its version would describe a scan nobody can open.
        document_id       bigint         NOT NULL,
        version_number    smallint       NOT NULL,
        -- 'received' (كما ورد) is written by the register itself when an
        -- incoming letter is entered in the book; the other four are what a
        -- human says happened to the paper afterwards.
        action            varchar(12)    NOT NULL,
        -- Free text, NOT a user reference: the director, the deputy and the
        -- messenger are named on the paper, and most of them will never have an
        -- account in this system. A nullable FK to users would quietly turn
        -- "who actually wrote the تهميش" into "which account uploaded it".
        person_name       nvarchar(200)  COLLATE Arabic_CI_AI NULL,
        note              nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        recorded_by       bigint         NOT NULL,
        recorded_at       datetime2(3)   NOT NULL
          CONSTRAINT DF_correspondence_version_actions_recorded DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_correspondence_version_actions PRIMARY KEY (action_id),
        -- One act per version. Two rows naming the same scan differently would
        -- make the trail unreadable in exactly the place it is meant to be read.
        CONSTRAINT UQ_correspondence_version_actions_version UNIQUE (document_id, version_number),
        CONSTRAINT CK_correspondence_version_actions_action CHECK (
          action IN ('received', 'instruction', 'endorsement', 'rescan', 'other')
        ),
        CONSTRAINT FK_correspondence_version_actions_letter FOREIGN KEY (correspondence_id)
          REFERENCES dbo.correspondence(correspondence_id),
        CONSTRAINT FK_correspondence_version_actions_version FOREIGN KEY (document_id, version_number)
          REFERENCES dbo.document_versions(document_id, version_number),
        CONSTRAINT FK_correspondence_version_actions_recorder FOREIGN KEY (recorded_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    // The trail is always read whole, for one letter, in version order.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_correspondence_version_actions_letter')
        CREATE INDEX IX_correspondence_version_actions_letter
          ON dbo.correspondence_version_actions (correspondence_id, version_number);
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.correspondence_movements', 'U') IS NULL
      CREATE TABLE dbo.correspondence_movements (
        movement_id       bigint        IDENTITY(1,1) NOT NULL,
        correspondence_id bigint        NOT NULL,
        kind              varchar(4)    NOT NULL,
        -- NOT NULL, unlike the trail's person: a custody entry that does not say
        -- whose hands the paper is in records nothing at all.
        person_name       nvarchar(200) COLLATE Arabic_CI_AI NOT NULL,
        note              nvarchar(500) COLLATE Arabic_CI_AI NULL,
        recorded_by       bigint        NOT NULL,
        recorded_at       datetime2(3)  NOT NULL
          CONSTRAINT DF_correspondence_movements_recorded DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_correspondence_movements PRIMARY KEY (movement_id),
        CONSTRAINT CK_correspondence_movements_kind CHECK (kind IN ('out', 'back')),
        CONSTRAINT FK_correspondence_movements_letter FOREIGN KEY (correspondence_id)
          REFERENCES dbo.correspondence(correspondence_id),
        CONSTRAINT FK_correspondence_movements_recorder FOREIGN KEY (recorded_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    // "Where is it now" is the newest row for one letter, and the register list
    // asks it for a whole page of letters at once.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_correspondence_movements_letter')
        CREATE INDEX IX_correspondence_movements_letter
          ON dbo.correspondence_movements (correspondence_id, recorded_at)
          INCLUDE (kind, person_name);
    `.execute(trx);
  },
};
