/**
 * The correspondence register (الوارد والصادر) — phase 1, the manual process.
 *
 * ─── One rule shapes everything here ────────────────────────────────────────
 *
 * A letter is an ordinary document plus a register row. The document never
 * moves when the letter is routed: forwarding writes a transfer row and
 * notifies the unit's members, which is how one circular can sit with five
 * departments at once, each with its own status, and how "where is letter
 * 483/2026" stays answerable after every department has finished with it.
 *
 * Access follows from that split. The DOCUMENT is governed by its folder's
 * ACL, unchanged. The REGISTER is governed by role: mail-room members (the
 * group named by the `correspondence.mailroom_group` setting) and super
 * admins keep the book; unit members see the transfers addressed to their
 * units. Nothing here grants anyone a byte of document content — a transfer
 * to a unit whose members lack READ on the letter's folder shows them the
 * register facts and an explanation, exactly like the approvals list.
 *
 * ─── Numbering ──────────────────────────────────────────────────────────────
 *
 * The number is drawn from the (direction, year) counter inside the
 * registration transaction under HOLDLOCK, so two clerks cannot draw the same
 * number. Annulment keeps the row and the number — a government book has no
 * erasures, only lines through entries.
 */

import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, has } from '../tree/service.js';
import { getSetting } from '../settings/service.js';
import { notifyMany, KIND } from '../notifications/service.js';
import { documentPermission } from '../collaboration/service.js';

const log = moduleLogger('correspondence');

export const DIRECTIONS = Object.freeze(['in', 'out']);
export const LETTER_STATUSES = Object.freeze(['registered', 'routed', 'done', 'sent', 'annulled']);
export const TRANSFER_PURPOSES = Object.freeze(['action', 'info']);

/** The stored switch. Off means every route answers "disabled" and no row is written. */
export async function isEnabled() {
  return Boolean(await getSetting('correspondence.enabled'));
}

/**
 * Whether this user keeps the register.
 *
 * Membership in the configured mail-room group, expanded through nested
 * groups; super admins qualify regardless so a fresh install can be operated
 * before the group is designated.
 */
export async function isRegistrar({ userId, isSuperAdmin = false }) {
  if (isSuperAdmin) return true;

  const groupId = Number(await getSetting('correspondence.mailroom_group'));
  if (!groupId) return false;

  const result = await sql`
    SELECT COUNT(*) AS n FROM dbo.fn_expand_principals(${userId})
     WHERE principal_id = ${groupId}
  `.execute(db);
  return Number(result.rows[0].n) > 0;
}

/**
 * What the client needs before showing anything: the switch, the caller's
 * role, whether the caller belongs to a unit at all, the live units for
 * pickers and queue labels, how many letters are waiting on the caller's
 * units (the badge), and where the intake screen scans to.
 */
export async function mailStatus({ userId, isSuperAdmin = false }) {
  if (!(await isEnabled())) return { enabled: false };

  const [registrar, units, waiting, belongs, intakeFolder] = await Promise.all([
    isRegistrar({ userId, isSuperAdmin }),
    listUnits({ includeInactive: false }),
    sql`
      SELECT COUNT(*) AS n
        FROM dbo.correspondence_transfers t
        JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
       WHERE t.status IN ('pending', 'received')
         AND u.group_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
    `.execute(db),
    // Does this person belong to a live unit — the answer that decides whether
    // «الوارد إليّ» exists for them at all. The client cannot work it out from
    // anything else we send: `units` is the whole live list, meant for the
    // routing picker, so it says nothing about who is asking; and `queueCount`
    // is zero both for a unit member whose inbox happens to be empty (who must
    // still be given the tab, because tomorrow's letter arrives there) and for
    // someone in no unit (who must never see it). One number cannot separate
    // "nothing waiting" from "no inbox", so we answer the membership question
    // itself. Same expansion as the badge beside it, so nested groups count,
    // and a deactivated unit counts as no unit. Deliberately no super-admin
    // override: the queue query has none either, so a super admin who is in no
    // unit genuinely has an empty inbox, and promising them a tab would only
    // hand them an empty screen and a badge that never moves.
    sql`
      SELECT COUNT(*) AS n
        FROM dbo.correspondence_units u
       WHERE u.is_active = 1
         AND u.group_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
    `.execute(db),
    getSetting('correspondence.intake_folder'),
  ]);

  return {
    enabled: true,
    registrar,
    member: Number(belongs.rows[0].n) > 0,
    units,
    queueCount: Number(waiting.rows[0].n),
    intakeFolderId: Number(intakeFolder) ? String(intakeFolder) : null,
  };
}

// ── Units ────────────────────────────────────────────────────────────────

