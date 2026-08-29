/**
 * Migration 0003 — server-side sessions.
 *
 * ─── Why sessions and not JWT ───────────────────────────────────────────────
 *
 * A JWT cannot be revoked before it expires without a server-side deny list —
 * at which point the server is doing a database lookup per request anyway, and
 * the stateless argument has been paid for and not used.
 *
 * This is a document management system. "Revoke that person's access now" is a
 * routine, non-negotiable request: someone leaves, a laptop is lost, an account
 * is shared. A design where revocation takes effect "within fifteen minutes" is
 * the wrong shape for the problem, and it is the same reasoning that made the
 * permission model live-computed rather than cached-and-hopefully-invalidated.
 *
 * There is one server and one database. Statelessness buys nothing here.
 *
 * ─── Why only the hash is stored ────────────────────────────────────────────
 *
 * token_hash holds SHA-256 of the opaque token; the token itself is never
 * written down. A leaked database backup therefore yields no usable sessions,
 * for the same reason it yields no usable passwords. Backups of this system are
 * copied to a NAS and to tape, so they must be assumed readable by someone who
 * should not have been able to log in.
 *
 * SHA-256 rather than argon2 because the token is 256 bits of CSPRNG output, not
 * a human-chosen secret — there is nothing to brute-force, and this runs on every
 * authenticated request.
 */

import { sql } from 'kysely';

export const m0003Sessions = {
  id: '0003',
  name: 'server-side sessions',

  async up(trx) {
    await sql`
      CREATE TABLE dbo.user_sessions (
        session_id   bigint        IDENTITY(1,1) NOT NULL,
        -- SHA-256 of the opaque token, hex. BIN2 so lookup is an exact byte
        -- comparison and never does linguistic work on a random string.
        token_hash   char(64)      COLLATE Latin1_General_BIN2 NOT NULL,
        user_id      bigint        NOT NULL,
        created_at   datetime2(3)  NOT NULL CONSTRAINT DF_user_sessions_created_at DEFAULT SYSUTCDATETIME(),
        last_seen_at datetime2(3)  NOT NULL CONSTRAINT DF_user_sessions_last_seen DEFAULT SYSUTCDATETIME(),
        expires_at   datetime2(3)  NOT NULL,
        revoked_at   datetime2(3)  NULL,
        -- Recorded for the audit trail and for "where am I signed in" later.
        -- 45 characters covers an IPv6 address with an embedded IPv4 suffix.
        ip_address   varchar(45)   NULL,
        user_agent   nvarchar(400) NULL,
        CONSTRAINT PK_user_sessions PRIMARY KEY (session_id),
        CONSTRAINT UQ_user_sessions_token UNIQUE (token_hash),
        CONSTRAINT FK_user_sessions_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_user_sessions_expiry CHECK (expires_at > created_at)
      );
    `.execute(trx);

    // "Every live session for this user", for revoke-all on password change and
    // for the deactivation path.
    await sql`
      CREATE INDEX IX_user_sessions_user
        ON dbo.user_sessions (user_id) INCLUDE (expires_at, revoked_at);
    `.execute(trx);

    // The expiry sweep. Filtered to rows it can actually act on.
    await sql`
      CREATE INDEX IX_user_sessions_expires
        ON dbo.user_sessions (expires_at) WHERE revoked_at IS NULL;
    `.execute(trx);

    // Password age. NIST no longer recommends forced rotation, so this is not an
    // expiry clock — it is what lets an admin see a credential that has not
    // changed since installation, and what a future "your password was changed"
    // notice reads from.
    await sql`
      ALTER TABLE dbo.users
        ADD password_changed_at datetime2(3) NULL;
    `.execute(trx);
  },
};
