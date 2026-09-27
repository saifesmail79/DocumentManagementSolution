import { sql } from 'kysely';

/**
 * The storage reconciler learns a fourth kind of file: a letter-format template.
 *
 * 0014 constrained `storage_reconciliation.kind` to the three kinds that
 * existed — a document version, a constituent file, a rendition. Letter formats
 * (0019) store the institute's own Word templates as blobs, and the reconciler
 * reports them under kind 'template' so a storage-root move that left them
 * behind is reported as data loss, not as a remakeable derivative. Without
 * this the first missing template made the MERGE violate the CHECK and the
 * whole reconciliation sweep threw — reporting nothing at all, including the
 * document versions the operator was actually looking for.
 *
 * Dropped and re-added rather than altered, because SQL Server has no ALTER
 * for a CHECK constraint. WITH NOCHECK so existing rows are not re-validated;
 * every one of them already satisfies the wider list.
 */
export const m0022ReconciliationTemplateKind = {
  id: '0022',
  name: 'storage reconciliation accepts the template kind',

  async up(trx) {
    await sql`
      IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_storage_recon_kind')
        ALTER TABLE dbo.storage_reconciliation DROP CONSTRAINT CK_storage_recon_kind;
    `.execute(trx);

    await sql`
      IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_storage_recon_kind')
        ALTER TABLE dbo.storage_reconciliation WITH NOCHECK
          ADD CONSTRAINT CK_storage_recon_kind CHECK (kind IN ('version', 'file', 'rendition', 'template'));
    `.execute(trx);
  },
};