export async function listUnits({ includeInactive = false } = {}) {
  const result = await sql`
    SELECT u.unit_id, u.name, u.group_id, u.archive_folder_id, u.is_active,
           g.display_name AS group_name, f.name AS archive_folder_name
      FROM dbo.correspondence_units u
      JOIN dbo.principals g ON g.principal_id = u.group_id
      LEFT JOIN dbo.folders f ON f.folder_id = u.archive_folder_id
     WHERE (${includeInactive ? 1 : 0} = 1 OR u.is_active = 1)
     ORDER BY u.name
  `.execute(db);

  return result.rows.map((row) => ({
    unitId: String(row.unit_id),
    name: row.name,
    groupId: String(row.group_id),
    groupName: row.group_name,
    archiveFolderId: row.archive_folder_id === null ? null : String(row.archive_folder_id),
    archiveFolderName: row.archive_folder_name ?? null,
    isActive: Number(row.is_active) === 1,
  }));
}

export async function createUnit({ name, groupId, archiveFolderId = null }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.length > 200) return { ok: false, reason: 'invalid_name' };

  const group = await sql`
    SELECT principal_id FROM dbo.principals
     WHERE principal_id = ${groupId} AND principal_type = 'group' AND is_active = 1
  `.execute(db);
  if (!group.rows[0]) return { ok: false, reason: 'group_not_found' };

  try {
    const inserted = await sql`
      INSERT INTO dbo.correspondence_units (name, group_id, archive_folder_id)
      OUTPUT INSERTED.unit_id AS unit_id
      VALUES (${trimmed}, ${groupId}, ${archiveFolderId})
    `.execute(db);
    return { ok: true, unitId: String(inserted.rows[0].unit_id) };
  } catch (error) {
    if (/UX_correspondence_units_name|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    throw error;
  }
}

export async function updateUnit({ unitId, name, groupId, archiveFolderId = null }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.length > 200) return { ok: false, reason: 'invalid_name' };

  const group = await sql`
    SELECT principal_id FROM dbo.principals
     WHERE principal_id = ${groupId} AND principal_type = 'group' AND is_active = 1
  `.execute(db);
  if (!group.rows[0]) return { ok: false, reason: 'group_not_found' };

  try {
    const result = await sql`
      UPDATE dbo.correspondence_units
         SET name = ${trimmed}, group_id = ${groupId}, archive_folder_id = ${archiveFolderId}
       WHERE unit_id = ${unitId}
    `.execute(db);
    if (Number(result.numAffectedRows ?? 0) === 0) return { ok: false, reason: 'not_found' };
    return { ok: true };
  } catch (error) {
    if (/UX_correspondence_units_name|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    throw error;
  }
}

