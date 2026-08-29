/**
 * Migration 0005 — the audit trail, and password reset tokens.
 *
 * ─── Why the actor's name is copied, not joined ─────────────────────────────
 *
 * audit_log stores actor_username alongside actor_user_id. That is deliberate
 * denormalisation: an audit entry has to stay readable after the account is
 * deactivated, renamed, or its display name changed. A trail that renders as
 * "user 4172 deleted a contract" a year later has failed at the one job it has.
 *
 * The id is kept too, so "everything this person did" is still an indexed
 * lookup rather than a string match.
 *
 * ─── Why the target is a loose reference ────────────────────────────────────
 *
 * target_type + target_id are not a foreign key. The whole point of an audit
 * entry is to outlive what it describes — a deleted document, a purged version,
 * a removed ACE. A foreign key would either block the delete or cascade the
 * history away, and both defeat the purpose.
 *
 * ─── Password reset ─────────────────────────────────────────────────────────
 *
 * Only the SHA-256 of the reset token is stored, for the same reason session
 * tokens are hashed: a database backup must not hand someone a working way in.
 * Tokens are single-use and short-lived.
 */

import { sql } from 'kysely';

export const m0005AuditAndReset = {
  id: '0005',
  name: 'audit trail and password reset tokens',

  async up(trx) {
    await sql`
      CREATE TABLE dbo.audit_log (
        audit_id       bigint         IDENTITY(1,1) NOT NULL,
        occurred_at    datetime2(3)   NOT NULL CONSTRAINT DF_audit_occurred_at DEFAULT SYSUTCDATETIME(),
        -- NULL for actions the system takes on its own (the purge sweep, the
        -- extraction worker), which must be attributable to "the system" rather
        -- than silently to whoever happened to trigger them.
        actor_user_id  bigint         NULL,
        actor_username nvarchar(100)  NULL,
        action         varchar(64)    NOT NULL,
        target_type    varchar(32)    NULL,
        target_id      nvarchar(64)   NULL,
        -- Kept where known so "everything that happened in this folder" is a
        -- single indexed query rather than a scan of every entry.
        folder_id      bigint         NULL,
        detail         nvarchar(2000) COLLATE Arabic_CI_AI NULL,
        ip_address     varchar(45)    NULL,
        user_agent     nvarchar(400)  NULL,
        CONSTRAINT PK_audit_log PRIMARY KEY (audit_id),
        CONSTRAINT FK_audit_actor FOREIGN KEY (actor_user_id) REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    // The default view: most recent first.
    await sql`
      CREATE INDEX IX_audit_occurred
        ON dbo.audit_log (occurred_at DESC)
        INCLUDE (action, actor_username, target_type, target_id, folder_id);
    `.execute(trx);

    // "What did this person do", the question an investigation starts from.
    await sql`
      CREATE INDEX IX_audit_actor
        ON dbo.audit_log (actor_user_id, occurred_at DESC) WHERE actor_user_id IS NOT NULL;
    `.execute(trx);

    // "What happened to this document / this folder".
    await sql`
      CREATE INDEX IX_audit_target
        ON dbo.audit_log (target_type, target_id, occurred_at DESC) WHERE target_id IS NOT NULL;
    `.execute(trx);

    await sql`
      CREATE INDEX IX_audit_folder
        ON dbo.audit_log (folder_id, occurred_at DESC) WHERE folder_id IS NOT NULL;
    `.execute(trx);

    // ── Password reset ───────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.password_reset_tokens (
        token_id     bigint        IDENTITY(1,1) NOT NULL,
        -- SHA-256 of the token, hex. The token itself is never written down.
        token_hash   char(64)      COLLATE Latin1_General_BIN2 NOT NULL,
        user_id      bigint        NOT NULL,
        created_at   datetime2(3)  NOT NULL CONSTRAINT DF_reset_created_at DEFAULT SYSUTCDATETIME(),
        expires_at   datetime2(3)  NOT NULL,
        used_at      datetime2(3)  NULL,
        requested_ip varchar(45)   NULL,
        CONSTRAINT PK_password_reset_tokens PRIMARY KEY (token_id),
        CONSTRAINT UQ_password_reset_token UNIQUE (token_hash),
        CONSTRAINT FK_password_reset_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_password_reset_expiry CHECK (expires_at > created_at)
      );
    `.execute(trx);

    // Used to invalidate a user's outstanding tokens when one is redeemed or the
    // password changes by another route.
    await sql`
      CREATE INDEX IX_password_reset_user
        ON dbo.password_reset_tokens (user_id) INCLUDE (expires_at, used_at);
    `.execute(trx);

    // ── Storage purge bookkeeping ────────────────────────────────────────
    //
    // A soft-deleted document keeps its bytes for a grace period, then the sweep
    // removes them. Recording the removal separately from audit_log keeps the
    // "has this blob actually gone from disk" question answerable without
    // parsing free text.
    await sql`
      CREATE TABLE dbo.purged_blobs (
        purge_id      bigint         IDENTITY(1,1) NOT NULL,
        document_id   bigint         NOT NULL,
        version_number smallint      NOT NULL,
        storage_path  nvarchar(1000) NOT NULL,
        sha256        char(64)       COLLATE Latin1_General_BIN2 NOT NULL,
        bytes         bigint         NOT NULL,
        purged_at     datetime2(3)   NOT NULL CONSTRAINT DF_purged_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_purged_blobs PRIMARY KEY (purge_id)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_purged_blobs_document ON dbo.purged_blobs (document_id, version_number);
    `.execute(trx);
  },
};
