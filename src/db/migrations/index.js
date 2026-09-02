/**
 * The migration manifest.
 *
 * This array IS the schema. Every table, column, index and constraint the
 * application depends on is created by an entry here, so a fresh database and a
 * long-running one converge on exactly the same shape, and no deployment ever
 * needs SQL run by hand.
 *
 * Rules:
 *   • Append only. Never edit a migration that has been applied anywhere — the
 *     runner compares checksums and will refuse to start. Add a new one instead.
 *   • Ids are zero-padded and must stay in ascending order.
 *   • Each `up` receives an executor (a transaction, or a pinned connection for
 *     non-transactional migrations) and should use `sql` template literals.
 *   • Set `transactional: false` only for statements SQL Server forbids inside a
 *     transaction — full-text catalogue and index DDL. Those must be written to be
 *     safely re-runnable, because they cannot roll back.
 *
 * Conventions used throughout:
 *   • snake_case tables and columns; PK_/FK_/IX_/UQ_/CK_/DF_ constraint prefixes.
 *   • All user-facing text is NVARCHAR with Arabic_CI_AI collation — case- and
 *     accent-insensitive, so Arabic variants compare equal in ordinary WHERE
 *     clauses as well as in full-text search.
 *   • Timestamps are datetime2(3) in UTC, defaulted with SYSUTCDATETIME().
 */

import { m0001IdentityAndAcl } from './0001-identity-and-acl.js';
import { m0002DocumentsAndMetadata } from './0002-documents-and-metadata.js';
import { m0003Sessions } from './0003-sessions.js';
import { m0004Search } from './0004-search.js';
import { m0005AuditAndReset } from './0005-audit-and-reset.js';
import { m0006SettingsAndFieldTypes } from './0006-settings-and-field-types.js';
import { m0007WidenDataType } from './0007-widen-data-type.js';
import { m0008Collaboration } from './0008-collaboration.js';
import { m0009Integration } from './0009-integration.js';
import { m0010ExpandGroupMembers } from './0010-expand-group-members.js';
import { m0011RenditionClaimRecovery } from './0011-rendition-claim-recovery.js';
import { m0012MultiFileDocuments } from './0012-multi-file-documents.js';
import { m0013PerFileRenditions } from './0013-per-file-renditions.js';
import { m0014StorageReconciliation } from './0014-storage-reconciliation.js';
import { m0015UserPreferences } from './0015-user-preferences.js';
import { m0016ClassificationPilot } from './0016-classification-pilot.js';

/**
 * @typedef {object} Migration
 * @property {string} id                zero-padded, ascending, e.g. '0001'
 * @property {string} name              short description, appears in logs
 * @property {boolean} [transactional]  false only for full-text DDL; defaults true
 * @property {(executor: unknown) => Promise<void>} up
 */

/** @type {Migration[]} */
export const MIGRATIONS = [
  m0001IdentityAndAcl,
  m0002DocumentsAndMetadata,
  m0003Sessions,
  m0004Search,
  m0005AuditAndReset,
  m0006SettingsAndFieldTypes,
  m0007WidenDataType,
  m0008Collaboration,
  m0009Integration,
  m0010ExpandGroupMembers,
  m0011RenditionClaimRecovery,
  m0012MultiFileDocuments,
  m0013PerFileRenditions,
  m0014StorageReconciliation,
  m0015UserPreferences,
  m0016ClassificationPilot,
];
