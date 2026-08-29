/**
 * Migration 0001 — identity, the filing tree, and the permission model.
 *
 * This is the foundation. Every other feature reads or enforces what is defined
 * here, so it is built first and deliberately conservatively.
 *
 * ─── The one decision that matters ──────────────────────────────────────────
 *
 * An adversarial review of three competing designs for this schema produced 15
 * permission bypasses and 32 correctness bugs. Almost every one of them was the
 * same shape: a precomputed permission cache that had gone stale, raced with a
 * concurrent rebuild, or missed an invalidation event nobody remembered to write
 * (super-admin revoked, user created, role bits reduced, folder soft-deleted,
 * principal deleted…). The recurring worst case was an async rebuild worker
 * computing from old ACL state and stamping the result with a *new* version, so
 * the staleness guard passed and wrong permissions persisted indefinitely.
 *
 * The fix is structural, not a longer checklist:
 *
 *   1. LIVE COMPUTATION IS THE SOURCE OF TRUTH. fn_effective_permission() derives
 *      permissions from the ACL every time it is called. Correctness never depends
 *      on cache invalidation being complete.
 *
 *   2. THE CACHE IS STAMPED WITH A SINGLE GLOBAL EPOCH. Any permission-affecting
 *      change bumps acl_epoch. Cached rows are only read WHERE epoch = current, so
 *      the moment anything changes, every cached row becomes invisible at once.
 *
 * Together these mean a forgotten invalidation is a CACHE MISS, never a bypass.
 * The failure mode is "slower", not "the wrong person read the document". A
 * global epoch is coarse — one ACE edit cools the whole cache — but permission
 * changes are rare admin actions, and at this scale a rebuild is seconds.
 *
 * ─── Other decisions, each closing a specific reported bug ──────────────────
 *
 *   • Permissions attach to FOLDERS ONLY. A document's permission is its folder's
 *     permission. This removes the per-document ACL surface entirely.
 *
 *   • Roles are TEMPLATES resolved to bits when a grant is made, not live
 *     references. Reducing a role's bits therefore cannot silently leave
 *     inheriting descendants over-permitted (reported bypass). role_id is kept so
 *     an admin can explicitly re-apply a changed role to existing grants.
 *
 *   • DENY beats ALLOW globally, with no proximity precedence. The rule that can
 *     be reasoned about at 2am is the rule that stays correct.
 *
 *   • is_deleted is checked INSIDE fn_effective_permission, not left to callers.
 *     A soft-deleted folder returns 0 bits, so every caller inherits the check
 *     and none can forget it (reported bypass: soft-deleted folder contents
 *     remained readable because the hot query never joined back to the tree).
 *
 *   • Browse and Read are separate bits. Browse means "this folder and the titles
 *     in it exist". Read means "you may open the content". The split is enforced
 *     in SQL by the queries that use these bits, never by returning a bitmask and
 *     trusting the API layer to check it.
 */

import { sql } from 'kysely';

/**
 * Permission verbs. Stored as a bitmask in a single INT column.
 *
 * Six verbs, not eleven. A finer split (separating NewVersion from Upload, Move
 * from Delete) serves real edge cases but turns the permissions UI into a wall of
 * checkboxes on day one. The column is INT, so verbs can be added later without a
 * schema change.
 */
export const PERM = Object.freeze({
  BROWSE: 1, //  see the folder exists, and see document titles inside it
  READ: 2, //    open, preview and download document content
  UPLOAD: 4, //  add documents and add new versions
  EDIT_META: 8, // rename, change metadata fields
  DELETE: 16, // soft-delete documents and folders
  MANAGE_PERMS: 32, // edit ACLs, break and restore inheritance
});

export const ALL_PERMS = Object.values(PERM).reduce((a, b) => a | b, 0);

