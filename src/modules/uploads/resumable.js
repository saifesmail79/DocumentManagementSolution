/**
 * Resumable uploads.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * A 200MB scan over a flaky office connection fails at 90% and restarts from
 * zero. People respond by not scanning, or by emailing compressed files — which
 * is the failure mode this whole system is meant to replace.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────
 *
 * A create/append/complete protocol over plain HTTP rather than the tus spec.
 * tus would bring a second server and its own storage abstraction for what is,
 * here, three endpoints and an append to a staging file — and the client is ours,
 * so interoperability with third-party tus clients buys nothing.
 *
 * The offset is authoritative on the SERVER. A client that thinks it sent more
 * than it did resumes from what actually landed, which is the entire point.
 */

import { randomUUID, createHash } from 'node:crypto';
import { open, stat, mkdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { PERM, permissionBits, has } from '../tree/service.js';
import { effectiveMaxBytes, extensionRefusal } from './policy.js';

const log = moduleLogger('uploads');

const SESSION_DIR = '.resumable';

/** Starts a session and returns where to send the first chunk. */
export async function createSession({ userId, folderId, filename, totalBytes, mimeType, title, typeId, fields }) {
  const size = Number(totalBytes);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'invalid_size' };
  // The limit and the extension policy as configured now, so a resumable upload
  // obeys the same rules as a direct one — declared size first, and the final
  // assembly is measured against the same limit again in case the declaration lied.
  if (size > (await effectiveMaxBytes())) return { ok: false, reason: 'too_large' };

  const refusedExtension = await extensionRefusal(filename);
  if (refusedExtension) return { ok: false, ...refusedExtension };

  const bits = await permissionBits(userId, folderId);
  if (!has(bits, PERM.UPLOAD)) {
    return { ok: false, reason: has(bits, PERM.BROWSE) ? 'forbidden' : 'not_found' };
  }

  const sessionId = randomUUID();
  const stagingPath = `${SESSION_DIR}/${sessionId}.part`;

  // Created empty up front so an append to a fresh session behaves exactly like
  // an append to a resumed one.
  await mkdir(path.dirname(storage.absolute(stagingPath)), { recursive: true });
  const handle = await open(storage.absolute(stagingPath), 'wx');
  await handle.close();

  await sql`
    INSERT INTO dbo.upload_sessions
      (session_id, user_id, folder_id, filename, title, mime_type, type_id, fields_json,
       total_bytes, staging_path)
    VALUES (${sessionId}, ${userId}, ${folderId}, ${String(filename).slice(0, 400)},
            ${title ? String(title).slice(0, 500) : null}, ${mimeType ?? null}, ${typeId ?? null},
            ${fields ? JSON.stringify(fields).slice(0, 4000) : null}, ${size}, ${stagingPath})
  `.execute(db);

  return { ok: true, sessionId, offset: 0, totalBytes: size };
}

/** Where the server believes the session got to. */
export async function sessionStatus({ userId, sessionId }) {
  const result = await sql`
    SELECT session_id, user_id, total_bytes, received_bytes, completed_at, document_id, filename
      FROM dbo.upload_sessions WHERE session_id = ${sessionId}
  `.execute(db);

  const session = result.rows[0];
  if (!session) return { ok: false, reason: 'not_found' };
  // A session belongs to the person who started it; nobody else can resume or
  // inspect it.
  if (String(session.user_id) !== String(userId)) return { ok: false, reason: 'not_found' };

  return {
    ok: true,
    sessionId: session.session_id,
    filename: session.filename,
    offset: Number(session.received_bytes),
    totalBytes: Number(session.total_bytes),
    completed: session.completed_at !== null,
    documentId: session.document_id === null ? null : String(session.document_id),
  };
}

/**
 * Appends a chunk at `offset`.
 *
 * The offset must match exactly what the server already holds. A mismatch is
 * refused with the real offset rather than accepted at a different position:
 * writing a chunk into the wrong place produces a file that is the right length
 * and silently corrupt, which is far worse than a failed request.
 */
