/**
 * Migration 0014 — the outstanding-file list a storage move leaves behind.
 *
 * ─── Why moving the root needs a list at all ────────────────────────────────
 *
 * `storage_path` is stored relative to the root — migration 0002 says so
 * explicitly, and it is what makes the root movable without rewriting a single
 * row. Pointing the system at a new location is therefore a one-line change.
 *
 * What is *not* instant is the copying. A terabyte of scans does not move
 * atomically, and the administrator will point the system at the new location
 * before the copy has finished, or the copy will skip files, or a share will
 * drop halfway. Without somewhere to record it, the only way to find out which
 * documents are unreachable is to open them one at a time.
 *
 * This table is that record: one row per file the system expected and could not
 * find, surviving restarts, so the work can be done in sessions — copy some,
 * re-run the check, watch the number fall to zero.
 *
 * ─── One row per path, updated in place ─────────────────────────────────────
 *
 * Keyed on `storage_path` rather than appended per run, so re-checking updates
 * the same rows instead of growing a history nobody reads. `resolved_at` marks
 * the ones a later run found, which is what lets the screen show progress
 * rather than just a shrinking list.
 */

import { sql } from 'kysely';

export const m0014StorageReconciliation = {
  id: '0014',
  name: 'storage_reconciliation, for files outstanding after a storage move',

  async up(trx) {
    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'storage_reconciliation')
      BEGIN
        CREATE TABLE dbo.storage_reconciliation (
          recon_id       bigint         IDENTITY(1,1) NOT NULL,
          -- NVARCHAR: the path embeds the sanitised Arabic title, same reason as
          -- document_versions.storage_path.
          storage_path   nvarchar(1000) NOT NULL,
          kind           varchar(12)    NOT NULL,
          document_id    bigint         NULL,
          title          nvarchar(400)  NULL,
          expected_bytes bigint         NULL,
          -- The root it was last checked against, so a report from before a move
          -- is not mistaken for one from after it.
          checked_root   nvarchar(1000) NOT NULL,
          first_seen_at  datetime2(3)   NOT NULL
            CONSTRAINT DF_storage_recon_first_seen DEFAULT SYSUTCDATETIME(),
          last_checked_at datetime2(3)  NOT NULL
            CONSTRAINT DF_storage_recon_checked DEFAULT SYSUTCDATETIME(),
          -- NULL while the file is still missing; set the moment a run finds it.
          resolved_at    datetime2(3)   NULL,
          CONSTRAINT PK_storage_reconciliation PRIMARY KEY (recon_id),
          CONSTRAINT UQ_storage_reconciliation UNIQUE (storage_path),
          CONSTRAINT CK_storage_recon_kind CHECK (kind IN ('version', 'file', 'rendition'))
        );

        -- The screen's only query: what is still outstanding, oldest first.
        CREATE INDEX IX_storage_recon_pending
          ON dbo.storage_reconciliation (resolved_at, document_id)
          WHERE resolved_at IS NULL;
      END
    `.execute(trx);
  },
};
