import { sql } from 'kysely';

/**
 * Correspondence (الوارد والصادر) — phase 1, the manual mail-room process.
 *
 * ─── The shape, and why ─────────────────────────────────────────────────────
 *
 * A letter is an ordinary document plus a register entry. The document is
 * scanned, uploaded and filed exactly as any other document — this module never
 * touches the upload path — and the register row gives it what a mail room
 * needs: a book number, an external party, a status, and a routing history.
 *
 * Routing follows the pattern every serious correspondence system uses: the
 * document is filed once and NEVER moves; forwarding a letter to a department
 * writes a transfer row referencing it. That is what makes circulars possible
 * (one letter, five destinations, five independent statuses) and what keeps
 * the متابعة question — "where is letter 483/2026 now?" — answerable forever.
 *
 * A "department" here is a unit: a name, the group whose members act for it,
 * and optionally a folder where its finished letters are archived. Units are
 * deliberately not an org chart — no hierarchy, no positions, no sync.
 *
 * ─── Numbering ──────────────────────────────────────────────────────────────
 *
 * One counter per (direction, year): the paper وارد and صادر books. The number
 * is taken inside the registration transaction, so two clerks registering at
 * once cannot draw the same number. `next_number` can be set forward by an
 * administrator to continue an existing paper book mid-year; it can never be
 * set below a number already issued. A cancelled registration is annulled in
 * place — the row stays, marked, with a reason — so the book has no silent
 * gaps and no reused numbers, which is how government registers are kept.
 */