export async function setUnitActive({ unitId, active }) {
  // Deactivating a unit with open transfers would strand them in a queue
  // nobody looks at; the mail room reroutes or closes them first.
  if (!active) {
    const open = await sql`
      SELECT COUNT(*) AS n FROM dbo.correspondence_transfers
       WHERE unit_id = ${unitId} AND status IN ('pending', 'received')
    `.execute(db);
    if (Number(open.rows[0].n) > 0) {
      return { ok: false, reason: 'unit_has_open_transfers', open: Number(open.rows[0].n) };
    }
  }

  const result = await sql`
    UPDATE dbo.correspondence_units SET is_active = ${active ? 1 : 0} WHERE unit_id = ${unitId}
  `.execute(db);
  if (Number(result.numAffectedRows ?? 0) === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

// ── Counters ─────────────────────────────────────────────────────────────

/** Both books for one year, with the highest number already issued. */
export async function getCounters({ year }) {
  const bookYear = Number(year) || new Date().getUTCFullYear();

  const counters = await sql`
    SELECT direction, next_number FROM dbo.correspondence_counters WHERE book_year = ${bookYear}
  `.execute(db);
  const issued = await sql`
    SELECT direction, MAX(book_number) AS highest FROM dbo.correspondence
     WHERE book_year = ${bookYear} GROUP BY direction
  `.execute(db);

  const nextOf = new Map(counters.rows.map((row) => [row.direction, Number(row.next_number)]));
  const highestOf = new Map(issued.rows.map((row) => [row.direction, Number(row.highest)]));

  return {
    year: bookYear,
    books: DIRECTIONS.map((direction) => ({
      direction,
      nextNumber: nextOf.get(direction) ?? 1,
      highestIssued: highestOf.get(direction) ?? 0,
    })),
  };
}

/**
 * Sets where a book continues from — the migration path from a paper register
 * already part-way through its year. Never below a number already issued:
 * the book must not repeat itself.
 */
export async function setCounter({ direction, year, nextNumber }) {
  const bookYear = Number(year);
  const next = Number(nextNumber);
  if (!DIRECTIONS.includes(direction)) return { ok: false, reason: 'invalid_direction' };
  if (!Number.isInteger(bookYear) || bookYear < 2000 || bookYear > 2200) {
    return { ok: false, reason: 'invalid_year' };
  }
  if (!Number.isInteger(next) || next < 1) return { ok: false, reason: 'invalid_value' };

  const issued = await sql`
    SELECT MAX(book_number) AS highest FROM dbo.correspondence
     WHERE direction = ${direction} AND book_year = ${bookYear}
  `.execute(db);
  const highest = Number(issued.rows[0].highest ?? 0);
  if (next <= highest) return { ok: false, reason: 'below_issued', highestIssued: highest };

  await sql`
    MERGE dbo.correspondence_counters WITH (HOLDLOCK) AS target
    USING (SELECT ${direction} AS direction, ${bookYear} AS book_year) AS source
       ON target.direction = source.direction AND target.book_year = source.book_year
    WHEN MATCHED THEN UPDATE SET next_number = ${next}
    WHEN NOT MATCHED THEN
      INSERT (direction, book_year, next_number) VALUES (source.direction, source.book_year, ${next});
  `.execute(db);

  return { ok: true };
}

/** Draws the next number for a book, atomically, inside the caller's transaction. */
async function drawNumber(trx, { direction, year }) {
  const result = await sql`
    MERGE dbo.correspondence_counters WITH (HOLDLOCK) AS target
    USING (SELECT ${direction} AS direction, ${year} AS book_year) AS source
       ON target.direction = source.direction AND target.book_year = source.book_year
    WHEN MATCHED THEN UPDATE SET next_number = target.next_number + 1
    WHEN NOT MATCHED THEN
      INSERT (direction, book_year, next_number) VALUES (source.direction, source.book_year, 2)
    OUTPUT ISNULL(DELETED.next_number, 1) AS drawn;
  `.execute(trx);
  return Number(result.rows[0].drawn);
}

// ── Registration ─────────────────────────────────────────────────────────

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** Dates travel as ISO text, never as bound JS Dates — see the audit module's note. */
function dateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return DATE_TEXT.test(text) ? text : undefined;
}

function normalizeTransfers(transfers) {
  if (transfers === null || transfers === undefined) return [];
  if (!Array.isArray(transfers)) return undefined;

  const seen = new Set();
  const result = [];
  for (const entry of transfers) {
    const unitId = String(entry?.unitId ?? '').trim();
    if (!/^[0-9]{1,19}$/.test(unitId) || seen.has(unitId)) return undefined;
    seen.add(unitId);

    const purpose = entry?.purpose ?? 'action';
    if (!TRANSFER_PURPOSES.includes(purpose)) return undefined;

    const dueDate = dateOrNull(entry?.dueDate);
    if (dueDate === undefined) return undefined;

    result.push({ unitId, purpose, dueDate });
  }
  return result;
}

/**
 * Registers a document in the book and optionally routes it in the same act —
 * scan, register, forward is one visit to one screen for the mail room.
 */
export async function registerLetter({
  userId,
  isSuperAdmin = false,
  documentId,
  direction,
  subject = null,
  externalParty = null,
  externalRef = null,
  externalDate = null,
  unitId = null,
  transfers = [],
}) {
  if (!(await isRegistrar({ userId, isSuperAdmin }))) return { ok: false, reason: 'not_registrar' };
  if (!DIRECTIONS.includes(direction)) return { ok: false, reason: 'invalid_direction' };

  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const document = await sql`
    SELECT d.document_id, d.title, d.folder_id FROM dbo.documents d
     WHERE d.document_id = ${documentId} AND d.is_deleted = 0
  `.execute(db);
  if (!document.rows[0]) return { ok: false, reason: 'not_found' };

  const subjectText = String(subject ?? '').trim() || document.rows[0].title;
  if (subjectText.length > 500) return { ok: false, reason: 'invalid_subject' };

  const externalDateText = dateOrNull(externalDate);
  if (externalDateText === undefined) return { ok: false, reason: 'invalid_date' };

  const routed = normalizeTransfers(transfers);
  if (routed === undefined) return { ok: false, reason: 'invalid_transfers' };
  if (routed.length > 0 && direction !== 'in') return { ok: false, reason: 'invalid_transfers' };

  if (routed.length > 0) {
    const liveUnits = new Set((await listUnits()).map((unit) => unit.unitId));
    for (const entry of routed) {
      if (!liveUnits.has(entry.unitId)) return { ok: false, reason: 'unit_not_found' };
    }
  }

  if (unitId !== null && unitId !== undefined && unitId !== '') {
    const owner = await sql`
      SELECT unit_id FROM dbo.correspondence_units WHERE unit_id = ${unitId} AND is_active = 1
    `.execute(db);
    if (!owner.rows[0]) return { ok: false, reason: 'unit_not_found' };
  }

  const year = new Date().getUTCFullYear();
  const status = direction === 'out' ? 'registered' : routed.length > 0 ? 'routed' : 'registered';

  let letter;
  try {
    letter = await db.transaction().execute(async (trx) => {
      const number = await drawNumber(trx, { direction, year });

      const inserted = await sql`
        INSERT INTO dbo.correspondence
          (document_id, direction, book_year, book_number, subject,
           external_party, external_ref, external_date, unit_id, status, registered_by)
        OUTPUT INSERTED.correspondence_id AS id
        VALUES
          (${documentId}, ${direction}, ${year}, ${number}, ${subjectText},
           ${externalParty ? String(externalParty).slice(0, 300) : null},
           ${externalRef ? String(externalRef).slice(0, 100) : null},
           ${externalDateText}, ${unitId || null}, ${status}, ${userId})
      `.execute(trx);
      const letterId = String(inserted.rows[0].id);

      for (const entry of routed) {
        await sql`
          INSERT INTO dbo.correspondence_transfers
            (correspondence_id, unit_id, purpose, due_date, routed_by)
          VALUES (${letterId}, ${entry.unitId}, ${entry.purpose}, ${entry.dueDate}, ${userId})
        `.execute(trx);
      }

      return { letterId, number };
    });
  } catch (error) {
    if (/UQ_correspondence_document|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'already_registered' };
    }
    throw error;
  }

  if (routed.length > 0) {
    await notifyTransfers({
      unitIds: routed.map((entry) => entry.unitId),
      letter: {
        number: letter.number,
        year,
        subject: subjectText,
        documentId: document.rows[0].document_id,
        folderId: document.rows[0].folder_id,
      },
    });
  }

  log.info(
    { letterId: letter.letterId, direction, number: `${letter.number}/${year}` },
    'letter registered',
  );
  return {
    ok: true,
    letterId: letter.letterId,
    bookNumber: letter.number,
    bookYear: year,
    reference: `${letter.number}/${year}`,
  };
}

