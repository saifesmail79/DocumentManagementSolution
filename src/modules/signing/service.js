/**
 * Ink signing (التوقيع) — the service.
 *
 * ─── What a signature is here, and what it is not ───────────────────────────
 *
 * Somebody draws on a picture of a page with a pen or a finger, and the
 * drawing is burned into the PDF as a NEW VERSION of the document. It is a
 * facsimile with an audit trail — the page shows a drawing, and the ledger row
 * plus the version history say who drew it, when, and on which bytes. It is
 * not a cryptographic signature under Iraqi Electronic Signature Law No. 78 of
 * 2012, and no part of this module implies that it is.
 *
 * Because it is a new version and never an edit, every earlier version's bytes
 * and recorded SHA-256 keep telling the truth, and "what did this letter look
 * like before it was signed" is answered by «الإصدارات» rather than by trust.
 * Undoing a signature is restoring an earlier version, which leaves its own
 * record; nothing here deletes anything.
 *
 * ─── The one path to a write ────────────────────────────────────────────────
 *
 * The flattened PDF goes through `addVersion` from the documents service, with
 * a Readable over the bytes, exactly as a person's own upload would. That is
 * deliberate and it is the reason this module is short: the permission check,
 * the legal hold, the check-out lock, the multi-file refusal, the extension
 * policy, the hashing, the optimistic `current_version` advance and the
 * extraction/thumbnail/classification queues all happen once, in the place
 * that already gets them right. A second filing path would be a second place
 * for one of those to be missing.
 *
 * ─── Three calls, three costs — stated because the client leans on it ───────
 *
 *   • `describe` is CHEAP: two queries, no PDF parsed, no tool spawned beyond
 *     the memoised probe. The document page asks it for every document, even
 *     while the signing tab is closed, to decide whether the tab exists at
 *     all. A pdf-lib load in here would put a PDF parse on the path of every
 *     document anybody opens.
 *   • `pageGeometry` loads the PDF once with pdf-lib. The panel asks only when
 *     the tab is actually opened. It also says which pages are `signable`: a
 *     page whose raster at the signing dpi is over `maxPixels` can be drawn on
 *     but never saved, so it is refused before the pen, not after the ink.
 *   • `renderPage` spawns Ghostscript, at most twice at a time per process and
 *     never for a page over that same ceiling. Answers are kept in a small in-process
 *     LRU so flipping back a page is instant, and NOTHING is written to
 *     storage: a page image is a picture of bytes that already exist, it would
 *     be invalidated by the very version this feature creates, and a cache in
 *     the blob store is a cache somebody has to sweep. Rejected: a 'page'
 *     rendition kind in dbo.document_renditions, for exactly that reason.
 *
 * ─── The coordinate contract, and why it is checked twice ───────────────────
 *
 * The client draws on the PNG this module rendered and posts back a
 * transparent PNG of the SAME pixel size. That is the whole contract: no
 * stroke coordinates cross the wire, no device pixel ratio, no zoom factor —
 * one bitmap per page, in the resolution it was drawn at. The server places it
 * over the CropBox, which is the rectangle Ghostscript rasterised
 * (`-dUseCropBox`) and the rectangle a viewer shows, and applies /Rotate
 * through the table in `localToUser`. A signature in the wrong place on an
 * official letter is worse than no signature, so the placement is derived from
 * the same box that produced the image and never from `page.getSize()`.
 *
 * The PNG is inspected as bytes — signature, IHDR, declared pixel count —
 * before any decoder is handed it, because a PNG declares its size in twelve
 * bytes and decodes to four bytes a pixel: a 40 000 × 40 000 header is a
 * 6.4 GB allocation request from an authenticated stranger. The declared size
 * is then compared against the size that page's raster must have, within two
 * pixels of rounding, before `embedPng` runs.
 *
 * ─── Lifecycle state is advisory ────────────────────────────────────────────
 *
 * `documents.lifecycle_state` is advisory everywhere in this system — nothing
 * enforces it on a write — and this module deliberately follows that
 * precedent. Legal hold and the check-out lock ARE enforced, by `addVersion`
 * and again here, so a person is told before they draw rather than after.
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { config } from '../../config/index.js';
import { db, sql } from '../../db/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { storage } from '../../storage/index.js';
import { getSetting } from '../settings/service.js';
import { PERM, has } from '../tree/service.js';
import { extensionRefusal } from '../uploads/policy.js';

const log = moduleLogger('signing');

/** The stored switch. Off means every route answers "disabled" and no version is written. */
export async function isEnabled() {
  return Boolean(await getSetting('signing.enabled'));
}

