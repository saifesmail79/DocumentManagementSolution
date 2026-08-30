/**
 * Migration 0008 — collaboration, notification and workflow.
 *
 * Covers the Tier 2 rows that need storage: favourites, recent documents,
 * watches, the notification inbox, comments, cross-references, saved searches,
 * and the linear approval workflow. Plus the Tier 3 rows that share the same
 * shape: locks, lifecycle states, expiry and legal hold.
 *
 * ─── One migration rather than four ─────────────────────────────────────────
 *
 * Every object here is new. Nothing alters an existing table except documents,
 * which gains a few nullable columns, so there is no ordering hazard between
 * them and splitting would only add files.
 *
 * ─── Notifications are denormalised on purpose ──────────────────────────────
 *
 * A notification stores its own title and body rather than joining to whatever
 * produced it. The thing it refers to may be deleted, renamed or moved out of
 * the reader's reach, and an inbox whose entries change meaning after the fact
 * is worse than no inbox. The link is kept so the row is still navigable when
 * the target survives.
 */

import { sql } from 'kysely';

/** documents.lifecycle_state */
export const LIFECYCLE = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  OBSOLETE: 'obsolete',
});

/** approval_requests.status */
export const APPROVAL = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

export const m0008Collaboration = {
  id: '0008',
  name: 'favourites, watches, notifications, comments, approvals and lifecycle',

  async up(trx) {
    // ── Personal: favourites and recents ─────────────────────────────────
    //
    // "I can never find my documents again" was the most consistently cited
    // reason people abandon a DMS, and these two are the cheapest answer to it.
    await sql`
      CREATE TABLE dbo.favourites (
        user_id     bigint       NOT NULL,
        document_id bigint       NOT NULL,
        added_at    datetime2(3) NOT NULL CONSTRAINT DF_favourites_added_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_favourites PRIMARY KEY (user_id, document_id),
        CONSTRAINT FK_favourites_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_favourites_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id)
      );
    `.execute(trx);

    // One row per (user, document), overwritten on each visit rather than an
    // append-only log: "recent" is a set of at most a few dozen per person, and
    // a log would grow without bound and need its own trimming job.
    await sql`
      CREATE TABLE dbo.recent_documents (
        user_id     bigint       NOT NULL,
        document_id bigint       NOT NULL,
        viewed_at   datetime2(3) NOT NULL CONSTRAINT DF_recent_viewed_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_recent_documents PRIMARY KEY (user_id, document_id),
        CONSTRAINT FK_recent_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_recent_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_recent_user_time ON dbo.recent_documents (user_id, viewed_at DESC);
    `.execute(trx);

    // ── Watches ──────────────────────────────────────────────────────────
    //
    // A watch targets a folder or a document, never both, which is why the two
    // id columns are nullable with a CHECK rather than one polymorphic column.
    await sql`
      CREATE TABLE dbo.watches (
        watch_id    bigint       IDENTITY(1,1) NOT NULL,
        user_id     bigint       NOT NULL,
        folder_id   bigint       NULL,
        document_id bigint       NULL,
        -- A folder watch can include everything beneath it, which is what people
        -- mean by "tell me what arrives in my department".
        recursive   bit          NOT NULL CONSTRAINT DF_watches_recursive DEFAULT 1,
        created_at  datetime2(3) NOT NULL CONSTRAINT DF_watches_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_watches PRIMARY KEY (watch_id),
        CONSTRAINT FK_watches_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_watches_folder FOREIGN KEY (folder_id) REFERENCES dbo.folders(folder_id),
        CONSTRAINT FK_watches_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT CK_watches_one_target CHECK (
          (CASE WHEN folder_id IS NULL THEN 0 ELSE 1 END
         + CASE WHEN document_id IS NULL THEN 0 ELSE 1 END) = 1
        )
      );
    `.execute(trx);

    await sql`
      CREATE UNIQUE INDEX UX_watches_folder ON dbo.watches (user_id, folder_id) WHERE folder_id IS NOT NULL;
    `.execute(trx);
    await sql`
      CREATE UNIQUE INDEX UX_watches_document ON dbo.watches (user_id, document_id) WHERE document_id IS NOT NULL;
    `.execute(trx);

    // ── Notification inbox ───────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.notifications (
        notification_id bigint         IDENTITY(1,1) NOT NULL,
        user_id         bigint         NOT NULL,
        kind            varchar(40)    NOT NULL,
        -- Denormalised: see the header. The target may vanish or move out of
        -- reach, and the inbox entry must still read correctly.
        title           nvarchar(300)  COLLATE Arabic_CI_AI NOT NULL,
        body            nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        document_id     bigint         NULL,
        folder_id       bigint         NULL,
        created_at      datetime2(3)   NOT NULL CONSTRAINT DF_notifications_created_at DEFAULT SYSUTCDATETIME(),
        read_at         datetime2(3)   NULL,
        emailed_at      datetime2(3)   NULL,
        CONSTRAINT PK_notifications PRIMARY KEY (notification_id),
        CONSTRAINT FK_notifications_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    // The inbox query: mine, newest first, unread first.
    await sql`
      CREATE INDEX IX_notifications_user
        ON dbo.notifications (user_id, created_at DESC) INCLUDE (kind, title, read_at);
    `.execute(trx);

    // The mailer's work list.
    await sql`
      CREATE INDEX IX_notifications_unsent
        ON dbo.notifications (created_at) WHERE emailed_at IS NULL;
    `.execute(trx);

    // ── Comments ─────────────────────────────────────────────────────────
    //
    // Threaded one level deep via parent_comment_id. Arbitrary nesting reads
    // badly in RTL and nobody asks for it on a document.
    await sql`
      CREATE TABLE dbo.document_comments (
        comment_id        bigint         IDENTITY(1,1) NOT NULL,
        document_id       bigint         NOT NULL,
        parent_comment_id bigint         NULL,
        author_id         bigint         NOT NULL,
        body              nvarchar(4000) COLLATE Arabic_CI_AI NOT NULL,
        created_at        datetime2(3)   NOT NULL CONSTRAINT DF_comments_created_at DEFAULT SYSUTCDATETIME(),
        edited_at         datetime2(3)   NULL,
        is_deleted        bit            NOT NULL CONSTRAINT DF_comments_is_deleted DEFAULT 0,
        CONSTRAINT PK_document_comments PRIMARY KEY (comment_id),
        CONSTRAINT FK_comments_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_comments_parent FOREIGN KEY (parent_comment_id) REFERENCES dbo.document_comments(comment_id),
        CONSTRAINT FK_comments_author FOREIGN KEY (author_id) REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_comments_document ON dbo.document_comments (document_id, created_at);
    `.execute(trx);

    // ── Cross-references ─────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.document_relations (
        relation_id  bigint       IDENTITY(1,1) NOT NULL,
        from_document bigint      NOT NULL,
        to_document   bigint      NOT NULL,
        relation_type varchar(30) NOT NULL,
        created_by    bigint      NULL,
        created_at    datetime2(3) NOT NULL CONSTRAINT DF_relations_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_document_relations PRIMARY KEY (relation_id),
        CONSTRAINT FK_relations_from FOREIGN KEY (from_document) REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_relations_to FOREIGN KEY (to_document) REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_relations_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id),
        CONSTRAINT UQ_relations UNIQUE (from_document, to_document, relation_type),
        CONSTRAINT CK_relations_not_self CHECK (from_document <> to_document),
        CONSTRAINT CK_relations_type CHECK (
          relation_type IN ('related','supersedes','superseded_by','attachment','reply_to')
        )
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_relations_to ON dbo.document_relations (to_document) INCLUDE (from_document, relation_type);
    `.execute(trx);

    // ── Saved searches ("smart folders") ─────────────────────────────────
    //
    // The criteria are stored as JSON text rather than modelled as columns: they
    // are opaque to the database, only ever read back whole and handed to the
    // search API, and SQL Server 2019 has no json type to gain anything from.
    await sql`
      CREATE TABLE dbo.saved_searches (
        search_id  bigint         IDENTITY(1,1) NOT NULL,
        user_id    bigint         NOT NULL,
        name       nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        criteria   nvarchar(4000) NOT NULL,
        is_shared  bit            NOT NULL CONSTRAINT DF_saved_searches_shared DEFAULT 0,
        created_at datetime2(3)   NOT NULL CONSTRAINT DF_saved_searches_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_saved_searches PRIMARY KEY (search_id),
        CONSTRAINT FK_saved_searches_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT UQ_saved_searches_name UNIQUE (user_id, name)
      );
    `.execute(trx);

    // ── Approval workflow ────────────────────────────────────────────────
    //
    // A template belongs to a document type and is a linear list of steps. No
    // visual designer, no branching: the blueprint is explicit that a linear
    // chain per type is the v1 scope.
    await sql`
      CREATE TABLE dbo.approval_templates (
        template_id int            IDENTITY(1,1) NOT NULL,
        type_id     int            NULL,
        name        nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        is_active   bit            NOT NULL CONSTRAINT DF_approval_templates_active DEFAULT 1,
        created_at  datetime2(3)   NOT NULL CONSTRAINT DF_approval_templates_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_approval_templates PRIMARY KEY (template_id),
        CONSTRAINT FK_approval_templates_type FOREIGN KEY (type_id) REFERENCES dbo.document_types(type_id),
        CONSTRAINT UQ_approval_templates_name UNIQUE (name)
      );
    `.execute(trx);

    await sql`
      CREATE TABLE dbo.approval_steps (
        step_id       int    IDENTITY(1,1) NOT NULL,
        template_id   int    NOT NULL,
        step_order    int    NOT NULL,
        -- A principal, so a step can be assigned to a group and any member acts.
        approver_id   bigint NOT NULL,
        -- Tier 3: all members of the step's group must approve, not just one.
        require_all   bit    NOT NULL CONSTRAINT DF_approval_steps_require_all DEFAULT 0,
        -- Tier 3: escalate if nobody acts within this many hours. NULL = never.
        sla_hours     int    NULL,
        CONSTRAINT PK_approval_steps PRIMARY KEY (step_id),
        CONSTRAINT FK_approval_steps_template FOREIGN KEY (template_id)
          REFERENCES dbo.approval_templates(template_id),
        CONSTRAINT FK_approval_steps_approver FOREIGN KEY (approver_id)
          REFERENCES dbo.principals(principal_id),
        CONSTRAINT UQ_approval_steps_order UNIQUE (template_id, step_order)
      );
    `.execute(trx);

    await sql`
      CREATE TABLE dbo.approval_requests (
        request_id    bigint        IDENTITY(1,1) NOT NULL,
        document_id   bigint        NOT NULL,
        template_id   int           NULL,
        current_step  int           NOT NULL CONSTRAINT DF_approval_requests_step DEFAULT 1,
        status        varchar(12)   NOT NULL CONSTRAINT DF_approval_requests_status DEFAULT 'pending',
        requested_by  bigint        NOT NULL,
        requested_at  datetime2(3)  NOT NULL CONSTRAINT DF_approval_requests_at DEFAULT SYSUTCDATETIME(),
        completed_at  datetime2(3)  NULL,
        note          nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        CONSTRAINT PK_approval_requests PRIMARY KEY (request_id),
        CONSTRAINT FK_approval_requests_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_approval_requests_template FOREIGN KEY (template_id)
          REFERENCES dbo.approval_templates(template_id),
        CONSTRAINT FK_approval_requests_user FOREIGN KEY (requested_by) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_approval_requests_status
          CHECK (status IN ('pending','approved','rejected','cancelled'))
      );
    `.execute(trx);

    // Only one live request per document: two concurrent approvals of the same
    // document have no coherent meaning.
    await sql`
      CREATE UNIQUE INDEX UX_approval_requests_live
        ON dbo.approval_requests (document_id) WHERE status = 'pending';
    `.execute(trx);

    await sql`
      CREATE TABLE dbo.approval_decisions (
        decision_id bigint        IDENTITY(1,1) NOT NULL,
        request_id  bigint        NOT NULL,
        step_order  int           NOT NULL,
        actor_id    bigint        NOT NULL,
        decision    varchar(10)   NOT NULL,
        note        nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        decided_at  datetime2(3)  NOT NULL CONSTRAINT DF_approval_decisions_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_approval_decisions PRIMARY KEY (decision_id),
        CONSTRAINT FK_approval_decisions_request FOREIGN KEY (request_id)
          REFERENCES dbo.approval_requests(request_id),
        CONSTRAINT FK_approval_decisions_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(user_id),
        CONSTRAINT UQ_approval_decisions UNIQUE (request_id, step_order, actor_id),
        CONSTRAINT CK_approval_decisions CHECK (decision IN ('approved','rejected'))
      );
    `.execute(trx);

    // ── Document state: lifecycle, locks, expiry, hold ───────────────────
    await sql`
      ALTER TABLE dbo.documents ADD
        lifecycle_state  varchar(12)  NOT NULL CONSTRAINT DF_documents_lifecycle DEFAULT 'active',
        expires_at       datetime2(3) NULL,
        expiry_notified_at datetime2(3) NULL,
        -- Legal hold blocks deletion and purging outright, including by an
        -- administrator. That is the entire point of the feature.
        legal_hold       bit          NOT NULL CONSTRAINT DF_documents_legal_hold DEFAULT 0,
        legal_hold_reason nvarchar(500) COLLATE Arabic_CI_AI NULL,
        locked_by        bigint       NULL,
        locked_at        datetime2(3) NULL;
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.documents
        ADD CONSTRAINT CK_documents_lifecycle
        CHECK (lifecycle_state IN ('draft','active','superseded','obsolete'));
    `.execute(trx);

    await sql`
      ALTER TABLE dbo.documents
        ADD CONSTRAINT FK_documents_locker FOREIGN KEY (locked_by) REFERENCES dbo.users(user_id);
    `.execute(trx);

    // The nightly expiry sweep's work list.
    await sql`
      CREATE INDEX IX_documents_expiry
        ON dbo.documents (expires_at)
        INCLUDE (title, folder_id, created_by)
        WHERE expires_at IS NOT NULL AND is_deleted = 0;
    `.execute(trx);

    // ── Metadata inheritance ─────────────────────────────────────────────
    //
    // Defaults hang off a folder and apply to documents created inside it, so a
    // filing clerk stops re-entering the same department and year on every
    // upload. Stored as values, not as a template: the point is that the value
    // is already filled in.
    await sql`
      CREATE TABLE dbo.folder_field_defaults (
        folder_id       bigint         NOT NULL,
        field_id        int            NOT NULL,
        value_text      nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        value_number    decimal(38,10) NULL,
        value_date      datetime2(3)   NULL,
        value_bool      bit            NULL,
        value_choice_id int            NULL,
        -- Applies to everything below, not just direct children.
        inherit_down    bit            NOT NULL CONSTRAINT DF_folder_defaults_inherit DEFAULT 1,
        CONSTRAINT PK_folder_field_defaults PRIMARY KEY (folder_id, field_id),
        CONSTRAINT FK_folder_defaults_folder FOREIGN KEY (folder_id) REFERENCES dbo.folders(folder_id),
        CONSTRAINT FK_folder_defaults_field FOREIGN KEY (field_id) REFERENCES dbo.custom_field_defs(field_id),
        CONSTRAINT FK_folder_defaults_choice FOREIGN KEY (value_choice_id)
          REFERENCES dbo.custom_field_choices(choice_id)
      );
    `.execute(trx);
  },
};