/** Every member of every routed unit gets the notice; the transfer IS the notification. */
async function notifyTransfers({ unitIds, letter }) {
  const units = await sql`
    SELECT u.unit_id, u.name, m.principal_id AS user_id
      FROM dbo.correspondence_units u
     CROSS APPLY dbo.fn_expand_group_members(u.group_id) m
     WHERE u.unit_id IN (${sql.join(unitIds.map((id) => sql`${id}`))})
  `.execute(db);

  const byUnit = new Map();
  for (const row of units.rows) {
    const list = byUnit.get(String(row.unit_id)) ?? { name: row.name, userIds: [] };
    list.userIds.push(String(row.user_id));
    byUnit.set(String(row.unit_id), list);
  }

  for (const { name, userIds } of byUnit.values()) {
    await notifyMany({
      userIds,
      kind: KIND.MAIL_ASSIGNED,
      title: `كتاب وارد ${letter.number}/${letter.year} محال إلى ${name}`,
      body: letter.subject,
      documentId: letter.documentId,
      folderId: letter.folderId,
    });
  }
}

// ── Reading the register ─────────────────────────────────────────────────

function toLetter(row) {
  return {
    letterId: String(row.correspondence_id),
    documentId: String(row.document_id),
    direction: row.direction,
    bookNumber: Number(row.book_number),
    bookYear: Number(row.book_year),
    reference: `${row.book_number}/${row.book_year}`,
    subject: row.subject,
    externalParty: row.external_party,
    externalRef: row.external_ref,
    externalDate: row.external_date,
    unitId: row.unit_id === null ? null : String(row.unit_id),
    unitName: row.unit_name ?? null,
    status: row.status,
    annulReason: row.annul_reason,
    registeredBy: row.registered_by_name ?? null,
    registeredAt: row.registered_at,
    documentTitle: row.document_title ?? null,
    canRead: row.can_read === undefined ? undefined : Number(row.can_read) === 1,
  };
}

function toTransfer(row) {
  return {
    transferId: String(row.transfer_id),
    unitId: String(row.unit_id),
    unitName: row.unit_name,
    purpose: row.purpose,
    status: row.status,
    dueDate: row.due_date,
    note: row.note,
    routedAt: row.routed_at,
    routedBy: row.routed_by_name ?? null,
    receivedAt: row.received_at,
    receivedBy: row.received_by_name ?? null,
    closedAt: row.closed_at,
    closedBy: row.closed_by_name ?? null,
    closeNote: row.close_note,
    overdue:
      row.due_date !== null
      && ['pending', 'received'].includes(row.status)
      && new Date(row.due_date) < new Date(new Date().toISOString().slice(0, 10)),
  };
}

