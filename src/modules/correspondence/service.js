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
import { normalizeArabic } from '../../lib/arabic.js';
import { PERM, has } from '../tree/service.js';
import { getSetting } from '../settings/service.js';
import { notifyMany, KIND } from '../notifications/service.js';
import { documentPermission } from '../collaboration/service.js';

const log = moduleLogger('correspondence');

export const DIRECTIONS = Object.freeze(['in', 'out']);
export const LETTER_STATUSES = Object.freeze(['registered', 'routed', 'done', 'sent', 'annulled']);
export const TRANSFER_PURPOSES = Object.freeze(['action', 'info']);

/**
 * ─── The paper trail ────────────────────────────────────────────────────────
 *
 * The paper travels and comes back marked. Every return is a NEW VERSION of
 * the letter's own document — the core version mechanism, untouched — and this
 * module records WHAT WAS DONE on the paper beside it.
 *
 * 'received' is the register's own word for the scan that was entered in the
 * book, written automatically at registration. It is not postable: a human
 * adding a version is never "as it arrived", because the letter arrived once.
 */
export const VERSION_ACTIONS = Object.freeze([
  'received',
  'instruction',
  'endorsement',
  'rescan',
  'other',
]);
export const POSTABLE_VERSION_ACTIONS = Object.freeze(
  VERSION_ACTIONS.filter((action) => action !== 'received'),
);
export const MOVEMENT_KINDS = Object.freeze(['out', 'back']);

/**
 * The Arabic name of each act, in the mail room's own words.
 *
 * These labels are written into the CORE version comment as well as into the
 * trail table, which is the whole isolation story: with «الوارد والصادر»
 * switched off at the master setting, the ordinary version list still reads
 * «تهميش — د. حسين: الموارد البشرية للإجراء» and no core query ever touches a
 * correspondence table to produce it.
 */
const ACTION_LABEL = Object.freeze({
  received: 'كما ورد',
  instruction: 'تهميش',
  endorsement: 'توقيع أو تأشير',
  rescan: 'إعادة مسح',
  other: 'أخرى',
});

/** label — person: note, with whatever parts were supplied. */
function versionComment({ action, personName = null, note = null }) {
  let text = ACTION_LABEL[action] ?? ACTION_LABEL.other;
  if (personName) text += ` — ${personName}`;
  if (note) text += `: ${note}`;
  return text.slice(0, 1000);
}