export const m0001IdentityAndAcl = {
  id: '0001',
  name: 'identity, filing tree, and permission model',

  async up(trx) {
    // ─────────────────────────────────────────────────────────────────────
    // Principals — one identity space for users and groups.
    //
    // ACEs point at a principal, so a grant can target a user or a group through
    // a single foreign key. Without this, every ACL query needs a UNION or a
    // nullable pair of FKs, and "which principals does this ACE apply to" stops
    // being a single indexed lookup.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.principals (
        principal_id    bigint         IDENTITY(1,1) NOT NULL,
        principal_type  varchar(10)    NOT NULL,
        display_name    nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        is_active       bit            NOT NULL CONSTRAINT DF_principals_is_active DEFAULT 1,
        created_at      datetime2(3)   NOT NULL CONSTRAINT DF_principals_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_principals PRIMARY KEY (principal_id),
        CONSTRAINT CK_principals_type CHECK (principal_type IN ('user','group'))
      );
    `.execute(trx);

    await sql`
      CREATE TABLE dbo.users (
        user_id          bigint         NOT NULL,
        username         nvarchar(100)  COLLATE Latin1_General_CI_AS NOT NULL,
        password_hash    nvarchar(255)  NOT NULL,
        email            nvarchar(255)  NULL,
        is_super_admin   bit            NOT NULL CONSTRAINT DF_users_is_super_admin DEFAULT 0,
        must_change_password bit        NOT NULL CONSTRAINT DF_users_must_change_pw DEFAULT 0,
        failed_login_count   int        NOT NULL CONSTRAINT DF_users_failed_logins DEFAULT 0,
        locked_until     datetime2(3)   NULL,
        last_login_at    datetime2(3)   NULL,
        created_at       datetime2(3)   NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_users PRIMARY KEY (user_id),
        CONSTRAINT FK_users_principal FOREIGN KEY (user_id) REFERENCES dbo.principals(principal_id),
        CONSTRAINT UQ_users_username UNIQUE (username)
      );
    `.execute(trx);

    await sql`
      CREATE TABLE dbo.groups (
        group_id     bigint         NOT NULL,
        name         nvarchar(200)  COLLATE Arabic_CI_AI NOT NULL,
        description  nvarchar(1000) COLLATE Arabic_CI_AI NULL,
        created_at   datetime2(3)   NOT NULL CONSTRAINT DF_groups_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_groups PRIMARY KEY (group_id),
        CONSTRAINT FK_groups_principal FOREIGN KEY (group_id) REFERENCES dbo.principals(principal_id),
        CONSTRAINT UQ_groups_name UNIQUE (name)
      );
    `.execute(trx);

    // Nested groups: a member is any principal, so a group can contain a group.
    await sql`
      CREATE TABLE dbo.group_members (
        group_id             bigint       NOT NULL,
        member_principal_id  bigint       NOT NULL,
        added_at             datetime2(3) NOT NULL CONSTRAINT DF_group_members_added_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_group_members PRIMARY KEY (group_id, member_principal_id),
        CONSTRAINT FK_group_members_group  FOREIGN KEY (group_id) REFERENCES dbo.groups(group_id),
        CONSTRAINT FK_group_members_member FOREIGN KEY (member_principal_id) REFERENCES dbo.principals(principal_id),
        CONSTRAINT CK_group_members_no_self CHECK (group_id <> member_principal_id)
      );
    `.execute(trx);

    // Reverse lookup: "which groups is this principal in", used when expanding a
    // user's principal set.
    await sql`
      CREATE INDEX IX_group_members_member
        ON dbo.group_members (member_principal_id) INCLUDE (group_id);
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // acl_epoch — the staleness guard for the whole permission cache.
    //
    // A single row. Every permission-affecting change bumps it inside the same
    // transaction as the change itself. Cached permission rows record the epoch
    // they were computed under and are only trusted while it matches, so a change
    // invalidates the entire cache atomically and no per-event invalidation logic
    // can be forgotten or get the blast radius wrong.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.acl_epoch (
        lock_row    bit          NOT NULL CONSTRAINT DF_acl_epoch_lock DEFAULT 1,
        epoch       bigint       NOT NULL CONSTRAINT DF_acl_epoch_epoch DEFAULT 1,
        bumped_at   datetime2(3) NOT NULL CONSTRAINT DF_acl_epoch_bumped_at DEFAULT SYSUTCDATETIME(),
        bumped_by   nvarchar(200) NULL,
        CONSTRAINT PK_acl_epoch PRIMARY KEY (lock_row),
        CONSTRAINT CK_acl_epoch_single_row CHECK (lock_row = 1)
      );
    `.execute(trx);

    await sql`INSERT INTO dbo.acl_epoch (lock_row, epoch) VALUES (1, 1);`.execute(trx);

    await sql`
      CREATE PROCEDURE dbo.sp_bump_acl_epoch
        @reason nvarchar(200) = NULL
      AS
      BEGIN
        SET NOCOUNT ON;
        -- Must be called inside the caller's transaction so the epoch bump commits
        -- together with the change that caused it. Bumping separately would leave a
        -- window where the ACL has changed but the cache still looks current.
        UPDATE dbo.acl_epoch
           SET epoch = epoch + 1,
               bumped_at = SYSUTCDATETIME(),
               bumped_by = @reason
         WHERE lock_row = 1;
      END;
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Roles — permission templates.
    //
    // A role is expanded to raw bits when a grant is created; the ACE stores the
    // resulting bits, not a live reference. Editing a role therefore cannot
    // silently change what existing grants mean. role_id is retained so an admin
    // can deliberately re-apply a changed role to the grants that used it.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.roles (
        role_id          int            IDENTITY(1,1) NOT NULL,
        name             nvarchar(100)  COLLATE Arabic_CI_AI NOT NULL,
        description      nvarchar(500)  COLLATE Arabic_CI_AI NULL,
        permission_bits  int            NOT NULL,
        is_system        bit            NOT NULL CONSTRAINT DF_roles_is_system DEFAULT 0,
        created_at       datetime2(3)   NOT NULL CONSTRAINT DF_roles_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_roles PRIMARY KEY (role_id),
        CONSTRAINT UQ_roles_name UNIQUE (name),
        CONSTRAINT CK_roles_bits CHECK (permission_bits >= 0 AND permission_bits <= 63)
      );
    `.execute(trx);

    await sql`
      INSERT INTO dbo.roles (name, description, permission_bits, is_system) VALUES
        (N'Viewer',      N'Browse folders and read documents',              ${PERM.BROWSE | PERM.READ}, 1),
        (N'Contributor', N'Viewer, plus upload documents and new versions', ${PERM.BROWSE | PERM.READ | PERM.UPLOAD}, 1),
        (N'Editor',      N'Contributor, plus edit metadata',                ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META}, 1),
        (N'Manager',     N'Editor, plus delete',                            ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE}, 1),
        (N'Owner',       N'Full control including permissions',             ${ALL_PERMS}, 1);
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // The filing tree — folders only.
    //
    // Adjacency list (parent_id) for structure, plus a materialized path so a
    // subtree is a single indexed range scan and a node's ancestors are readable
    // without a recursive query. No closure table: at a few thousand nodes the
    // path column covers every query we need, and a closure table would add
    // subtree-wide rewrites on every move for no measurable gain.
    //
    // mpath format is '/1/4/12/' — always leading and trailing slash, so
    // "descendants of X" is  mpath LIKE x.mpath + '%'  with no false prefix
    // matches (/1/12/ does not match /1/1%).
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.folders (
        folder_id      bigint         IDENTITY(1,1) NOT NULL,
        parent_id      bigint         NULL,
        name           nvarchar(400)  COLLATE Arabic_CI_AI NOT NULL,
        -- Latin1_General_BIN2 makes LIKE prefix scans on the path both fast and
        -- exact. Under an accent-insensitive collation, path comparison would be
        -- doing linguistic work on what is really an opaque key.
        mpath          varchar(900)   COLLATE Latin1_General_BIN2 NOT NULL,
        depth          smallint       NOT NULL,
        inherits_acl   bit            NOT NULL CONSTRAINT DF_folders_inherits_acl DEFAULT 1,
        is_deleted     bit            NOT NULL CONSTRAINT DF_folders_is_deleted DEFAULT 0,
        deleted_at     datetime2(3)   NULL,
        created_by     bigint         NULL,
        created_at     datetime2(3)   NOT NULL CONSTRAINT DF_folders_created_at DEFAULT SYSUTCDATETIME(),
        updated_at     datetime2(3)   NOT NULL CONSTRAINT DF_folders_updated_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_folders PRIMARY KEY (folder_id),
        CONSTRAINT FK_folders_parent  FOREIGN KEY (parent_id)  REFERENCES dbo.folders(folder_id),
        CONSTRAINT FK_folders_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id),
        CONSTRAINT CK_folders_no_self_parent CHECK (parent_id IS NULL OR parent_id <> folder_id),
        CONSTRAINT CK_folders_depth CHECK (depth >= 0 AND depth <= 32)
      );
    `.execute(trx);

    // Subtree scans: WHERE mpath LIKE '/1/4/%'
    await sql`
      CREATE INDEX IX_folders_mpath ON dbo.folders (mpath) INCLUDE (parent_id, name, is_deleted, inherits_acl);
    `.execute(trx);

    // Listing the children of a folder, excluding deleted ones.
    await sql`
      CREATE INDEX IX_folders_parent ON dbo.folders (parent_id, is_deleted) INCLUDE (name, mpath, depth);
    `.execute(trx);

    // Sibling names must be unique among live folders. A filtered unique index
    // gives this without blocking name reuse after a folder is deleted.
    await sql`
      CREATE UNIQUE INDEX UQ_folders_sibling_name
        ON dbo.folders (parent_id, name) WHERE is_deleted = 0;
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // Access control entries.
    //
    // allow_bits and deny_bits are separate so DENY survives being combined with
    // an ALLOW from another grant. Effective = OR(allow) & ~OR(deny), evaluated
    // across the whole applicable chain — a DENY anywhere wins.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.access_control_entries (
        ace_id        bigint       IDENTITY(1,1) NOT NULL,
        folder_id     bigint       NOT NULL,
        principal_id  bigint       NOT NULL,
        allow_bits    int          NOT NULL CONSTRAINT DF_ace_allow DEFAULT 0,
        deny_bits     int          NOT NULL CONSTRAINT DF_ace_deny  DEFAULT 0,
        -- The role this grant was created from, for display and deliberate
        -- re-application. Not consulted when resolving permissions.
        from_role_id  int          NULL,
        created_by    bigint       NULL,
        created_at    datetime2(3) NOT NULL CONSTRAINT DF_ace_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ace PRIMARY KEY (ace_id),
        CONSTRAINT FK_ace_folder    FOREIGN KEY (folder_id)    REFERENCES dbo.folders(folder_id),
        CONSTRAINT FK_ace_principal FOREIGN KEY (principal_id) REFERENCES dbo.principals(principal_id),
        CONSTRAINT FK_ace_role      FOREIGN KEY (from_role_id) REFERENCES dbo.roles(role_id),
        CONSTRAINT FK_ace_creator   FOREIGN KEY (created_by)   REFERENCES dbo.users(user_id),
        CONSTRAINT UQ_ace_folder_principal UNIQUE (folder_id, principal_id),
        CONSTRAINT CK_ace_bits CHECK (
          allow_bits >= 0 AND allow_bits <= 63 AND
          deny_bits  >= 0 AND deny_bits  <= 63 AND
          (allow_bits | deny_bits) <> 0
        )
      );
    `.execute(trx);

    // Resolving a folder's ACEs is the inner loop of permission computation.
    await sql`
      CREATE INDEX IX_ace_folder ON dbo.access_control_entries (folder_id)
        INCLUDE (principal_id, allow_bits, deny_bits);
    `.execute(trx);

    // "Where does this principal have grants" — for the admin UI and for reporting.
    await sql`
      CREATE INDEX IX_ace_principal ON dbo.access_control_entries (principal_id)
        INCLUDE (folder_id, allow_bits, deny_bits);
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // The permission cache.
    //
    // Pure optimisation. Every row carries the epoch it was computed under and is
    // only read while that matches acl_epoch, so it can never outlive the ACL
    // state it was derived from. Rows are never invalidated individually — the
    // epoch does it wholesale — which is precisely why no invalidation event can
    // be forgotten.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE TABLE dbo.effective_permissions (
        user_id      bigint       NOT NULL,
        folder_id    bigint       NOT NULL,
        perm_bits    int          NOT NULL,
        epoch        bigint       NOT NULL,
        computed_at  datetime2(3) NOT NULL CONSTRAINT DF_ep_computed_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_effective_permissions PRIMARY KEY (user_id, folder_id),
        CONSTRAINT FK_ep_user   FOREIGN KEY (user_id)   REFERENCES dbo.users(user_id),
        CONSTRAINT FK_ep_folder FOREIGN KEY (folder_id) REFERENCES dbo.folders(folder_id)
      );
    `.execute(trx);

    // The hot path: "which folders can this user browse", already filtered to the
    // current epoch. Covering, so the lookup never leaves the index.
    await sql`
      CREATE INDEX IX_ep_user_epoch ON dbo.effective_permissions (user_id, epoch)
        INCLUDE (folder_id, perm_bits);
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // fn_expand_principals — a user's own principal id plus every group they are
    // in, transitively.
    //
    // Computed live rather than kept in a flat cache table. Three of the reported
    // bugs came from that cache: a cyclic group definition aborting the rebuild
    // and leaving the table EMPTY, which silently dropped every group-based DENY.
    // A recursive CTE with a depth cap cannot fail that way — a cycle simply stops
    // expanding, and DISTINCT makes revisiting a group harmless.
    // ─────────────────────────────────────────────────────────────────────
    await sql`
      CREATE FUNCTION dbo.fn_expand_principals (@user_id bigint)
      RETURNS TABLE
      AS
      RETURN (
        WITH ancestry AS (
          SELECT CAST(@user_id AS bigint) AS principal_id, 0 AS lvl
          UNION ALL
          SELECT gm.group_id, a.lvl + 1
            FROM ancestry a
            JOIN dbo.group_members gm ON gm.member_principal_id = a.principal_id
            JOIN dbo.principals p     ON p.principal_id = gm.group_id AND p.is_active = 1
           WHERE a.lvl < 16
        )
        SELECT DISTINCT principal_id FROM ancestry
      );
    `.execute(trx);

    // ─────────────────────────────────────────────────────────────────────
    // fn_effective_permission — the source of truth.
    //
    // Walks from the folder up through its ancestors, stopping at (and including)
    // the first folder that breaks inheritance, then combines every ACE that
    // targets any of the user's principals.
    //
    // Returns 0 for a deleted folder, an inactive user, and a folder that does not
    // exist — the check lives here so no caller can omit it. Super admins short
    // circuit to full rights.
    // ─────────────────────────────────────────────────────────────────────
    await sql.raw(`
      CREATE FUNCTION dbo.fn_effective_permission (@user_id bigint, @folder_id bigint)
      RETURNS TABLE
      AS
      RETURN (
        WITH usr AS (
          SELECT u.user_id, u.is_super_admin
            FROM dbo.users u
            JOIN dbo.principals p ON p.principal_id = u.user_id
           WHERE u.user_id = @user_id AND p.is_active = 1
        ),
        -- Existence check, deliberately separate from the ACL chain below.
        --
        -- Deletion propagates down the whole subtree; ACL inheritance does not.
        -- A folder that breaks inheritance still ceases to exist when an ancestor
        -- is deleted, so this must be evaluated over the materialized path rather
        -- than over the (possibly severed) permission chain. Any ancestor-or-self
        -- has an mpath that is a prefix of the target's, so one indexed prefix
        -- match answers "is anything above me deleted?".
        live AS (
          SELECT f.folder_id
            FROM dbo.folders f
           WHERE f.folder_id = @folder_id
             AND f.is_deleted = 0
             AND NOT EXISTS (
                   SELECT 1
                     FROM dbo.folders anc
                    WHERE anc.is_deleted = 1
                      AND f.mpath LIKE anc.mpath + '%'
                 )
        ),
        -- The folder and its ancestors, walking up only while inheritance is
        -- unbroken. The folder that breaks inheritance is itself included;
        -- nothing above it is.
        chain AS (
          SELECT f.folder_id, f.parent_id, f.inherits_acl, 0 AS lvl
            FROM dbo.folders f
           WHERE f.folder_id = @folder_id AND f.is_deleted = 0
          UNION ALL
          SELECT p.folder_id, p.parent_id, p.inherits_acl, c.lvl + 1
            FROM chain c
            JOIN dbo.folders p ON p.folder_id = c.parent_id AND p.is_deleted = 0
           WHERE c.inherits_acl = 1 AND c.lvl < 32
        ),
        -- SQL Server 2019 has no aggregate bitwise OR (BIT_OR arrived in 2022), so
        -- each verb is OR-ed independently: MAX over a single masked bit is that
        -- bit if any row carries it. Exact, and it stays a simple stream aggregate.
        grants AS (
          SELECT
            ISNULL(MAX(ace.allow_bits & 1 ), 0) | ISNULL(MAX(ace.allow_bits & 2 ), 0) |
            ISNULL(MAX(ace.allow_bits & 4 ), 0) | ISNULL(MAX(ace.allow_bits & 8 ), 0) |
            ISNULL(MAX(ace.allow_bits & 16), 0) | ISNULL(MAX(ace.allow_bits & 32), 0) AS allow_bits,
            ISNULL(MAX(ace.deny_bits  & 1 ), 0) | ISNULL(MAX(ace.deny_bits  & 2 ), 0) |
            ISNULL(MAX(ace.deny_bits  & 4 ), 0) | ISNULL(MAX(ace.deny_bits  & 8 ), 0) |
            ISNULL(MAX(ace.deny_bits  & 16), 0) | ISNULL(MAX(ace.deny_bits  & 32), 0) AS deny_bits
          FROM dbo.access_control_entries ace
          JOIN chain c ON c.folder_id = ace.folder_id
          JOIN dbo.fn_expand_principals(@user_id) xp ON xp.principal_id = ace.principal_id
        )
        SELECT
          CASE
            -- No such user, or deactivated.
            WHEN NOT EXISTS (SELECT 1 FROM usr) THEN 0
            -- Folder missing, soft-deleted, or beneath a soft-deleted ancestor.
            -- Checked here so every caller inherits it and none can forget to
            -- join back to the tree — the reported bypass was exactly a hot query
            -- that filtered documents but never re-checked the folder.
            WHEN NOT EXISTS (SELECT 1 FROM live) THEN 0
            WHEN (SELECT TOP 1 is_super_admin FROM usr) = 1 THEN ${ALL_PERMS}
            -- DENY beats ALLOW globally: no proximity precedence, so a deny
            -- anywhere in the applicable chain wins.
            ELSE ISNULL((SELECT allow_bits & ~deny_bits FROM grants), 0)
          END AS perm_bits
      );
    `).execute(trx);
  },
};