const LETTER_SELECT = sql`
  SELECT c.correspondence_id, c.document_id, c.direction, c.book_year, c.book_number,
         c.subject, c.external_party, c.external_ref, c.external_date, c.unit_id,
         c.status, c.annul_reason, c.registered_at,
         u.name AS unit_name, p.display_name AS registered_by_name, d.title AS document_title
    FROM dbo.correspondence c
    JOIN dbo.documents d ON d.document_id = c.document_id
    JOIN dbo.principals p ON p.principal_id = c.registered_by
    LEFT JOIN dbo.correspondence_units u ON u.unit_id = c.unit_id
`;

/**
 * The register list. Registrars only — the queue is everyone else's window.
 *
 * Each letter carries a summary of its transfers, because the letter-level
 * status deliberately compresses them ("محال" says nothing about WHICH
 * department is sitting on it) and the mail room's first question in front of
 * the book is exactly that.
 */
export async function listLetters({
  direction = null,
  year = null,
  status = null,
  q = null,
  limit = 100,
} = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const query = q ? `%${String(q).trim()}%` : null;
  const bookYear = year ? Number(year) : null;

  const result = await sql`
    ${LETTER_SELECT}
   WHERE (${direction} IS NULL OR c.direction = ${direction})
     AND (${bookYear} IS NULL OR c.book_year = ${bookYear})
     AND (${status} IS NULL OR c.status = ${status})
     AND (${query} IS NULL OR c.subject LIKE ${query} OR c.external_party LIKE ${query}
          OR c.external_ref LIKE ${query})
   ORDER BY c.book_year DESC, c.book_number DESC
   OFFSET 0 ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `.execute(db);

  const letters = result.rows.map(toLetter);
  if (letters.length === 0) return letters;

  const transfers = await sql`
    SELECT t.correspondence_id, t.unit_id, t.purpose, t.status, t.due_date, t.routed_at,
           u.name AS unit_name
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
     WHERE t.correspondence_id IN (${sql.join(letters.map((l) => sql`${l.letterId}`))})
     ORDER BY t.routed_at, t.transfer_id
  `.execute(db);

  const byLetter = new Map();
  for (const row of transfers.rows) {
    const key = String(row.correspondence_id);
    const list = byLetter.get(key) ?? [];
    list.push({
      unitName: row.unit_name,
      purpose: row.purpose,
      status: row.status,
      dueDate: row.due_date,
      overdue:
        row.due_date !== null
        && ['pending', 'received'].includes(row.status)
        && new Date(row.due_date) < new Date(new Date().toISOString().slice(0, 10)),
    });
    byLetter.set(key, list);
  }

  return letters.map((letter) => ({ ...letter, transfers: byLetter.get(letter.letterId) ?? [] }));
}

/** One letter with its transfers, for the register detail and the document panel. */
export async function getLetter({ letterId }) {
  const found = await sql`
    ${LETTER_SELECT}
   WHERE c.correspondence_id = ${letterId}
  `.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  const transfers = await sql`
    SELECT t.transfer_id, t.unit_id, t.purpose, t.status, t.due_date, t.note,
           t.routed_at, t.received_at, t.closed_at, t.close_note,
           u.name AS unit_name,
           rp.display_name AS routed_by_name,
           vp.display_name AS received_by_name,
           cp.display_name AS closed_by_name
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
      JOIN dbo.principals rp ON rp.principal_id = t.routed_by
      LEFT JOIN dbo.principals vp ON vp.principal_id = t.received_by
      LEFT JOIN dbo.principals cp ON cp.principal_id = t.closed_by
     WHERE t.correspondence_id = ${letterId}
     ORDER BY t.routed_at, t.transfer_id
  `.execute(db);

  return { ok: true, letter: toLetter(found.rows[0]), transfers: transfers.rows.map(toTransfer) };
}

/**
 * The register entry behind one document, for the document page's panel.
 * Requires READ on the document — the same gate as every other panel.
 *
 * Each transfer is marked `mine` when the caller belongs to its unit's group,
 * so the panel can offer تسلّم/إنجاز right where the person is already
 * reading the letter, instead of sending them back to the queue.
 */