/** Trimmed, capped, and empty means absent rather than an empty string. */
function textOrNull(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text.slice(0, maxLength);
}

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

    // التهميش — the director's written instruction, typed where the department
    // will read it. The column existed and the queue displayed it from the
    // first day; nothing wrote it, so the one thing a department most needs to
    // see arrived blank. It is optional: a forwarding with nothing to add is
    // still a forwarding.
    result.push({ unitId, purpose, dueDate, note: textOrNull(entry?.note, 1000) });
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
  replyToLetterId = null,
}) {
  if (!(await isRegistrar({ userId, isSuperAdmin }))) return { ok: false, reason: 'not_registrar' };
  if (!DIRECTIONS.includes(direction)) return { ok: false, reason: 'invalid_direction' };

  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const document = await sql`
    SELECT d.document_id, d.title, d.folder_id, d.current_version FROM dbo.documents d
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

  /*
   * «رد على الوارد …» — the reply link.
   *
   * Resolved and permission-checked HERE, then written inside the registration
   * transaction below rather than through collaboration's relate(). relate()
   * runs its own two permission queries on its own connection, so calling it
   * after the commit would leave a registered letter whose link silently failed,
   * and calling it before would leave a relation pointing at a letter that was
   * never registered. The same BROWSE check relate() makes is made here, and
   * the write then lives or dies with the book entry.
   *
   * Two things are written: `correspondence.reply_to_id`, which IS the register's
   * link and the only thing «مُجاب» ever reads, and the core 'reply_to' relation,
   * which exists so the document page's «مرتبطة» list shows it. The relation is
   * display only — anyone who can see either document may delete it from the
   * relations panel, and the book must not change when they do.
   */
  let replyTo = null;
  if (replyToLetterId !== null && replyToLetterId !== undefined && replyToLetterId !== '') {
    if (direction !== 'out') return { ok: false, reason: 'invalid_reply_to' };

    const target = await sql`
      SELECT c.correspondence_id, c.document_id, c.book_number, c.book_year
        FROM dbo.correspondence c
       WHERE c.correspondence_id = ${replyToLetterId}
         AND c.direction = 'in' AND c.status <> 'annulled'
    `.execute(db);
    if (!target.rows[0]) return { ok: false, reason: 'invalid_reply_to' };

    if (String(target.rows[0].document_id) === String(documentId)) {
      return { ok: false, reason: 'invalid_reply_to' };
    }

    // A letter that exists but is out of this clerk's reach is a different
    // problem from a letter that cannot be replied to, and the screen must be
    // able to say so: «لا تملك صلاحية الوصول إلى هذا الكتاب» instead of sending
    // her back to re-pick a letter the picker legitimately offered.
    const targetBits = await documentPermission(userId, String(target.rows[0].document_id));
    if (targetBits === null || !has(targetBits, PERM.BROWSE)) {
      return { ok: false, reason: 'reply_to_forbidden' };
    }
    replyTo = {
      letterId: String(target.rows[0].correspondence_id),
      documentId: String(target.rows[0].document_id),
    };
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
           external_party, external_ref, external_date, unit_id, status, registered_by,
           reply_to_id)
        OUTPUT INSERTED.correspondence_id AS id
        VALUES
          (${documentId}, ${direction}, ${year}, ${number}, ${subjectText},
           ${externalParty ? String(externalParty).slice(0, 300) : null},
           ${externalRef ? String(externalRef).slice(0, 100) : null},
           ${externalDateText}, ${unitId || null}, ${status}, ${userId},
           ${replyTo ? replyTo.letterId : null})
      `.execute(trx);
      const letterId = String(inserted.rows[0].id);

      for (const entry of routed) {
        await sql`
          INSERT INTO dbo.correspondence_transfers
            (correspondence_id, unit_id, purpose, due_date, note, routed_by)
          VALUES (${letterId}, ${entry.unitId}, ${entry.purpose}, ${entry.dueDate},
                  ${entry.note}, ${userId})
        `.execute(trx);
      }

      if (replyTo) {
        // The display copy. NOT EXISTS rather than a caught duplicate-key
        // error: inside a transaction the thrown error would abort the
        // registration, and two registrations replying to the same letter is
        // an ordinary thing to do.
        await sql`
          INSERT INTO dbo.document_relations (from_document, to_document, relation_type, created_by)
          SELECT ${documentId}, ${replyTo.documentId}, 'reply_to', ${userId}
           WHERE NOT EXISTS (
             SELECT 1 FROM dbo.document_relations
              WHERE from_document = ${documentId}
                AND to_document = ${replyTo.documentId}
                AND relation_type = 'reply_to')
        `.execute(trx);
      }

      /*
       * «كما ورد» — the first entry in the paper trail.
       *
       * The scan that was entered in the book is version 1 of the letter's
       * story, and naming it here means the trail is never a list that starts
       * in the middle. Written for the CURRENT version, because a letter may
       * have been rescanned before anyone registered it.
       *
       * A multi-file document has no version row at all (current_version 0), so
       * it gets no trail entry rather than a foreign-key violation that would
       * fail the registration of a perfectly good letter.
       */
      if (direction === 'in' && Number(document.rows[0].current_version) >= 1) {
        const currentVersion = Number(document.rows[0].current_version);
        await sql`
          INSERT INTO dbo.correspondence_version_actions
            (correspondence_id, document_id, version_number, action, recorded_by)
          SELECT ${letterId}, ${documentId}, ${currentVersion}, 'received', ${userId}
           WHERE NOT EXISTS (
             SELECT 1 FROM dbo.correspondence_version_actions
              WHERE document_id = ${documentId} AND version_number = ${currentVersion})
        `.execute(trx);

        // And the same word in the core version's own comment, so the version
        // list reads correctly with the whole area switched off. Only when the
        // uploader left it blank: what a person typed about their own upload is
        // theirs, and the register has no business overwriting it.
        await sql`
          UPDATE dbo.document_versions
             SET comment = ${versionComment({ action: 'received' })}
           WHERE document_id = ${documentId}
             AND version_number = ${currentVersion}
             AND comment IS NULL
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
    // Where the paper itself is, derived from the newest custody row: 'out'
    // means it is with that person since then, anything else means the mail
    // room still has it. See the movements note in migration 0024.
    location:
      row.location_kind === 'out'
        ? { state: 'out', personName: row.location_person, since: row.location_since }
        : { state: 'in' },
    // Only incoming letters can be answered, and only there does the flag mean
    // anything — an outgoing letter carries `replyTo` instead.
    answered: row.direction === 'in' ? Number(row.answered) === 1 : undefined,
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
         u.name AS unit_name, p.display_name AS registered_by_name, d.title AS document_title,
         loc.kind AS location_kind, loc.person_name AS location_person,
         loc.recorded_at AS location_since,
         -- «مُجاب» — the register's own link, never the generic relations
         -- table, and never an annulled reply: a صادر struck from the book
         -- answered nothing, so the وارد is open again and must look it.
         CASE WHEN EXISTS (SELECT 1 FROM dbo.correspondence rep
                            WHERE rep.reply_to_id = c.correspondence_id
                              AND rep.direction = 'out'
                              AND rep.status <> 'annulled')
              THEN 1 ELSE 0 END AS answered
    FROM dbo.correspondence c
    JOIN dbo.documents d ON d.document_id = c.document_id
    JOIN dbo.principals p ON p.principal_id = c.registered_by
    LEFT JOIN dbo.correspondence_units u ON u.unit_id = c.unit_id
   OUTER APPLY (SELECT TOP (1) m.kind, m.person_name, m.recorded_at
                  FROM dbo.correspondence_movements m
                 WHERE m.correspondence_id = c.correspondence_id
                 ORDER BY m.recorded_at DESC, m.movement_id DESC) loc
`;

/** «٤٨٣/٢٠٢٦» or «483 / 2026» — a book reference, after digit normalisation. */
const BOOK_REFERENCE = /^([0-9]{1,9})\s*\/\s*([0-9]{4})$/;
/** «٤٨٣» — the number alone, which is how the mail room actually says it. */
const BOOK_NUMBER_ALONE = /^([0-9]{1,9})$/;

/**
 * What the clerk typed into «بحث».
 *
 * A book number is an IDENTITY, not prose: «٤» means entry four and must never
 * match entry fourteen or four hundred, which is exactly what a LIKE '%4%' on
 * the number would do — and what made «بحث برقم الكتاب» useless. So a
 * reference is matched by equality on the parsed parts, and only text that is
 * not a reference at all falls through to the subject/party/ref LIKE.
 *
 * normalizeArabic() folds ٠-٩ and ۰-۹ to ASCII digits, because the keypad in
 * front of the clerk produces Arabic-Indic ones and the column holds integers.
 * The LIKE branch keeps the ORIGINAL text: the stored columns are Arabic_CI_AI
 * and compare variants themselves, so normalising there would only strip
 * characters the collation handles better.
 */
function parseLetterQuery(q) {
  const raw = q === null || q === undefined ? '' : String(q).trim();
  if (raw === '') return { bookNumber: null, refYear: null, query: null };

  const digits = normalizeArabic(raw);

  const reference = BOOK_REFERENCE.exec(digits);
  if (reference) {
    return { bookNumber: Number(reference[1]), refYear: Number(reference[2]), query: null };
  }

  // A bare number searches every year's book: «٤٨٣» is how the question is
  // asked out loud, and the year is usually the current one but not always.
  const alone = BOOK_NUMBER_ALONE.exec(digits);
  if (alone) return { bookNumber: Number(alone[1]), refYear: null, query: null };

  return { bookNumber: null, refYear: null, query: `%${raw}%` };
}

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
  location = null,
  limit = 100,
} = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const bookYear = year ? Number(year) : null;
  const { bookNumber, refYear, query } = parseLetterQuery(q);
  // «الأوراق الخارجة» — the letters whose paper is in somebody's hands right
  // now. This is what makes the intake screen a picker instead of a search: the
  // clerk holding a returned paper finds it in the short list of what left.
  const outOnly = location === 'out' ? 1 : 0;

  const result = await sql`
    ${LETTER_SELECT}
   WHERE (${direction} IS NULL OR c.direction = ${direction})
     AND (${bookYear} IS NULL OR c.book_year = ${bookYear})
     AND (${status} IS NULL OR c.status = ${status})
     -- A struck-out letter can never accept a returned copy, so it must not
     -- appear among «الأوراق الخارجة» — filtered here rather than in the
     -- screen, so the holder suggestions built from this list are clean too.
     AND (${outOnly} = 0 OR (loc.kind = 'out' AND c.status <> 'annulled'))
     AND (${bookNumber} IS NULL
          OR (c.book_number = ${bookNumber}
              AND (${refYear} IS NULL OR c.book_year = ${refYear})))
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

/**
 * One letter with everything about it, for the register detail and the
 * document panel: its transfers, the paper trail, the custody log, where the
 * paper is, whether this viewer may add to any of that, and the reply link.
 *
 * `userId` is optional only because the register detail route is registrar-only
 * and could compute `canRecord` from the role alone; passing it costs one query
 * and makes the same payload correct for the document panel, where the viewer
 * may be a department holding the letter rather than the mail room.
 */
export async function getLetter({ letterId, userId = null, isSuperAdmin = false }) {
  const found = await sql`
    ${LETTER_SELECT}
   WHERE c.correspondence_id = ${letterId}
  `.execute(db);
  if (!found.rows[0]) return { ok: false, reason: 'not_found' };

  const letter = toLetter(found.rows[0]);

  const [trail, movements, answeredBy, replyTo, canRecord] = await Promise.all([
    paperTrail(letterId),
    movementLog(letterId),
    letter.direction === 'in' ? repliesTo(letterId) : Promise.resolve([]),
    letter.direction === 'out' ? replyTarget(letterId) : Promise.resolve(null),
    userId === null ? Promise.resolve(false) : canRecordPaper({ userId, isSuperAdmin, letterId }),
  ]);

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

  return {
    ok: true,
    letter,
    transfers: transfers.rows.map(toTransfer),
    trail,
    movements,
    location: letter.location,
    canRecord,
    answeredBy,
    replyTo,
  };
}

// ── The paper trail, the custody log and the reply link ──────────────────

/** Every version of this letter, named by what was done on the paper. */
async function paperTrail(letterId) {
  const result = await sql`
    SELECT a.version_number, a.action, a.person_name, a.note, a.recorded_at,
           p.display_name AS recorded_by_name
      FROM dbo.correspondence_version_actions a
      JOIN dbo.principals p ON p.principal_id = a.recorded_by
     WHERE a.correspondence_id = ${letterId}
     ORDER BY a.version_number
  `.execute(db);

  return result.rows.map((row) => ({
    versionNumber: Number(row.version_number),
    action: row.action,
    personName: row.person_name,
    note: row.note,
    recordedBy: row.recorded_by_name,
    recordedAt: row.recorded_at,
  }));
}

/** Whose hands the paper passed through, oldest first. */
async function movementLog(letterId) {
  const result = await sql`
    SELECT m.movement_id, m.kind, m.person_name, m.note, m.recorded_at,
           p.display_name AS recorded_by_name
      FROM dbo.correspondence_movements m
      JOIN dbo.principals p ON p.principal_id = m.recorded_by
     WHERE m.correspondence_id = ${letterId}
     ORDER BY m.recorded_at, m.movement_id
  `.execute(db);

  return result.rows.map(toMovement);
}

function toMovement(row) {
  return {
    movementId: String(row.movement_id),
    kind: row.kind,
    personName: row.person_name,
    note: row.note,
    recordedBy: row.recorded_by_name ?? null,
    recordedAt: row.recorded_at,
  };
}

/**
 * Where the paper is right now: the newest custody row decides.
 *
 * Ties on recorded_at are broken by movement_id, because two movements recorded
 * in the same millisecond must still have an order — and "out then back" and
 * "back then out" are opposite answers to the only question this function asks.
 */
async function currentLocation(letterId) {
  const result = await sql`
    SELECT TOP (1) kind, person_name, recorded_at
      FROM dbo.correspondence_movements
     WHERE correspondence_id = ${letterId}
     ORDER BY recorded_at DESC, movement_id DESC
  `.execute(db);

  const row = result.rows[0];
  return row && row.kind === 'out'
    ? { state: 'out', personName: row.person_name, since: row.recorded_at }
    : { state: 'in' };
}

/**
 * «أُجيب بالصادر …» — the outgoing letters registered as replies to this one.
 *
 * Read from `reply_to_id`, the register's own column, never from
 * dbo.document_relations: that table's DELETE route takes any relation id from
 * any signed-in user, so a fact about the official book would be anybody's to
 * forge or erase.
 *
 * ANNULLED replies stay in the list, carrying their status. A صادر struck from
 * the book no longer answers the وارد — `answered` says so — but «أُجيب
 * بالصادر ٩٩، ملغى» is the history, and a list that quietly dropped it would
 * leave the clerk wondering where the entry she remembers went.
 */
async function repliesTo(letterId) {
  const result = await sql`
    SELECT c.correspondence_id, c.book_year, c.book_number, c.document_id, c.status
      FROM dbo.correspondence c
     WHERE c.reply_to_id = ${letterId} AND c.direction = 'out'
     ORDER BY c.book_year, c.book_number
  `.execute(db);

  return result.rows.map((row) => ({
    letterId: String(row.correspondence_id),
    year: Number(row.book_year),
    number: Number(row.book_number),
    documentId: String(row.document_id),
    status: row.status,
  }));
}

/**
 * «رد على الوارد …» — the incoming letter this outgoing one answers, with its
 * status, so a reply to a letter that was later struck out shows that too.
 */
async function replyTarget(letterId) {
  const result = await sql`
    SELECT target.correspondence_id, target.book_year, target.book_number,
           target.document_id, target.status
      FROM dbo.correspondence c
      JOIN dbo.correspondence target ON target.correspondence_id = c.reply_to_id
     WHERE c.correspondence_id = ${letterId}
  `.execute(db);

  const row = result.rows[0];
  return row
    ? {
        letterId: String(row.correspondence_id),
        year: Number(row.book_year),
        number: Number(row.book_number),
        documentId: String(row.document_id),
        status: row.status,
      }
    : null;
}

/**
 * Who may write to the paper trail: the mail room, or a department currently
 * holding the letter.
 *
 * The second half is the whole reason this is not simply `isRegistrar`. The
 * owner's own objection to the feature was that "the letter could move between
 * departments without reaching Zainab" — so a unit with a live transfer on this
 * letter records what happened in its own hands, with the same gestures. The
 * membership test is the queue's own (fn_expand_principals), so nested groups
 * count here exactly as they count there.
 *
 * This answers the REGISTER's question only. Uploading still needs UPLOAD on the
 * letter's folder, which addVersion checks and this function must not pretend
 * to grant.
 */
export async function canRecordPaper({ userId, isSuperAdmin = false, letterId }) {
  if (await isRegistrar({ userId, isSuperAdmin })) return true;
  return holdsLetter({ userId, letterId });
}

/** A live transfer of this letter to a unit this person belongs to. */
async function holdsLetter({ userId, letterId }) {
  const holder = await sql`
    SELECT TOP (1) 1 AS yes
      FROM dbo.correspondence_transfers t
      JOIN dbo.correspondence_units u ON u.unit_id = t.unit_id
     WHERE t.correspondence_id = ${letterId}
       AND t.status IN ('pending', 'received')
       AND u.group_id IN (SELECT principal_id FROM dbo.fn_expand_principals(${userId}))
  `.execute(db);
  return holder.rows.length > 0;
}

/**
 * The letter a paper-trail gesture is about, with the facts both gestures need.
 *
 * `registrar` rides along because the two callers are not equivalent: the mail
 * room speaks for the custody log and may be defaulted from it, while a
 * department records only what happened in its OWN hands. The folder and title
 * come with it so the route can fire the core version event without a second
 * lookup.
 */
async function letterForRecording({ userId, isSuperAdmin, letterId }) {
  const found = await sql`
    SELECT c.correspondence_id, c.document_id, c.status, c.book_number, c.book_year,
           d.folder_id, d.title
      FROM dbo.correspondence c
      JOIN dbo.documents d ON d.document_id = c.document_id
     WHERE c.correspondence_id = ${letterId}
  `.execute(db);

  const letter = found.rows[0];
  if (!letter) return { ok: false, reason: 'not_found' };
  if (letter.status === 'annulled') return { ok: false, reason: 'annulled' };

  const registrar = await isRegistrar({ userId, isSuperAdmin });
  if (!registrar && !(await holdsLetter({ userId, letterId }))) {
    return { ok: false, reason: 'not_allowed' };
  }
  return { ok: true, letter, registrar };
}

/**
 * Adds a returned, re-annotated or rescanned paper as a NEW VERSION of the
 * letter's own document, named by what was done on it.
 *
 * Never a new document. A second document would spend a second book number,
 * split the search hits, and leave «أين كتاب ٤٨٣/٢٠٢٦؟» with two answers — the
 * one thing the register exists to prevent.
 *
 * The core addVersion does all the refusing that matters: UPLOAD on the folder,
 * legal hold, the check-out lock, the extension list and the size cap. Its
 * reasons are returned unchanged so the route can map them exactly as the
 * ordinary version route does.
 */
export async function addLetterVersion({
  userId,
  isSuperAdmin = false,
  letterId,
  stream,
  filename = null,
  mimeType = null,
  action = null,
  personName = null,
  note = null,
  returned = false,
}) {
  /*
   * Defaults do the work, because the alternative is discipline.
   *
   * A paper coming back to the mail room is almost always coming back marked,
   * so an unstated act is 'instruction'; an unstated person is whoever the
   * paper was last handed to, which the custody log already knows. The clerk
   * can override both, and a letter whose paper never left gets no invented
   * name.
   */
  const act = String(action ?? '').trim() || 'instruction';
  if (!POSTABLE_VERSION_ACTIONS.includes(act)) {
    stream?.resume?.();
    return { ok: false, reason: 'invalid_action' };
  }

  const gate = await letterForRecording({ userId, isSuperAdmin, letterId });
  if (!gate.ok) {
    stream?.resume?.();
    return gate;
  }
  const { letter, registrar } = gate;

  const location = await currentLocation(letterId);
  /*
   * The custody default is the MAIL ROOM'S default, and only theirs.
   *
   * «الورقة عند د. حسين» is the register's own record, so when the clerk who
   * keeps that record files a scan without naming anyone, naming him is simply
   * reading back what she wrote. A DEPARTMENT filing a scan is in a different
   * position: the log says the paper is with the unit next door, and stamping
   * that unit's name onto what happened in these hands would invent a fact.
   * A department that leaves the person blank gets a blank person.
   */
  const person = textOrNull(personName, 200)
    ?? (registrar && location.state === 'out' ? location.personName : null);
  const noteText = textOrNull(note, 1000);

  const { addVersion } = await import('../documents/service.js');
  const added = await addVersion({
    userId,
    documentId: String(letter.document_id),
    stream,
    filename,
    mimeType,
    // The same words in the core version's comment, so the version list still
    // says what each scan is once the whole area is switched off.
    comment: versionComment({ action: act, personName: person, note: noteText }),
  });
  if (!added.ok) return added;

  /*
   * The trail row is written AFTER the version, and its failure is not the
   * caller's failure — the same trade the signature ledger makes.
   *
   * By this point the version row, the stored bytes and current_version have
   * all been committed. Reporting an error would tell the clerk her scan did
   * not land while it demonstrably did, and there is no undo that would make
   * that true. So it is logged loudly and the answer says `trail: false`.
   */
  let trail = true;
  try {
    await sql`
      INSERT INTO dbo.correspondence_version_actions
        (correspondence_id, document_id, version_number, action, person_name, note, recorded_by)
      VALUES (${letterId}, ${letter.document_id}, ${added.version}, ${act},
              ${person}, ${noteText}, ${userId})
    `.execute(db);
  } catch (error) {
    trail = false;
    log.error(
      { err: error, letterId: String(letterId), version: added.version },
      'the paper-trail row could not be written, but the version was committed',
    );
  }

  /*
   * One gesture, both facts: the paper came back and here is what it says. The
   * clerk is holding the sheet — asking her to visit a second screen to admit
   * it is in her hands is how a trail stops being kept.
   *
   * And its failure is not the caller's failure either, for the same reason the
   * trail row's is not: the version is already committed. A 500 here would tell
   * the clerk her scan was lost, and the only thing she can do about that is
   * scan the sheet again — which is how one returned paper becomes two
   * versions. So the answer stays `ok` and says which half did not land.
   */
  let movement = null;
  let movementFailed = false;
  if (returned === true && location.state === 'out') {
    try {
      movement = await insertMovement({
        letterId,
        kind: 'back',
        personName: location.personName,
        note: null,
        userId,
      });
    } catch (error) {
      movementFailed = true;
      log.error(
        { err: error, letterId: String(letterId), version: added.version },
        'the «back» movement could not be written, but the version was committed',
      );
    }
  }

  log.info(
    { letterId: String(letterId), version: added.version, action: act },
    'paper-trail version added',
  );
  return {
    ok: true,
    letterId: String(letterId),
    documentId: String(letter.document_id),
    // The folder and the document's title, so the route can record the CORE
    // version event — the audit row and the watcher notice every other path
    // that adds a version produces.
    folderId: String(letter.folder_id),
    title: letter.title,
    version: added.version,
    action: act,
    personName: person,
    reference: `${letter.book_number}/${letter.book_year}`,
    trail,
    movement,
    movementFailed,
  };
}

async function insertMovement({ letterId, kind, personName, note, userId }) {
  const inserted = await sql`
    INSERT INTO dbo.correspondence_movements
      (correspondence_id, kind, person_name, note, recorded_by)
    OUTPUT INSERTED.movement_id AS movement_id, INSERTED.kind AS kind,
           INSERTED.person_name AS person_name, INSERTED.note AS note,
           INSERTED.recorded_at AS recorded_at
    VALUES (${letterId}, ${kind}, ${personName}, ${note}, ${userId})
  `.execute(db);
  return toMovement(inserted.rows[0]);
}

/**
 * Records that the paper left, or came back — «سُلّمت الورقة إلى …» and
 * «عادت الورقة من …».
 *
 * A log, not a state machine: 'out' twice in a row is a paper that went from
 * one office straight to the next without passing the mail room, which is
 * exactly what happens, and refusing it would only teach the clerk to stop
 * recording. The current location is always the newest row.
 */
export async function recordMovement({
  userId,
  isSuperAdmin = false,
  letterId,
  kind,
  personName = null,
  note = null,
}) {
  if (!MOVEMENT_KINDS.includes(kind)) return { ok: false, reason: 'invalid_kind' };

  const gate = await letterForRecording({ userId, isSuperAdmin, letterId });
  if (!gate.ok) return gate;

  const location = await currentLocation(letterId);
  /*
   * A return needs no typing when the log already says who has it.
   *
   * Unlike the trail's own person (see addLetterVersion), this default is not
   * restricted to the mail room: «عادت الورقة من X» where X is whoever the log
   * says had it is the plain meaning of the gesture, whoever performs it, and a
   * department handing the sheet back is making exactly that claim.
   */
  const person = textOrNull(personName, 200)
    ?? (kind === 'back' && location.state === 'out' ? location.personName : null);
  if (!person) return { ok: false, reason: 'person_required' };

  const movement = await insertMovement({
    letterId,
    kind,
    personName: person,
    // 1000, matching the widened column and what the dialog accepts. The old
    // 500 silently cut a hand-over note in half — see migration 0025.
    note: textOrNull(note, 1000),
    userId,
  });

  log.info({ letterId: String(letterId), kind, personName: person }, 'paper movement recorded');
  return { ok: true, movement, reference: `${gate.letter.book_number}/${gate.letter.book_year}` };
}

/**
 * The register entry behind one document, for the document page's panel.
 * Requires READ on the document — the same gate as every other panel.
 *
 * Each transfer is marked `mine` when the caller belongs to its unit's group,
 * so the panel can offer تسلّم/إنجاز right where the person is already
 * reading the letter, instead of sending them back to the queue.
 */
export async function letterForDocument({ userId, documentId, isSuperAdmin = false }) {
  const bits = await documentPermission(userId, documentId);
  if (bits === null || !has(bits, PERM.READ)) return { ok: false, reason: 'not_found' };

  const found = await sql`
    SELECT correspondence_id FROM dbo.correspondence WHERE document_id = ${documentId}
  `.execute(db);
  if (!found.rows[0]) return { ok: true, registered: false };

  const letterId = String(found.rows[0].correspondence_id);
  const detail = await getLetter({ letterId, userId, isSuperAdmin });
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
    // The paper's own story travels with the document, because the department
    // reading the letter is often the one holding the sheet.
    trail: detail.trail,
    movements: detail.movements,
    location: detail.location,
    canRecord: detail.canRecord,
    answeredBy: detail.answeredBy,
    replyTo: detail.replyTo,
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
          (correspondence_id, unit_id, purpose, due_date, note, routed_by)
        VALUES (${letterId}, ${entry.unitId}, ${entry.purpose}, ${entry.dueDate},
                ${entry.note}, ${userId})
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
