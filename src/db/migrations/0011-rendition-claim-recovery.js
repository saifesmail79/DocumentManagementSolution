/**
 * Migration 0011 — rendition_queue.started_at.
 *
 * ─── The failure this exists to fix ─────────────────────────────────────────
 *
 * A worker that dies mid-job — the process killed, the server restarted during
 * a conversion — leaves its row in RUNNING. The extraction queue recovers from
 * that: it records `started_at` when it claims, and treats a claim older than
 * its stale window as abandoned. The rendition queue never got the same
 * treatment. Its `claim()` selects only PENDING and RETRYABLE, so a row left in
 * RUNNING is invisible to every worker forever.
 *
 * The document is then stored, listed, searchable — and has no thumbnail, with
 * nothing anywhere reporting a problem. Three rows were sitting in exactly that
 * state on this deployment, two of them created by a routine restart.
 *
 * `queued_at` could not stand in for this. It records when the job was
 * enqueued, not when it was claimed, so a job that waited an hour in PENDING
 * and was picked up a moment ago looks equally abandoned — and reclaiming it
 * would run two conversions of the same file at once.
 *
 * Nullable with no default: a row that has never been claimed has no start
 * time, and that is the honest representation. Existing RUNNING rows therefore
 * come out of this migration with NULL, which the reclaim treats as abandoned —
 * correct, since they are the very rows that were stranded.
 */

import { sql } from 'kysely';

export const m0011RenditionClaimRecovery = {
  id: '0011',
  name: 'rendition_queue.started_at, so abandoned claims can be recovered',

  async up(trx) {
    await sql`
      IF COL_LENGTH('dbo.rendition_queue', 'started_at') IS NULL
        ALTER TABLE dbo.rendition_queue ADD started_at datetime2(3) NULL;
    `.execute(trx);
  },
};