// ── The page-image cache ─────────────────────────────────────────────────

/**
 * Rendered pages, least recently used first, keyed by document/version/page/dpi.
 *
 * A Map preserves insertion order, so the least recently used entry is the
 * first key: a read re-inserts, a write past the ceiling deletes the head.
 * Entries are immutable by construction — a version's bytes never change — so
 * there is no invalidation to get wrong, only eviction. `cacheEntries: 0`
 * turns it off, which is how a memory-tight install opts out.
 */
const pageCache = new Map();

function cacheGet(key) {
  if (!pageCache.has(key)) return null;
  const value = pageCache.get(key);
  pageCache.delete(key);
  pageCache.set(key, value);
  return value;
}

function cachePut(key, value) {
  if (config.signing.cacheEntries < 1) return;
  pageCache.delete(key);
  pageCache.set(key, value);
  while (pageCache.size > config.signing.cacheEntries) {
    pageCache.delete(pageCache.keys().next().value);
  }
}

// ── The render slot ──────────────────────────────────────────────────────

/*
 * Two Ghostscript processes at a time, per Node process.
 *
 * `renderPage` is the only per-REQUEST subprocess spawn in the system —
 * renditions are produced by a background queue with its own limit, and the
 * forms converter takes one of `config.forms.maxConcurrent` before it spawns
 * LibreOffice. Without the same discipline here, a browser's six parallel
 * connections over a long document, or one script, is six unbounded
 * `gswin64c` processes each holding a core for up to `signing.timeoutMs`, and
 * every other user's request stalls behind them with nothing refused and
 * nothing in the trail.
 *
 * Two, and not a setting: there is nothing else to configure about signing
 * (the switch lives in الإعدادات and the module has no admin scope), and a
 * number that only matters when the host is already saturated is not a number
 * an administrator can tune usefully. A caller that cannot have a slot within
 * a second is told `busy` (503) rather than queued indefinitely, exactly as
 * the forms converter answers.
 */
const MAX_CONCURRENT_RENDERS = 2;
const SLOT_WAIT_MS = 1000;

let activeRenders = 0;
const slotQueue = [];

/** Takes a render slot, or gives up after `waitMs`. */
async function acquireSlot(waitMs = SLOT_WAIT_MS) {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return true;
  }

  return new Promise((resolve) => {
    const waiter = { settled: false, timer: null, grant: null };
    waiter.grant = (granted) => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      resolve(granted);
    };
    waiter.timer = setTimeout(() => {
      const index = slotQueue.indexOf(waiter);
      if (index >= 0) slotQueue.splice(index, 1);
      waiter.grant(false);
    }, waitMs);
    // A pending wait must not hold the process open at shutdown.
    waiter.timer.unref?.();
    slotQueue.push(waiter);
  });
}

/** Hands the slot to the next waiter, or gives it back to the pool. */
function releaseSlot() {
  const next = slotQueue.shift();
  if (next) {
    next.grant(true);
    return;
  }
  activeRenders = Math.max(0, activeRenders - 1);
}

// ── Small pure helpers ───────────────────────────────────────────────────

const PDF_FILENAME = /\.pdf$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** '.pdf' is forced onto the new version's filename, so any old extension goes. */
function stripExtension(name) {
  return String(name ?? '').replace(/\.[^.\\/]{1,16}$/, '');
}

/**
 * The page's box and rotation as a VIEWER sees it.
 *
 * CropBox, because that is what `-dUseCropBox` rasterised and what a viewer
 * shows; pdf-lib falls back to MediaBox on its own when the page declares no
 * CropBox. Width and height come back already swapped for a quarter turn, so
 * every caller compares like with like. A /Rotate that is not a multiple of 90
 * is malformed and treated as none: the alternative is guessing an arbitrary
 * affine transform for a page no two viewers agree about either.
 */
function displayedGeometry(page) {
  const raw = ((page.getRotation().angle % 360) + 360) % 360;
  const angle = raw % 90 === 0 ? raw : 0;
  const box = page.getCropBox();
  const quarter = angle === 90 || angle === 270;
  return {
    angle,
    box,
    width: quarter ? box.height : box.width,
    height: quarter ? box.width : box.height,
  };
}

