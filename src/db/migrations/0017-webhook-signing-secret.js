import { sql } from 'kysely';

/**
 * Webhook signing secrets the server can actually sign with.
 *
 * ─── What was wrong ─────────────────────────────────────────────────────────
 *
 * 0009 stored only a SHA-256 of each webhook's secret, on the model of API keys
 * and sessions: never keep a credential readable. The model does not transfer.
 * An API key is presented *to* this system, so a hash is enough to recognise
 * it. A webhook secret is used *by* this system to sign what it sends, and a
 * signer that holds only the hash cannot sign. Deliveries went out with no
 * signature at all while the administration screen promised one.
 *
 * ─── The trade ──────────────────────────────────────────────────────────────
 *
 * The secret is now stored readable, like any other outbound credential. A
 * database backup that yields it lets its holder forge deliveries to that one
 * receiver; it grants nothing inside this system. The hash column is dropped
 * rather than left beside the secret, so there is exactly one thing to reason
 * about.
 *
 * ─── Existing rows ──────────────────────────────────────────────────────────
 *
 * Their secrets are unrecoverable, so they stay NULL: deliveries continue,
 * unsigned, and the administration list marks them so the secret can be
 * rotated and the new one handed to the receiver. Refusing to deliver until
 * then would break every running integration on upgrade, for a property none
 * of them ever had.
 */
export const m0017WebhookSigningSecret = {
  id: '0017',
  name: 'webhook secrets stored for signing',

  async up(trx) {
    await sql`
      IF COL_LENGTH('dbo.webhooks', 'secret') IS NULL
        ALTER TABLE dbo.webhooks ADD secret varchar(100) COLLATE Latin1_General_BIN2 NULL;
    `.execute(trx);

    await sql`
      IF COL_LENGTH('dbo.webhooks', 'secret_hash') IS NOT NULL
        ALTER TABLE dbo.webhooks DROP COLUMN secret_hash;
    `.execute(trx);
  },
};