export async function letterForDocument({ userId, documentId }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const found = await sql`
    SELECT correspondence_id FROM dbo.correspondence WHERE document_id = ${documentId}
  `.execute(db);
  if (!found.rows[0]) return { ok: true, registered: false };

  const letterId = String(found.rows[0].correspondence_id);
  const detail = await getLetter({ letterId });
  if (!detail.ok) return { ok: true, registered: false };

  const actable = await sql`
    SELECT t.transfer_id
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
     WHERE t.correspondence_id = ${letterId}
       AND u.group_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
  `.execute(db);
  const mine = new Set(actable.rows.map((row) => String(row.transfer_id)));

  return {
    ok: true,
    registered: true,
    letter: detail.letter,
    transfers: detail.transfers.map((transfer) => ({
      ...transfer,
      mine: mine.has(transfer.transferId),
    })),
  };
}

// ── The queue and المتابعة ───────────────────────────────────────────────

/**
 * Transfers addressed to any unit whose group the user belongs to.
 *
 * `scope` 'open' is the working queue; 'all' is the department's archive —
 * every letter ever routed to it, closed ones included, newest first, with a
 * text filter. That is how a department reaches its ten-thousandth letter:
 * through the register and search, never by browsing a folder.
 *
 * `canRead` rides along so the client can offer the document or explain why
 * not — the register facts themselves are the unit's business either way.
 */
export async function myQueue({ userId, scope = 'open', q = null, limit = 100 }) {
  const openOnly = scope !== 'all';
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const query = q ? `%${String(q).trim()}%` : null;

  const result = await sql`
    SELECT TOP (${pageSize})
           t.transfer_id, t.unit_id, t.purpose, t.status, t.due_date, t.note,
           t.routed_at, t.received_at, t.closed_at, t.close_note,
           u.name AS unit_name, rp.display_name AS routed_by_name,
           NULL AS received_by_name, NULL AS closed_by_name,
           c.correspondence_id, c.document_id, c.book_number, c.book_year,
           c.subject, c.external_party, c.status AS letter_status,
           d.title AS document_title, d.folder_id,
           CASE WHEN (perm.perm_bits & ${PERM.READ}) = ${PERM.READ} THEN 1 ELSE 0 END AS can_read
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
      JOIN dbo.correspondence c ON c.correspondence_id = t.correspondence_id
      JOIN dbo.documents d ON d.document_id = c.document_id
      JOIN dbo.principals rp ON rp.principal_id = t.routed_by
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) perm
     WHERE (${openOnly ? 1 : 0} = 0 OR t.status IN ('pending', 'received'))
       AND u.group_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
       AND (${query} IS NULL OR c.subject LIKE ${query} OR c.external_party LIKE ${query}
            OR CONCAT(c.book_number, '/', c.book_year) LIKE ${query})
     ORDER BY CASE WHEN ${openOnly ? 1 : 0} = 1 THEN t.routed_at END ASC,
              t.routed_at DESC
  `.execute(db);

  return result.rows.map((row) => ({
    ...toTransfer(row),
    letterId: String(row.correspondence_id),
    documentId: String(row.document_id),
    reference: `${row.book_number}/${row.book_year}`,
    subject: row.subject,
    externalParty: row.external_party,
    documentTitle: row.document_title,
    canRead: Number(row.can_read) === 1,
  }));
}

/**
 * Scanned but not yet in the book: the تسجيل كتاب screen's safety net. Lists
 * the intake branch's unregistered documents so a letter cannot sit scanned
 * and forgotten — the screen's whole promise is that nothing skips the book.
 */
export async function unregisteredIntake() {
  const folderId = Number(await getSetting('correspondence.intake_folder'));
  if (!folderId) return { configured: false, documents: [] };

  const folder = await sql`
    SELECT mpath FROM dbo.folders WHERE folder_id = ${folderId} AND is_deleted = 0
  `.execute(db);
  if (!folder.rows[0]) return { configured: false, documents: [] };

  const result = await sql`
    SELECT TOP (100) d.document_id, d.title, d.created_at, f.name AS folder_name
      FROM dbo.documents d
      JOIN dbo.folders f ON f.folder_id = d.folder_id
     WHERE f.mpath LIKE ${`${folder.rows[0].mpath}%`}
       AND d.is_deleted = 0
       AND NOT EXISTS (SELECT 1 FROM dbo.correspondence c WHERE c.document_id = d.document_id)
     ORDER BY d.created_at DESC
  `.execute(db);

  return {
    configured: true,
    documents: result.rows.map((row) => ({
      documentId: String(row.document_id),
      title: row.title,
      folderName: row.folder_name,
      createdAt: row.created_at,
    })),
  };
}