export async function appendChunk({ userId, sessionId, offset, stream }) {
  const status = await sessionStatus({ userId, sessionId });
  if (!status.ok) {
    stream?.resume();
    return status;
  }
  if (status.completed) {
    stream?.resume();
    return { ok: false, reason: 'already_completed' };
  }

  const expected = status.offset;
  if (Number(offset) !== expected) {
    stream?.resume();
    return { ok: false, reason: 'offset_mismatch', offset: expected };
  }

  const found = await sql`
    SELECT staging_path, total_bytes FROM dbo.upload_sessions WHERE session_id = ${sessionId}
  `.execute(db);
  const stagingPath = found.rows[0].staging_path;
  const totalBytes = Number(found.rows[0].total_bytes);

  const absolute = storage.absolute(stagingPath);
  const handle = await open(absolute, 'r+');
  let written = 0;

  try {
    let position = expected;
    for await (const chunk of stream) {
      if (position + chunk.length > totalBytes) {
        // More bytes than declared. Truncating would produce a file that passes
        // the length check and is wrong.
        throw new Error('chunk exceeds the declared total size');
      }
      await handle.write(chunk, 0, chunk.length, position);
      position += chunk.length;
      written += chunk.length;
    }

    // Flushed before the offset is recorded, so a crash can only ever leave the
    // database believing LESS arrived than actually did — which resumes
    // correctly, where the opposite would skip bytes.
    await handle.sync();
  } finally {
    await handle.close();
  }

  const received = expected + written;
  await sql`
    UPDATE dbo.upload_sessions
       SET received_bytes = ${received}, updated_at = SYSUTCDATETIME()
     WHERE session_id = ${sessionId}
  `.execute(db);

  return { ok: true, offset: received, totalBytes, complete: received >= totalBytes };
}

/**
 * Finalises a session into a real document.
 *
 * The staged file is hashed here rather than during the upload: chunks can
 * arrive out of a single stream's order across resumes, so a running hash would
 * be wrong. Reading the finished file once is the only way to be sure.
 */
export async function completeSession({ userId, sessionId }) {
  const status = await sessionStatus({ userId, sessionId });
  if (!status.ok) return status;
  if (status.completed) return { ok: true, documentId: status.documentId, alreadyCompleted: true };

  const found = await sql`
    SELECT * FROM dbo.upload_sessions WHERE session_id = ${sessionId}
  `.execute(db);
  const session = found.rows[0];

  const absolute = storage.absolute(session.staging_path);
  const info = await stat(absolute);

  if (info.size !== Number(session.total_bytes)) {
    return { ok: false, reason: 'incomplete', offset: info.size, totalBytes: Number(session.total_bytes) };
  }

  const { createDocument } = await import('../documents/service.js');

  const result = await createDocument({
    userId,
    folderId: String(session.folder_id),
    title: session.title || stripExtension(session.filename),
    stream: createReadStream(absolute),
    filename: session.filename,
    mimeType: session.mime_type,
    typeId: session.type_id === null ? null : Number(session.type_id),
    fields: session.fields_json ? safeParse(session.fields_json) : null,
  });

  if (!result.ok) return result;

  await sql`
    UPDATE dbo.upload_sessions
       SET completed_at = SYSUTCDATETIME(), document_id = ${result.documentId}
     WHERE session_id = ${sessionId}
  `.execute(db);

  // The staged copy has served its purpose; the document has its own durable
  // file now.
  await unlink(absolute).catch(() => {});

  log.info({ sessionId, documentId: result.documentId }, 'resumable upload completed');
  return result;
}

export async function abortSession({ userId, sessionId }) {
  const status = await sessionStatus({ userId, sessionId });
  if (!status.ok) return status;

  const found = await sql`
    SELECT staging_path FROM dbo.upload_sessions WHERE session_id = ${sessionId}
  `.execute(db);

  if (found.rows[0]) {
    await unlink(storage.absolute(found.rows[0].staging_path)).catch(() => {});
  }

  await sql`DELETE FROM dbo.upload_sessions WHERE session_id = ${sessionId}`.execute(db);
  return { ok: true };
}

/**
 * Removes sessions abandoned mid-transfer.
 *
 * By updated_at, not created_at: a genuinely slow upload that is still making
 * progress must not be swept out from under itself.
 */
export async function purgeStaleSessions({ olderThanHours = 48 } = {}) {
  const stale = await sql`
    SELECT session_id, staging_path FROM dbo.upload_sessions
     WHERE completed_at IS NULL
       AND updated_at < DATEADD(hour, ${-Math.abs(olderThanHours)}, SYSUTCDATETIME())
  `.execute(db);

  for (const row of stale.rows) {
    await unlink(storage.absolute(row.staging_path)).catch(() => {});
    await sql`DELETE FROM dbo.upload_sessions WHERE session_id = ${row.session_id}`.execute(db);
  }

  if (stale.rows.length > 0) log.info({ removed: stale.rows.length }, 'stale upload sessions purged');
  return { removed: stale.rows.length };
}

function stripExtension(filename) {
  const name = String(filename ?? '').trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { createHash };
