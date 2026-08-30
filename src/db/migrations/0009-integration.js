/**
 * Migration 0009 — integration and derived artefacts.
 *
 * The remaining Tier 2/3 rows that need storage: API keys, webhooks, expiring
 * share links, resumable upload sessions, and the thumbnail/preview cache.
 *
 * ─── Secrets are stored hashed, again ───────────────────────────────────────
 *
 * API keys and share tokens follow the same rule as sessions and reset tokens:
 * only a SHA-256 is kept. A database backup that yields a working API key is a
 * standing back door into every document the key's owner can read, and backups
 * of this system are copied to a NAS and to tape.
 *
 * ─── Share links are the riskiest thing here ────────────────────────────────
 *
 * An expiring link hands document content to whoever holds the URL, with no
 * login. So a link carries its own expiry, an optional password, a download
 * cap, and the id of the person who created it — and it grants exactly one
 * document version, never a folder.
 */

import { sql } from 'kysely';

export const m0009Integration = {
  id: '0009',
  name: 'API keys, webhooks, share links, resumable uploads and thumbnails',

  async up(trx) {
    // ── API keys ─────────────────────────────────────────────────────────
    //
    // A key acts AS a user, rather than having its own permission set. That
    // keeps one permission model instead of two, and makes "what can this
    // integration see" answerable by looking at an ordinary account.
    await sql`
      CREATE TABLE dbo.api_keys (
        key_id      bigint        IDENTITY(1,1) NOT NULL,
        name        nvarchar(200) COLLATE Arabic_CI_AI NOT NULL,
        key_hash    char(64)      COLLATE Latin1_General_BIN2 NOT NULL,
        -- Shown in the UI so a key is recognisable without being usable.
        key_prefix  varchar(12)   NOT NULL,
        user_id     bigint        NOT NULL,
        created_by  bigint        NOT NULL,
        created_at  datetime2(3)  NOT NULL CONSTRAINT DF_api_keys_created_at DEFAULT SYSUTCDATETIME(),
        expires_at  datetime2(3)  NULL,
        last_used_at datetime2(3) NULL,
        revoked_at  datetime2(3)  NULL,
        CONSTRAINT PK_api_keys PRIMARY KEY (key_id),
        CONSTRAINT UQ_api_keys_hash UNIQUE (key_hash),
        CONSTRAINT FK_api_keys_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_api_keys_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_api_keys_user ON dbo.api_keys (user_id) INCLUDE (revoked_at, expires_at);
    `.execute(trx);

    // ── Webhooks ─────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.webhooks (
        webhook_id  bigint        IDENTITY(1,1) NOT NULL,
        name        nvarchar(200) COLLATE Arabic_CI_AI NOT NULL,
        url         nvarchar(1000) NOT NULL,
        -- Comma-separated event names. A junction table would be tidier and buys
        -- nothing: the list is short, read whole, and never queried across rows.
        events      varchar(500)  NOT NULL,
        -- Signs the payload so the receiver can verify it came from us.
        secret_hash char(64)      COLLATE Latin1_General_BIN2 NULL,
        is_active   bit           NOT NULL CONSTRAINT DF_webhooks_active DEFAULT 1,
        created_by  bigint        NOT NULL,
        created_at  datetime2(3)  NOT NULL CONSTRAINT DF_webhooks_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_webhooks PRIMARY KEY (webhook_id),
        CONSTRAINT FK_webhooks_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id)
      );
    `.execute(trx);

    // Deliveries are queued, not sent inline: a slow or dead receiver must not
    // make the upload that triggered it slow or dead too.
    await sql`
      CREATE TABLE dbo.webhook_deliveries (
        delivery_id  bigint         IDENTITY(1,1) NOT NULL,
        webhook_id   bigint         NOT NULL,
        event        varchar(60)    NOT NULL,
        payload      nvarchar(max)  NOT NULL,
        status       tinyint        NOT NULL CONSTRAINT DF_webhook_deliveries_status DEFAULT 0,
        attempts     int            NOT NULL CONSTRAINT DF_webhook_deliveries_attempts DEFAULT 0,
        last_error   nvarchar(1000) NULL,
        response_code int           NULL,
        queued_at    datetime2(3)   NOT NULL CONSTRAINT DF_webhook_deliveries_queued DEFAULT SYSUTCDATETIME(),
        delivered_at datetime2(3)   NULL,
        CONSTRAINT PK_webhook_deliveries PRIMARY KEY (delivery_id),
        CONSTRAINT FK_webhook_deliveries_hook FOREIGN KEY (webhook_id) REFERENCES dbo.webhooks(webhook_id)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_webhook_deliveries_pending
        ON dbo.webhook_deliveries (status, queued_at) WHERE status IN (0, 3);
    `.execute(trx);

    // ── Share links ──────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.share_links (
        share_id      bigint        IDENTITY(1,1) NOT NULL,
        token_hash    char(64)      COLLATE Latin1_General_BIN2 NOT NULL,
        document_id   bigint        NOT NULL,
        -- Pinned to a version: a link shared as "the signed contract" must not
        -- silently start serving a later revision.
        version_number smallint     NULL,
        created_by    bigint        NOT NULL,
        created_at    datetime2(3)  NOT NULL CONSTRAINT DF_share_links_created DEFAULT SYSUTCDATETIME(),
        expires_at    datetime2(3)  NOT NULL,
        password_hash nvarchar(255) NULL,
        max_downloads int           NULL,
        download_count int          NOT NULL CONSTRAINT DF_share_links_downloads DEFAULT 0,
        revoked_at    datetime2(3)  NULL,
        CONSTRAINT PK_share_links PRIMARY KEY (share_id),
        CONSTRAINT UQ_share_links_token UNIQUE (token_hash),
        CONSTRAINT FK_share_links_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT FK_share_links_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_share_links_expiry CHECK (expires_at > created_at)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_share_links_document ON dbo.share_links (document_id) INCLUDE (expires_at, revoked_at);
    `.execute(trx);

    // ── Resumable uploads ────────────────────────────────────────────────
    //
    // A large scan over a flaky connection is the case this exists for: without
    // it a failure at 90% restarts from zero, and people stop scanning.
    await sql`
      CREATE TABLE dbo.upload_sessions (
        session_id     varchar(64)    NOT NULL,
        user_id        bigint         NOT NULL,
        folder_id      bigint         NOT NULL,
        filename       nvarchar(400)  COLLATE Arabic_CI_AI NOT NULL,
        title          nvarchar(500)  COLLATE Arabic_CI_AI NULL,
        mime_type      varchar(150)   NULL,
        type_id        int            NULL,
        fields_json    nvarchar(4000) NULL,
        total_bytes    bigint         NOT NULL,
        received_bytes bigint         NOT NULL CONSTRAINT DF_upload_sessions_received DEFAULT 0,
        -- Where the partial file lives, relative to the storage root.
        staging_path   nvarchar(1000) NOT NULL,
        created_at     datetime2(3)   NOT NULL CONSTRAINT DF_upload_sessions_created DEFAULT SYSUTCDATETIME(),
        updated_at     datetime2(3)   NOT NULL CONSTRAINT DF_upload_sessions_updated DEFAULT SYSUTCDATETIME(),
        completed_at   datetime2(3)   NULL,
        document_id    bigint         NULL,
        CONSTRAINT PK_upload_sessions PRIMARY KEY (session_id),
        CONSTRAINT FK_upload_sessions_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT FK_upload_sessions_folder FOREIGN KEY (folder_id) REFERENCES dbo.folders(folder_id),
        CONSTRAINT CK_upload_sessions_bytes CHECK (received_bytes >= 0 AND received_bytes <= total_bytes)
      );
    `.execute(trx);

    // Abandoned sessions are swept by age.
    await sql`
      CREATE INDEX IX_upload_sessions_stale
        ON dbo.upload_sessions (updated_at) WHERE completed_at IS NULL;
    `.execute(trx);

    // ── Thumbnails and rendered previews ─────────────────────────────────
    //
    // Derived artefacts, keyed by the source version. They live on disk beside
    // the documents and are recorded here so a missing one can be regenerated
    // rather than silently 404ing forever.
    await sql`
      CREATE TABLE dbo.document_renditions (
        rendition_id   bigint        IDENTITY(1,1) NOT NULL,
        document_id    bigint        NOT NULL,
        version_number smallint      NOT NULL,
        kind           varchar(20)   NOT NULL,
        storage_path   nvarchar(1000) NOT NULL,
        mime_type      varchar(150)  NOT NULL,
        bytes          bigint        NOT NULL,
        created_at     datetime2(3)  NOT NULL CONSTRAINT DF_renditions_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_document_renditions PRIMARY KEY (rendition_id),
        CONSTRAINT FK_renditions_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT UQ_renditions UNIQUE (document_id, version_number, kind),
        CONSTRAINT CK_renditions_kind CHECK (kind IN ('thumbnail','preview'))
      );
    `.execute(trx);

    // Queued the same way extraction is, and for the same reason: rendering a
    // 40-page document must not block the upload that produced it.
    await sql`
      CREATE TABLE dbo.rendition_queue (
        queue_id       bigint       IDENTITY(1,1) NOT NULL,
        document_id    bigint       NOT NULL,
        version_number smallint     NOT NULL,
        kind           varchar(20)  NOT NULL,
        status         tinyint      NOT NULL CONSTRAINT DF_rendition_queue_status DEFAULT 0,
        attempts       int          NOT NULL CONSTRAINT DF_rendition_queue_attempts DEFAULT 0,
        last_error     nvarchar(1000) NULL,
        queued_at      datetime2(3) NOT NULL CONSTRAINT DF_rendition_queue_queued DEFAULT SYSUTCDATETIME(),
        finished_at    datetime2(3) NULL,
        CONSTRAINT PK_rendition_queue PRIMARY KEY (queue_id),
        CONSTRAINT FK_rendition_queue_document FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),
        CONSTRAINT UQ_rendition_queue UNIQUE (document_id, version_number, kind)
      );
    `.execute(trx);

    await sql`
      CREATE INDEX IX_rendition_queue_pending
        ON dbo.rendition_queue (status, queued_at) WHERE status IN (0, 3);
    `.execute(trx);
  },
};