/** Every open transfer, oldest first — the mail room's follow-up screen. */
export async function followUp() {
  const result = await sql`
    SELECT t.transfer_id, t.unit_id, t.purpose, t.status, t.due_date, t.note,
           t.routed_at, t.received_at, t.closed_at, t.close_note,
           u.name AS unit_name, rp.display_name AS routed_by_name,
           NULL AS received_by_name, NULL AS closed_by_name,
           c.correspondence_id, c.document_id, c.book_number, c.book_year, c.subject
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
      JOIN dbo.correspondence c ON c.correspondence_id = t.correspondence_id
      JOIN dbo.principals rp ON rp.principal_id = t.routed_by
     WHERE t.status IN ('pending', 'received')
     ORDER BY t.routed_at
  `.execute(db);

  return result.rows.map((row) => ({
    ...toTransfer(row),
    letterId: String(row.correspondence_id),
    documentId: String(row.document_id),
    reference: `${row.book_number}/${row.book_year}`,
    subject: row.subject,
  }));
}

// ── Acting on transfers ──────────────────────────────────────────────────

async function transferForMember({ userId, transferId }) {
  const result = await sql`
    SELECT t.transfer_id, t.correspondence_id, t.unit_id, t.purpose, t.status,
           c.book_number, c.book_year, c.direction, c.status AS letter_status
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
      JOIN dbo.correspondence c ON c.correspondence_id = t.correspondence_id
     WHERE t.transfer_id = ${transferId}
       AND u.group_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
  `.execute(db);
  return result.rows[0] ?? null;
}

/**
 * تسلّم — the unit acknowledges the letter. An information copy is complete
 * the moment it is seen, so it closes in the same gesture.
 */