/**
 * A point in DISPLAYED space (u to the right, v up, origin at the displayed
 * bottom-left corner of the CropBox) mapped to PDF user space.
 *
 * The four cases are the rotation table from the design, and the overlay
 * placement is simply this function at (0, 0) plus `rotate: degrees(angle)`.
 * Derived rather than measured: pdf-lib rotates a drawing about its (x, y)
 * anchor counter-clockwise, so (u, v) becomes (-v, u) at 90, (-u, -v) at 180
 * and (v, -u) at 270, added to the corner that anchor must sit on.
 */
function localToUser(box, angle, u, v) {
  switch (angle) {
    case 90:
      return { x: box.x + box.width - v, y: box.y + u };
    case 180:
      return { x: box.x + box.width - u, y: box.y + box.height - v };
    case 270:
      return { x: box.x + v, y: box.y + box.height - u };
    default:
      return { x: box.x + u, y: box.y + v };
  }
}

/** The pixel size Ghostscript produces for a displayed box at the signing dpi. */
function rasterSize({ width, height }, dpi = config.signing.dpi) {
  return {
    width: Math.round((width / 72) * dpi),
    height: Math.round((height / 72) * dpi),
  };
}

/**
 * The bytes of a `data:image/png;base64,…` value, or null.
 *
 * A bare base64 body is accepted too — the wire format is the client's
 * convenience, and the only thing that decides whether these bytes are a PNG
 * is the header check that follows.
 */
function decodeImage(value) {
  if (typeof value !== 'string' || value.length < 32) return null;

  let body = value;
  if (/^data:/i.test(value)) {
    if (!/^data:image\/png;base64,/i.test(value)) return null;
    body = value.slice(value.indexOf(',') + 1);
  }

  const cleaned = body.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return null;

  const buffer = Buffer.from(cleaned, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/**
 * The declared size in a PNG's IHDR, or null when these bytes are not a PNG.
 *
 * IHDR is required by the format to be the first chunk, so its offsets are
 * fixed: eight bytes of signature, a four-byte length that must be 13, the
 * chunk type, then width and height as big-endian 32-bit integers. Nothing is
 * decompressed and no decoder is loaded to answer this.
 */
function pngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.readUInt32BE(8) !== 13) return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * The provenance line, reduced to printable ASCII.
 *
 * The standard PDF fonts carry no Arabic glyphs, and pdf-lib throws on a
 * character the embedded font cannot encode — `WinAnsi cannot encode …`. A
 * signer called «علي» would therefore fail the save at the very last step,
 * after the ink had been accepted and the bytes assembled. So the line is
 * built from the user id, the version and the timestamp, and then filtered
 * anyway: it is a machine-readable stamp, not a caption, and the Arabic
 * display name lives in the version comment and the ledger, where it renders.
 */
function provenanceLine({ userId, version, at }) {
  const text = `DMS signature: user ${userId}, v${version}, ${at}`;
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) out += character;
  }
  return out;
}

// ── Reading the document's state ─────────────────────────────────────────

/**
 * Everything both `describe` and `sign` need to decide, in one query.
 *
 * The permission bits come from `dbo.fn_effective_permission`, which always
 * returns exactly one row (zero bits for a missing, deleted or unreachable
 * folder), so CROSS APPLY cannot drop the document. The lock holder's name and
 * the multi-file count ride along rather than costing two more round trips —
 * this runs on every document page in the system.
 */