export const m0018Correspondence = {
  id: '0018',
  name: 'correspondence register, units, transfers and counters',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.correspondence_units', 'U') IS NULL
      CREATE TABLE dbo.correspondence_units (
        unit_id           bigint        IDENTITY(1,1) NOT NULL,
        name              nvarchar(200) COLLATE Arabic_CI_AI NOT NULL,
        -- The people who act for this unit. A principal, so nested groups work
        -- through fn_expand_group_members the same way approval steps do.
        group_id          bigint        NOT NULL,
        -- Where this unit's finished letters may be archived. Optional and
        -- advisory: filing stays a normal folder operation under folder ACLs.
        archive_folder_id bigint        NULL,
        is_active         bit           NOT NULL CONSTRAINT DF_correspondence_units_active DEFAULT 1,
        created_at        datetime2(3)  NOT NULL CONSTRAINT DF_correspondence_units_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_correspondence_units PRIMARY KEY (unit_id),
        CONSTRAINT FK_correspondence_units_group FOREIGN KEY (group_id)
          REFERENCES dbo.principals(principal_id),
        CONSTRAINT FK_correspondence_units_folder FOREIGN KEY (archive_folder_id)
          REFERENCES dbo.folders(folder_id)
      );
    `.execute(trx);

    // Two live units may not share a name; a deactivated unit's name is free to
    // reuse, the same rule the folder tree applies to siblings.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_correspondence_units_name')
      CREATE UNIQUE INDEX UX_correspondence_units_name
        ON dbo.correspondence_units(name) WHERE is_active = 1;
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.correspondence', 'U') IS NULL
      CREATE TABLE dbo.correspondence (
        correspondence_id bigint        IDENTITY(1,1) NOT NULL,
        -- One register entry per document. The document carries the content and
        -- the permissions; this row carries the mail-room facts.
        document_id       bigint        NOT NULL,
        direction         varchar(3)    NOT NULL,
        book_year         smallint      NOT NULL,
        book_number       int           NOT NULL,
        subject           nvarchar(500) COLLATE Arabic_CI_AI NOT NULL,
        -- The outside party: the ministry or office the letter came from or
        -- goes to, and their own reference number and date as written on it.
        external_party    nvarchar(300) COLLATE Arabic_CI_AI NULL,
        external_ref      nvarchar(100) COLLATE Arabic_CI_AI NULL,
        external_date     date          NULL,
        -- The owning unit — meaningful for outgoing (which department issued
        -- it); incoming letters are owned by the register and routed instead.
        unit_id           bigint        NULL,
        -- Incoming: registered → routed → done. Outgoing: registered → sent.
        -- Annulled is the cancelled-in-place state either way; the number is
        -- never reused.
        status            varchar(10)   NOT NULL,
        annul_reason      nvarchar(400) COLLATE Arabic_CI_AI NULL,
        registered_by     bigint        NOT NULL,
        registered_at     datetime2(3)  NOT NULL CONSTRAINT DF_correspondence_registered DEFAULT SYSUTCDATETIME(),
        updated_at        datetime2(3)  NOT NULL CONSTRAINT DF_correspondence_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_correspondence PRIMARY KEY (correspondence_id),
        CONSTRAINT UQ_correspondence_document UNIQUE (document_id),
        CONSTRAINT UQ_correspondence_book UNIQUE (direction, book_year, book_number),
        CONSTRAINT CK_correspondence_direction CHECK (direction IN ('in', 'out')),
        CONSTRAINT CK_correspondence_status
          CHECK (status IN ('registered', 'routed', 'done', 'sent', 'annulled')),
        CONSTRAINT FK_correspondence_document FOREIGN KEY (document_id)
          REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_correspondence_unit FOREIGN KEY (unit_id)
          REFERENCES dbo.correspondence_units(unit_id),
        CONSTRAINT FK_correspondence_registrar FOREIGN KEY (registered_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.correspondence_transfers', 'U') IS NULL
      CREATE TABLE dbo.correspondence_transfers (
        transfer_id       bigint         IDENTITY(1,1) NOT NULL,
        correspondence_id bigint         NOT NULL,
        unit_id           bigint         NOT NULL,
        -- 'action' (للإجراء) must be worked and closed; 'info' (للاطلاع) closes
        -- itself the moment someone in the unit acknowledges it.
        purpose           varchar(6)     NOT NULL,
        status            varchar(10)    NOT NULL CONSTRAINT DF_correspondence_transfers_status DEFAULT 'pending',
        due_date          date           NULL,
        note              nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        routed_by         bigint         NOT NULL,
        routed_at         datetime2(3)   NOT NULL CONSTRAINT DF_correspondence_transfers_routed DEFAULT SYSUTCDATETIME(),
        received_by       bigint         NULL,
        received_at       datetime2(3)   NULL,
        closed_by         bigint         NULL,
        closed_at         datetime2(3)   NULL,
        close_note        nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        CONSTRAINT PK_correspondence_transfers PRIMARY KEY (transfer_id),
        CONSTRAINT CK_correspondence_transfers_purpose CHECK (purpose IN ('action', 'info')),
        CONSTRAINT CK_correspondence_transfers_status
          CHECK (status IN ('pending', 'received', 'done', 'cancelled')),
        CONSTRAINT FK_correspondence_transfers_letter FOREIGN KEY (correspondence_id)
          REFERENCES dbo.correspondence(correspondence_id),
        CONSTRAINT FK_correspondence_transfers_unit FOREIGN KEY (unit_id)
          REFERENCES dbo.correspondence_units(unit_id),
        CONSTRAINT FK_correspondence_transfers_router FOREIGN KEY (routed_by)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    // A letter is forwarded to a unit once at a time: re-forwarding is allowed
    // only after the earlier transfer is closed or cancelled.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_correspondence_transfers_live')
      CREATE UNIQUE INDEX UX_correspondence_transfers_live
        ON dbo.correspondence_transfers(correspondence_id, unit_id)
        WHERE status IN ('pending', 'received');
    `.execute(trx);

    // The queue and المتابعة both ask one question: open transfers, by unit.
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_correspondence_transfers_open')
      CREATE INDEX IX_correspondence_transfers_open
        ON dbo.correspondence_transfers(unit_id, status)
        INCLUDE (correspondence_id, purpose, due_date, routed_at);
    `.execute(trx);

    await sql`
      IF OBJECT_ID('dbo.correspondence_counters', 'U') IS NULL
      CREATE TABLE dbo.correspondence_counters (
        direction   varchar(3) NOT NULL,
        book_year   smallint   NOT NULL,
        next_number int        NOT NULL,
        CONSTRAINT PK_correspondence_counters PRIMARY KEY (direction, book_year),
        CONSTRAINT CK_correspondence_counters_direction CHECK (direction IN ('in', 'out')),
        CONSTRAINT CK_correspondence_counters_positive CHECK (next_number >= 1)
      );
    `.execute(trx);
  },
};