export async function receiveTransfer({ userId, transferId }) {
  const transfer = await transferForMember({ userId, transferId });
  if (!transfer) return { ok: false, reason: 'not_found' };
  if (transfer.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const isInfo = transfer.purpose === 'info';
  await sql`
    UPDATE dbo.correspondence_transfers
       SET status = ${isInfo ? 'done' : 'received'},
           received_by = ${userId}, received_at = SYSUTCDATETIME(),
           closed_by = ${isInfo ? userId : null},
           closed_at = ${isInfo ? sql`SYSUTCDATETIME()` : null}
     WHERE transfer_id = ${transferId} AND status = 'pending'
  `.execute(db);

  if (isInfo) await settleLetterStatus(String(transfer.correspondence_id));
  return { ok: true };
}

/** منجز — the unit reports the work done, optionally saying what was done. */
export async function closeTransfer({ userId, transferId, note = null }) {
  const transfer = await transferForMember({ userId, transferId });
  if (!transfer) return { ok: false, reason: 'not_found' };
  if (!['pending', 'received'].includes(transfer.status)) return { ok: false, reason: 'not_open' };

  await sql`
    UPDATE dbo.correspondence_transfers
       SET status = 'done',
           received_by = ISNULL(received_by, ${userId}),
           received_at = ISNULL(received_at, SYSUTCDATETIME()),
           closed_by = ${userId}, closed_at = SYSUTCDATETIME(),
           close_note = ${note ? String(note).slice(0, 1000) : null}
     WHERE transfer_id = ${transferId} AND status IN ('pending', 'received')
  `.execute(db);

  await settleLetterStatus(String(transfer.correspondence_id));
  return { ok: true };
}

/**
 * The mail room withdraws a transfer sent to the wrong unit.
 *
 * The reason is mandatory and substantive (five characters at least): a
 * withdrawal is a correction to the routing record, and a correction whose
 * "why" is blank teaches nobody anything when the book is read later.
 */
export async function cancelTransfer({ userId, isSuperAdmin = false, transferId, reason }) {
  if (!(await isRegistrar({ userId, isSuperAdmin }))) return { ok: false, reason: 'not_registrar' };

  const text = String(reason ?? '').trim();
  if (text.length < 5) return { ok: false, reason: 'reason_too_short', minLength: 5 };

  const result = await sql`
    UPDATE dbo.correspondence_transfers
       SET status = 'cancelled', closed_by = ${userId}, closed_at = SYSUTCDATETIME(),
           close_note = ${text.slice(0, 1000)}
    OUTPUT INSERTED.correspondence_id AS letter_id, INSERTED.unit_id AS unit_id
     WHERE transfer_id = ${transferId} AND status IN ('pending', 'received')
  `.execute(db);
  if (!result.rows[0]) return { ok: false, reason: 'not_open' };

  await settleLetterStatus(String(result.rows[0].letter_id));
  return { ok: true, letterId: String(result.rows[0].letter_id) };
}

/**
 * Recomputes an incoming letter's status from its transfers: open action
 * transfers keep it routed; all closed with at least one done means done;
 * everything cancelled falls back to registered. Outgoing and annulled
 * letters are never touched here.
 */
async function settleLetterStatus(letterId) {
  await sql`
    UPDATE dbo.correspondence
       SET status = CASE
             WHEN EXISTS (SELECT 1 FROM dbo.correspondence_transfers t
                           WHERE t.correspondence_id = ${letterId}
                             AND t.purpose = 'action' AND t.status IN ('pending', 'received'))
               THEN 'routed'
             WHEN EXISTS (SELECT 1 FROM dbo.correspondence_transfers t
                           WHERE t.correspondence_id = ${letterId} AND t.status = 'done')
               THEN 'done'
             ELSE 'registered'
           END,
           updated_at = SYSUTCDATETIME()
     WHERE correspondence_id = ${letterId}
       AND direction = 'in' AND status <> 'annulled'
  `.execute(db);
}

// ── Register-keeping actions ─────────────────────────────────────────────

/** Forwards a registered letter to more units — the إحالة after registration. */
export async function addTransfers({ userId, isSuperAdmin = false, letterId, transfers }) {
  if (!(await isRegistrar({ userId, isSuperAdmin }))) return { ok: false, reason: 'not_registrar' };

  const routed = normalizeTransfers(transfers);
  if (routed === undefined || routed.length === 0) return { ok: false, reason: 'invalid_transfers' };

  const found = await sql`
    SELECT c.correspondence_id, c.direction, c.status, c.book_number, c.book_year,
           c.subject, c.document_id, d.folder_id
      FROM dbo.correspondence c
      JOIN dbo.documents d ON d.document_id = c.document_id
     WHERE c.correspondence_id = ${letterId}
  `.execute(db);
  const letter = found.rows[0];
  if (!letter) return { ok: false, reason: 'not_found' };
  if (letter.direction !== 'in') return { ok: false, reason: 'not_incoming' };
  if (letter.status === 'annulled') return { ok: false, reason: 'annulled' };

  const liveUnits = new Set((await listUnits()).map((unit) => unit.unitId));
  for (const entry of routed) {
    if (!liveUnits.has(entry.unitId)) return { ok: false, reason: 'unit_not_found' };
  }

  try {
    for (const entry of routed) {
      await sql`
        INSERT INTO dbo.correspondence_transfers
          (correspondence_id, unit_id, purpose, due_date, routed_by)
        VALUES (${letterId}, ${entry.unitId}, ${entry.purpose}, ${entry.dueDate}, ${userId})
      `.execute(db);
    }
  } catch (error) {
    if (/UX_correspondence_transfers_live|duplicate key/i.test(error.message)) {
      return { ok: false, reason: 'already_routed_to_unit' };
    }
    throw error;
  }

  await settleLetterStatus(String(letterId));
  await notifyTransfers({
    unitIds: routed.map((entry) => entry.unitId),
    letter: {
      number: Number(letter.book_number),
      year: Number(letter.book_year),
      subject: letter.subject,
      documentId: letter.document_id,
      folderId: letter.folder_id,
    },
  });
  return { ok: true };
}

/**
 * إلغاء قيد — a line through the entry, never an erasure. The number stays
 * spent, the reason is recorded, and open transfers are withdrawn.
 */
export async function annulLetter({ userId, isSuperAdmin = false, letterId, reason }) {
  if (!(await isRegistrar({ userId, isSuperAdmin }))) return { ok: false, reason: 'not_registrar' };

  const text = String(reason ?? '').trim();
  if (!text) return { ok: false, reason: 'reason_required' };
  if (text.length < 5) return { ok: false, reason: 'reason_too_short', minLength: 5 };

  const result = await sql`
    UPDATE dbo.correspondence
       SET status = 'annulled', annul_reason = ${text.slice(0, 400)}, updated_at = SYSUTCDATETIME()
     WHERE correspondence_id = ${letterId} AND status <> 'annulled'
  `.execute(db);
  if (Number(result.numAffectedRows ?? 0) === 0) return { ok: false, reason: 'not_found' };

  await sql`
    UPDATE dbo.correspondence_transfers
       SET status = 'cancelled', closed_by = ${userId}, closed_at = SYSUTCDATETIME()
     WHERE correspondence_id = ${letterId} AND status IN ('pending', 'received')
  `.execute(db);

  return { ok: true };
}

/** Marks an outgoing letter dispatched — or back, if it was marked in error. */
export async function setOutgoingStatus({ userId, isSuperAdmin = false, letterId, status }) {
  if (!(await isRegistrar({ userId, isSuperAdmin }))) return { ok: false, reason: 'not_registrar' };
  if (!['registered', 'sent'].includes(status)) return { ok: false, reason: 'invalid_status' };

  const result = await sql`
    UPDATE dbo.correspondence
       SET status = ${status}, updated_at = SYSUTCDATETIME()
     WHERE correspondence_id = ${letterId} AND direction = 'out' AND status <> 'annulled'
  `.execute(db);
  if (Number(result.numAffectedRows ?? 0) === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}