async function signingState({ userId, documentId }) {
  const result = await sql`
    SELECT d.document_id, d.folder_id, d.title, d.current_version, d.legal_hold,
           d.locked_by, d.locked_at,
           locker.display_name AS locked_by_name,
           v.original_filename, v.mime_type, v.sha256, v.storage_path, v.file_size_bytes,
           p.perm_bits,
           (SELECT COUNT(*) FROM dbo.document_files f WHERE f.document_id = d.document_id) AS file_count
      FROM dbo.documents d
     CROSS APPLY dbo.fn_effective_permission(${userId}, d.folder_id) p
      LEFT JOIN dbo.document_versions v
        ON v.document_id = d.document_id AND v.version_number = d.current_version
      LEFT JOIN dbo.principals locker ON locker.principal_id = d.locked_by
     WHERE d.document_id = ${documentId} AND d.is_deleted = 0
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  const bits = Number(row.perm_bits);
  return {
    documentId: String(row.document_id),
    folderId: String(row.folder_id),
    title: row.title,
    currentVersion: Number(row.current_version),
    legalHold: Number(row.legal_hold) === 1,
    lockedByOther:
      row.locked_by !== null
      && row.locked_by !== undefined
      && String(row.locked_by) !== String(userId),
    lockedBy: row.locked_by_name
      ? { name: row.locked_by_name, since: isoOrNull(row.locked_at) }
      : null,
    multiFile: Number(row.file_count) > 0,
    filename: row.original_filename ?? null,
    mimeType: row.mime_type ?? null,
    sha256: row.sha256 ?? null,
    storagePath: row.storage_path ?? null,
    bytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    bits,
    canBrowse: has(bits, PERM.BROWSE),
    canRead: has(bits, PERM.READ),
    canUpload: has(bits, PERM.UPLOAD),
  };
}

/**
 * Why this document cannot be signed, in the order a person should hear it.
 *
 * Permission first (there is nothing to say to somebody who cannot open the
 * file), then the two facts about the document's shape, then the two freezes,
 * then the install's own upload policy. `checkRenderer` is false for `sign`:
 * flattening ink is pdf-lib work and needs no Ghostscript, so a renderer that
 * has gone missing since the page was drawn must not lose somebody's
 * signature.
 */
async function signability(state, { checkRenderer = true } = {}) {
  if (!state.canRead || !state.canUpload) return { canSign: false, reason: 'forbidden' };

  // current_version 0 with no version row is how a multi-file document looks;
  // both are refused by the same name, because both mean "this document is not
  // one file with versions" and that is the only distinction the panel can draw.
  if (state.multiFile || state.currentVersion < 1) {
    return { canSign: false, reason: 'multi_file_document' };
  }

  const isPdf = state.mimeType === 'application/pdf' || PDF_FILENAME.test(state.filename ?? '');
  if (!isPdf) return { canSign: false, reason: 'not_pdf' };

  if (state.legalHold) return { canSign: false, reason: 'legal_hold' };
  if (state.lockedByOther) return { canSign: false, reason: 'locked', lockedBy: state.lockedBy };

  // The install's allowed-extension list is enforced by `addVersion` at the
  // very end of the save. Asked here as well, so a list that excludes pdf is a
  // sentence on the screen before anybody draws, not a refusal afterwards.
  if (await extensionRefusal('signature.pdf')) return { canSign: false, reason: 'pdf_not_allowed' };

  if (checkRenderer) {
    const { detectTools } = await import('../renditions/service.js');
    const tools = await detectTools();
    if (!tools.ghostscript.available) return { canSign: false, reason: 'renderer_missing' };
  }

  return { canSign: true };
}

// ── describe ─────────────────────────────────────────────────────────────

/**
 * What the panel needs before it shows anything, and nothing more.
 *
 * A caller with BROWSE but not READ gets the refusal alone: no filename, no
 * version, no signature list. That a document exists is BROWSE; that the
 * director signed page three of it last Tuesday is not, and a signature list
 * is the kind of fact that leaks a whole story.
 */
export async function describe({ userId, documentId }) {
  if (!(await isEnabled())) return { ok: true, enabled: false };

  const state = await signingState({ userId, documentId });
  if (!state || !state.canBrowse) return { ok: false, reason: 'not_found' };

  if (!state.canRead) {
    return { ok: true, enabled: true, canRead: false, canSign: false, reason: 'forbidden' };
  }

  const [verdict, signatures] = await Promise.all([
    signability(state),
    listSignatures({ documentId: state.documentId, currentVersion: state.currentVersion }),
  ]);

  return {
    ok: true,
    enabled: true,
    canRead: true,
    canSign: verdict.canSign,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.lockedBy ? { lockedBy: verdict.lockedBy } : {}),
    version: state.currentVersion,
    filename: state.filename ?? state.title,
    title: state.title,
    signatures,
  };
}

// ── listSignatures ───────────────────────────────────────────────────────

/**
 * The ledger for one document, newest first.
 *
 * `isCurrent` is computed rather than stored: a later version — another
 * signature, an ordinary upload, a restore — moves the document on without
 * touching this row, and a stored flag would have to be swept by every one of
 * those paths. The panel shows a warning badge when it is false, because a
 * signature on a superseded version is a true fact about a document nobody is
 * looking at any more.
 */
export async function listSignatures({ documentId, currentVersion = null }) {
  const result = await sql`
    SELECT s.signature_id, s.version_number, s.signed_by, s.signed_at,
           s.pages_json, s.note, s.from_sha256, s.sha256,
           p.display_name AS signer_name,
           d.current_version
      FROM dbo.document_signatures s
      JOIN dbo.documents d ON d.document_id = s.document_id
      LEFT JOIN dbo.principals p ON p.principal_id = s.signed_by
     WHERE s.document_id = ${documentId}
     ORDER BY s.signed_at DESC, s.signature_id DESC
  `.execute(db);

  return result.rows.map((row) => {
    const current = currentVersion ?? Number(row.current_version);
    let pages = [];
    try {
      const parsed = JSON.parse(row.pages_json);
      if (Array.isArray(parsed)) pages = parsed.map(Number).filter(Number.isInteger);
    } catch {
      // A row whose page list cannot be read must still be listed: the pages
      // are a detail, the signature is the fact.
      pages = [];
    }

    return {
      signatureId: String(row.signature_id),
      version: Number(row.version_number),
      signedBy: row.signer_name ?? null,
      signedAt: isoOrNull(row.signed_at),
      pages,
      note: row.note ?? null,
      fromSha256: row.from_sha256 ?? null,
      sha256: row.sha256 ?? null,
      isCurrent: Number(row.version_number) === Number(current),
    };
  });
}

// ── pageGeometry ─────────────────────────────────────────────────────────

/**
 * Page count and each page's displayed size, from one pdf-lib load.
 *
 * The panel sizes its canvas from this and the server checks the posted PNGs
 * against it, so both ends work from the same numbers. The renderer is checked
 * even though pdf-lib needs none: a geometry answer the panel cannot turn into
 * a picture is a spinner with no explanation, and the honest reply to "let me
 * sign this" on a host without Ghostscript is 503 with a reason.
 */
export async function pageGeometry({ userId, documentId, version }) {
  if (!(await isEnabled())) return { ok: false, reason: 'signing_disabled' };

  const { detectTools } = await import('../renditions/service.js');
  const tools = await detectTools();
  if (!tools.ghostscript.available) return { ok: false, reason: 'renderer_missing' };

  const { getVersionForRead } = await import('../documents/service.js');
  const found = await getVersionForRead({ userId, documentId, version });
  if (!found) return { ok: false, reason: 'not_found' };

  const bytes = await readVersion(found.storagePath);

  let pdf;
  try {
    const { PDFDocument } = await import('pdf-lib');
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (error) {
    // Deliberately NOT the swallow-and-return-null of `stampPdf`: a decoration
    // that cannot be drawn is skipped, but a signature that cannot be placed
    // must be refused by name, or the strokes vanish with nothing said.
    log.warn({ err: error, documentId: String(documentId) }, 'the PDF could not be read for signing');
    return { ok: false, reason: 'unreadable_pdf' };
  }

  const pages = pdf.getPages().map((page, index) => {
    const geometry = displayedGeometry(page);
    const want = rasterSize(geometry);
    const pixels = want.width * want.height;
    /*
     * A page can be too big to sign, and this is where a person must hear it.
     *
     * The overlay a person posts back is a picture of the page at the signing
     * dpi, so its pixel count is a property of the PAGE, not of the drawing. An
     * A0 drawing at 150 dpi is 4967×7021 = 34.9 million pixels, over the
     * `maxPixels` ceiling the save enforces on the posted PNG's header — so
     * without this flag the page renders, somebody inks it, and the save is
     * refused with «صورة التوقيع لا تطابق قياس الصفحة», whose advice (refresh
     * and redraw) reproduces the identical refusal for ever.
     *
     * The ceiling itself stays where it is in `sign`: that check is the
     * pre-decode allocation guard and must run on the bytes as they arrive.
     * This is the same number, read early enough to be useful.
     */
    const signable = pixels <= config.signing.maxPixels;
    return {
      number: index + 1,
      width: Number(geometry.width.toFixed(2)),
      height: Number(geometry.height.toFixed(2)),
      rotation: geometry.angle,
      pixels,
      signable,
      ...(signable ? {} : { reason: 'too_large' }),
    };
  });

  return {
    ok: true,
    version: found.versionNumber,
    pageCount: pages.length,
    pages,
    dpi: config.signing.dpi,
    // Published so the panel can say how far over the line a page is, with the
    // server's own number rather than a copy that drifts from the setting.
    maxPixels: config.signing.maxPixels,
  };
}

// ── renderPage ───────────────────────────────────────────────────────────

/**
 * One page as a PNG, at the signing resolution.
 *
 * Ghostscript is handed a temp COPY rather than the stored path, because
 * stored paths deliberately carry the document's Arabic title and no evidence
 * exists that gswin64c survives one on a Windows host whose ANSI codepage is
 * not UTF-8 — Tesseract does not, which is why extraction feeds it through
 * stdin. The copy is written under `tmpdir()` with an ASCII name, streamed out
 * of the blob store rather than buffered through it, and removed on every
 * branch.
 *
 * Before anything is spawned the copy is read once with pdf-lib, for the two
 * refusals only the page itself can answer: a page number past the end, and a
 * raster over `maxPixels` — the ceiling the save end enforces on the overlay,
 * which is a property of the page and so must be refused here too. Then one of
 * two render slots, because this is the only per-request subprocess spawn in
 * the system and a loop over pages must not be able to take the host down.
 */
export async function renderPage({ userId, documentId, page, version }) {
  if (!(await isEnabled())) return { ok: false, reason: 'signing_disabled' };

  const { detectTools, rasterisePdfPage } = await import('../renditions/service.js');
  const tools = await detectTools();
  if (!tools.ghostscript.available) return { ok: false, reason: 'renderer_missing' };

  const { getVersionForRead } = await import('../documents/service.js');
  const found = await getVersionForRead({ userId, documentId, version });
  if (!found) return { ok: false, reason: 'not_found' };

  const dpi = config.signing.dpi;
  const key = `${documentId}/${found.versionNumber}/${page}/${dpi}`;
  const cached = cacheGet(key);
  if (cached) return { ok: true, png: cached, version: found.versionNumber, cached: true };

  const workDir = await mkdtemp(path.join(tmpdir(), 'dms-sign-'));
  const copy = path.join(workDir, 'page.pdf');

  let slot = false;
  try {
    await pipeline(storage.createReadStream(found.storagePath), createWriteStream(copy));

    /*
     * How big the picture would be, before anything is spawned to make it.
     *
     * PDF permits a page up to 14400 × 14400 points, which at the signing dpi
     * is 30000 × 30000 = 900 million pixels: seconds of a full core, gigabytes
     * through a temp volume, and one `readFile` of the result into this
     * process — for a page that `sign` would then refuse anyway, because it is
     * over the same `maxPixels` ceiling. So the ceiling is read at BOTH ends,
     * from the same CropBox, and the render end refuses first.
     *
     * The load costs one parse of the temp copy per page that is not already
     * cached, which is the trade this module makes everywhere pdf-lib is
     * involved (`pageGeometry` and `sign` both buffer a whole version), and it
     * is small beside the Ghostscript run it is guarding.
     */
    const { PDFDocument } = await import('pdf-lib');
    let pdfPages;
    try {
      const pdf = await PDFDocument.load(await readFile(copy), { ignoreEncryption: false });
      pdfPages = pdf.getPages();
    } catch (error) {
      log.warn({ err: error, documentId: String(documentId) }, 'the PDF could not be read for rendering');
      return { ok: false, reason: 'unreadable_pdf' };
    }

    // Now that the page count is known, a page past the end can be named as
    // what it is instead of arriving as a non-zero Ghostscript exit.
    if (page > pdfPages.length) {
      return { ok: false, reason: 'invalid_page', detail: `page ${page} of ${pdfPages.length}` };
    }

    const want = rasterSize(displayedGeometry(pdfPages[page - 1]), dpi);
    if (want.width * want.height > config.signing.maxPixels) {
      return { ok: false, reason: 'too_large', limit: config.signing.maxPixels };
    }

    slot = await acquireSlot();
    if (!slot) {
      log.warn({ documentId: String(documentId), page }, 'no render slot was free within a second');
      return { ok: false, reason: 'busy' };
    }

    const png = await rasterisePdfPage({
      pdfPath: copy,
      page,
      dpi,
      timeoutMs: config.signing.timeoutMs,
    });

    cachePut(key, png);
    return { ok: true, png, version: found.versionNumber, cached: false };
  } catch (error) {
    if (error?.code === 'render_timeout') {
      log.warn({ documentId: String(documentId), page }, 'rendering a page for signing timed out');
      return { ok: false, reason: 'render_timeout' };
    }
    /*
     * One reason for whatever is left, and it is the honest one.
     *
     * Ghostscript exits non-zero for a file it cannot parse and for reasons it
     * does not distinguish in any form worth parsing — the two cases this code
     * CAN name, an impossible page number and an unreadable PDF, are refused
     * above by name. Rather than guess at the rest, the refusal says the page
     * could not be produced.
     */
    log.warn({ err: error, documentId: String(documentId), page }, 'rendering a page for signing failed');
    return { ok: false, reason: 'render_failed' };
  } finally {
    if (slot) releaseSlot();
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── sign ─────────────────────────────────────────────────────────────────

/**
 * Flatten one or more overlays onto the current version and file the result.
 *
 * The order below is the design's, and each step comes before the next because
 * the next is more expensive or less reversible. Nothing is written until every
 * posted image has been proved to be a PNG of the right size for the page it
 * claims, and the document's own state has been re-read inside this call — the
 * panel's `describe` answer may be minutes old, and a hold placed or a lock
 * taken in the meantime must win.
 *
 * @param {object} args
 * @param {number} args.version  the version the ink was drawn on; a mismatch is `conflict`
 * @param {Array}  args.pages    [{ number, image: 'data:image/png;base64,…' }]
 */
export async function sign({ userId, documentId, version, note = null, pages, displayName = null }) {
  if (!(await isEnabled())) return { ok: false, reason: 'signing_disabled' };

  const state = await signingState({ userId, documentId });
  if (!state || !state.canBrowse) return { ok: false, reason: 'not_found' };

  const verdict = await signability(state, { checkRenderer: false });
  if (!verdict.canSign) {
    return {
      ok: false,
      reason: verdict.reason,
      ...(verdict.lockedBy ? { lockedBy: verdict.lockedBy } : {}),
    };
  }

  /*
   * The version the ink was drawn on must still be the current one.
   *
   * Ink is bound to a picture of particular bytes. If somebody uploaded a new
   * version while the pen was moving, the strokes belong to a page that is no
   * longer the document, and placing them on the new one would put a signature
   * over text nobody signed. The panel keeps the ink and offers a reload.
   */
  const expected = Number(version);
  if (!Number.isInteger(expected) || expected !== state.currentVersion) {
    return { ok: false, reason: 'conflict', version: state.currentVersion };
  }

  if (!Array.isArray(pages) || pages.length === 0) return { ok: false, reason: 'no_strokes' };
  if (pages.length > config.signing.maxPagesPerRequest) {
    return { ok: false, reason: 'too_many_pages', limit: config.signing.maxPagesPerRequest };
  }

  /*
   * Page numbers and PNG headers before the PDF is even read.
   *
   * A duplicate page would otherwise be drawn twice with the second overlay
   * hiding the first, and a declared pixel count is the one thing that must be
   * checked while it is still only twelve bytes. What cannot be checked yet is
   * whether each image is the right SIZE for its page: that needs the page's
   * CropBox, so it happens straight after the load and still before `embedPng`
   * hands any of these bytes to a decoder.
   */
  const overlays = [];
  const seen = new Set();
  for (const entry of pages) {
    const number = Number(entry?.number);
    if (!Number.isInteger(number) || number < 1 || number > 9999) {
      return { ok: false, reason: 'invalid_page' };
    }
    if (seen.has(number)) return { ok: false, reason: 'invalid_page', detail: `page ${number} twice` };
    seen.add(number);

    const buffer = decodeImage(entry?.image);
    if (!buffer) return { ok: false, reason: 'invalid_image', detail: `page ${number}` };

    const header = pngHeader(buffer);
    if (!header) return { ok: false, reason: 'invalid_image', detail: `page ${number}` };
    if (header.width * header.height > config.signing.maxPixels) {
      return { ok: false, reason: 'invalid_image', detail: `page ${number} declares too many pixels` };
    }

    overlays.push({ number, buffer, header });
  }
  overlays.sort((a, b) => a.number - b.number);

  const bytes = await readVersion(state.storagePath);

  let pdf;
  let degrees;
  let rgb;
  let StandardFonts;
  try {
    let PDFDocument;
    ({ PDFDocument, degrees, rgb, StandardFonts } = await import('pdf-lib'));
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (error) {
    log.warn({ err: error, documentId: String(documentId) }, 'the PDF could not be read for signing');
    return { ok: false, reason: 'unreadable_pdf' };
  }

  const pdfPages = pdf.getPages();
  for (const overlay of overlays) {
    if (overlay.number > pdfPages.length) {
      return { ok: false, reason: 'invalid_page', detail: `page ${overlay.number} of ${pdfPages.length}` };
    }

    const geometry = displayedGeometry(pdfPages[overlay.number - 1]);
    const want = rasterSize(geometry);
    if (
      Math.abs(overlay.header.width - want.width) > 2
      || Math.abs(overlay.header.height - want.height) > 2
    ) {
      // The overlay is not a picture of this page. Refused rather than scaled:
      // stretching it to fit would move every stroke a little, and a signature
      // that is nearly where somebody drew it is a forgery of the one they did.
      return {
        ok: false,
        reason: 'invalid_image',
        detail: `page ${overlay.number} is ${overlay.header.width}×${overlay.header.height}, expected ${want.width}×${want.height}`,
      };
    }
    overlay.geometry = geometry;
  }

  const newVersion = state.currentVersion + 1;
  const signedAt = new Date().toISOString();

  let font = null;
  if (config.signing.provenance) font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const overlay of overlays) {
    const page = pdfPages[overlay.number - 1];
    const { box, angle, width, height } = overlay.geometry;

    const image = await pdf.embedPng(overlay.buffer);
    const anchor = localToUser(box, angle, 0, 0);
    page.drawImage(image, {
      x: anchor.x,
      y: anchor.y,
      width,
      height,
      rotate: degrees(angle),
    });

    if (font) {
      const at = localToUser(box, angle, 6, 6);
      page.drawText(provenanceLine({ userId, version: newVersion, at: signedAt }), {
        x: at.x,
        y: at.y,
        size: 7,
        font,
        color: rgb(0.35, 0.35, 0.35),
        rotate: degrees(angle),
      });
    }
  }

  let flattened;
  try {
    flattened = Buffer.from(await pdf.save());
  } catch (error) {
    log.error({ err: error, documentId: String(documentId) }, 'the signed PDF could not be written');
    return { ok: false, reason: 'unreadable_pdf' };
  }

  const { addVersion } = await import('../documents/service.js');
  const added = await addVersion({
    userId,
    documentId,
    stream: Readable.from(flattened),
    // The extension is forced because `buildRelativePath` derives the stored
    // extension from it and `extensionRefusal` tests it: whatever the original
    // was called, what is being stored now is a PDF.
    filename: `${stripExtension(state.filename || state.title) || 'document'}.pdf`,
    mimeType: 'application/pdf',
    comment: `توقيع: ${displayName || 'مستخدم'}`.slice(0, 1000),
  });

  if (!added.ok) return added;

  const pageNumbers = overlays.map((overlay) => overlay.number);
  const trimmedNote =
    note === null || note === undefined ? null : String(note).trim().slice(0, 500) || null;

  /*
   * The ledger row is written AFTER the version, and its failure is not the
   * caller's failure.
   *
   * The signed bytes are committed by then — the version row, the storage file
   * and `current_version` all moved in one transaction inside `addVersion`.
   * Reporting an error at that point would tell the person their signature did
   * not land while it demonstrably did, and there is no undo that would make
   * that true. So the failure is logged at error level, the route still records
   * the signing in the audit trail, and the answer says `ledger: false`.
   */
  let signatureId = null;
  let ledger = true;
  try {
    const inserted = await sql`
      INSERT INTO dbo.document_signatures
        (document_id, version_number, signed_by, signed_at, pages_json, note, from_sha256, sha256)
      OUTPUT INSERTED.signature_id AS sid
      VALUES (${documentId}, ${added.version}, ${userId},
              CONVERT(datetime2(3), ${signedAt}, 126),
              ${JSON.stringify(pageNumbers)}, ${trimmedNote},
              ${state.sha256}, ${added.sha256})
    `.execute(db);
    signatureId = String(inserted.rows[0].sid);
  } catch (error) {
    ledger = false;
    log.error(
      { err: error, documentId: String(documentId), version: added.version },
      'the signature ledger row could not be written, but the signed version was committed',
    );
  }

  log.info(
    { documentId: String(documentId), version: added.version, pages: pageNumbers.length },
    'document signed',
  );

  return {
    ok: true,
    documentId: String(documentId),
    folderId: state.folderId,
    title: state.title,
    version: added.version,
    signatureId,
    ledger,
    sha256: added.sha256,
    fromSha256: state.sha256,
    pages: pageNumbers,
  };
}

// ── Reading a version's bytes ────────────────────────────────────────────

/**
 * A whole version in memory.
 *
 * The same trade the `?stamp=qr` download branch makes, for the same reason:
 * buffering a file is wrong for ordinary viewing and right for one deliberate
 * action a person is waiting on. pdf-lib has no streaming API, and the upload
 * size limit already bounds what can be in here.
 */
async function readVersion(storagePath) {
  const chunks = [];
  for await (const chunk of storage.createReadStream(storagePath)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
