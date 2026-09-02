/**
 * Thumbnails and browser previews.
 *
 * ─── Two problems, one pipeline ─────────────────────────────────────────────
 *
 *   • A thumbnail makes a folder of scans browsable at a glance.
 *   • A preview lets an Office file be read without downloading it, which is
 *     what stops people accumulating local copies and defeating version control.
 *
 * Both are "turn this file into something a browser can show", so both go
 * through the same queue and the same worker.
 *
 * ─── External tools, optional ───────────────────────────────────────────────
 *
 * Office conversion needs LibreOffice headless; PDF rasterising needs
 * Ghostscript. Images need neither — sharp handles them in-process. Everything
 * degrades: with no tools installed, images still get thumbnails and Office
 * files simply have no preview, which is exactly the state the system was in
 * before this existed.
 *
 * ─── The source file is never touched ───────────────────────────────────────
 *
 * Conversion output goes to a temp directory and the rendition is written as a
 * new file. The stored document must stay byte-identical to what was uploaded,
 * because its SHA-256 is recorded and verified.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { db, sql } from '../../db/index.js';
import { storage } from '../../storage/index.js';
import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('renditions');

export const QUEUE = Object.freeze({ PENDING: 0, RUNNING: 1, DONE: 2, RETRYABLE: 3, FAILED: 4, SKIPPED: 5 });

const IMAGE = /\.(png|jpe?g|tiff?|bmp|webp|gif)$/i;
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
const PDF = /\.pdf$/i;

/**
 * Images every browser draws natively. For these the stored file is already its
 * own best preview, so no rendition is made and the viewer is pointed at the
 * content route instead — full resolution, and served from cache on a re-open.
 *
 * TIFF is the one that matters by its absence: it is what a scanner produces and
 * what a large share of this system's documents are, and no browser has ever
 * displayed it. Without a rendition, "preview the row" would work for everything
 * except the format the system is mostly fed.
 */
const BROWSER_SAFE_IMAGE = /\.(png|jpe?g|gif|webp)$/i;

const THUMBNAIL_WIDTH = 320;

/**
 * Wide enough that Arabic body text in a 300 dpi A4 scan stays legible when the
 * preview pane is opened full width, and small enough that it is a fraction of
 * the original — the point of a preview is not downloading the original.
 */
const PREVIEW_WIDTH = 1600;

/**
 * sharp's own guard against a decompression bomb, named once instead of repeated
 * as a bare number at every call site.
 */
const SAFE_PIXELS = 268_402_689;

/**
 * How many pages of a scan the preview will build.
 *
 * A bound is needed — a thousand-page TIFF would exhaust the worker's memory and
 * take the whole rendition queue with it — but it is set far above any real
 * scanned document so that reaching it is a reportable event rather than a
 * routine one.
 */
const MAX_PREVIEW_PAGES = 200;

/**
 * The environment LibreOffice is given, which keeps it away from the printer.
 *
 * ─── The failure this prevents ──────────────────────────────────────────────
 *
 * VCL asks Windows for the default printer during startup — headless, even when
 * the job is `--convert-to pdf` and nothing will ever be printed. On a machine
 * whose default printer is an unreachable network device that call blocks in the
 * print spooler until it gives up.
 *
 * Measured on the development machine, whose default was a RICOH on a WSD port
 * that had stopped answering: 48.6s for a single capability query against it,
 * against 0.1–1.0s for every local printer. Conversions took ~52s, essentially
 * all of it that one call, and Windows put "waiting for printer" on screen each
 * time. Nothing reported an error — the work simply took a minute.
 *
 * `SAL_DISABLE_DEFAULTPRINTER` short-circuits `Printer::GetDefaultPrinterName()`
 * before it reaches the spooler; `SAL_DISABLE_PRINTERLIST` does the same for the
 * queue enumeration in `ImplInitPrnQueueList()`. Both are read straight from the
 * environment in vcl/source/gdi/print.cxx with no platform guard, and both are
 * the documented workaround for LibreOffice bug 42673.
 *
 * Scoped to the child process, so an interactive LibreOffice on the same machine
 * is unaffected — it inherits the desktop's environment, not the server's.
 *
 * The only thing lost is the printer's page geometry as a fallback for documents
 * that carry no page size of their own. Stored documents effectively always do,
 * and a preview inheriting A4 instead of a specific printer's default is a much
 * smaller problem than a preview that takes a minute to appear.
 */
const LIBREOFFICE_ENV = Object.freeze({
  ...process.env,
  SAL_DISABLE_DEFAULTPRINTER: '1',
  SAL_DISABLE_PRINTERLIST: '1',
});

/**
 * The LibreOffice binary to actually spawn.
 *
 * ─── Why this is not just the configured path ───────────────────────────────
 *
 * Windows ships two front ends to the same program. `soffice.exe` is marked as
 * a GUI-subsystem binary: launched without a console it never writes to stdout
 * and, in the headless invocations used here, never exits — the parent waits
 * until its own timeout and concludes the tool is missing. `soffice.com` is the
 * console front end, and it behaves the way a command-line program should.
 *
 * Measured on this machine: `soffice.exe --version` produced no output and had
 * still not exited after two minutes; `soffice.com --version` answered in
 * milliseconds.
 *
 * The installer advertises the `.exe`, so that is what an operator will
 * naturally put in the configuration, and the resulting failure is invisible —
 * previews just never appear, with no error anywhere. Preferring the sibling
 * `.com` when one exists costs a single stat and removes an entire class of
 * "renditions are silently off in production" report.
 *
 * The configured value still wins when it is anything else, so pointing at a
 * wrapper script or a non-standard install keeps working.
 */
let libreOfficeCommand = null;

function libreOffice() {
  if (libreOfficeCommand) return libreOfficeCommand;

  const configured = config.renditions.libreOfficePath;
  libreOfficeCommand = configured;

  if (process.platform === 'win32' && /soffice\.exe$/i.test(configured)) {
    const consoleFrontEnd = configured.replace(/soffice\.exe$/i, 'soffice.com');
    if (existsSync(consoleFrontEnd)) libreOfficeCommand = consoleFrontEnd;
  }

  return libreOfficeCommand;
}

function run(command, args, { timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // No shell, argument array: a filename must never become command syntax.
      // env undefined means inherit process.env unchanged, which is what every
      // caller but LibreOffice wants.
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      return reject(error);
    }

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 50_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr, timedOut });
    });
  });
}

let detected = null;

export async function detectTools({ force = false } = {}) {
  if (detected && !force) return detected;

  const probe = async (command, args, options = {}) => {
    try {
      const result = await run(command, args, { timeoutMs: 15_000, ...options });
      return { available: result.code === 0 };
    } catch {
      return { available: false };
    }
  };

  const [libreoffice, ghostscript] = await Promise.all([
    probe(libreOffice(), ['--version'], { env: LIBREOFFICE_ENV }),
    probe(config.renditions.ghostscriptPath, ['--version']),
  ]);

  detected = { libreoffice, ghostscript, sharp: { available: true } };
  return detected;
}

export async function renditionStatus() {
  const tools = await detectTools({ force: true });

  /*
   * A tool probe alone is a false green light.
   *
   * `soffice --version` answering says LibreOffice is installed; it says nothing
   * about whether conversions are succeeding. This screen reported "Office
   * previews: working" for a deployment where every single conversion was
   * failing, because the probe passed. The queue is the only thing that knows
   * what actually happened, so it is reported alongside.
   */
  const counts = await sql`
    SELECT status, COUNT(*) AS total FROM dbo.rendition_queue GROUP BY status
  `.execute(db);

  const queue = { pending: 0, running: 0, done: 0, retryable: 0, failed: 0, skipped: 0 };
  const names = ['pending', 'running', 'done', 'retryable', 'failed', 'skipped'];
  for (const row of counts.rows) {
    const name = names[Number(row.status)];
    if (name) queue[name] = Number(row.total);
  }

  /*
   * Measured from when the job was CLAIMED, not when it was enqueued.
   *
   * `queued_at` counted a job that had merely waited a long time in the queue as
   * stuck, and would have gone on counting it while it ran perfectly normally.
   * The two states need different responses, so they need different clocks.
   */
  const stuck = await sql`
    SELECT COUNT(*) AS n FROM dbo.rendition_queue
     WHERE status = ${QUEUE.RUNNING}
       AND (
             started_at IS NULL
             OR DATEDIFF(second, started_at, SYSUTCDATETIME()) > ${Math.floor(STALE_CLAIM_MS / 1000)}
           )
  `.execute(db);

  const recent = await sql`
    SELECT TOP (10) q.document_id, q.version_number, q.kind, q.attempts, q.last_error, q.finished_at,
           d.title
      FROM dbo.rendition_queue q
      JOIN dbo.documents d ON d.document_id = q.document_id
     WHERE q.status IN (${QUEUE.FAILED}, ${QUEUE.SKIPPED}) AND d.is_deleted = 0
     ORDER BY q.finished_at DESC
  `.execute(db);

  return {
    enabled: config.renditions.enabled,
    ...tools,
    // Says plainly what each missing tool costs, rather than leaving an operator
    // to work out why some previews exist and others do not.
    officePreview: tools.libreoffice.available,
    pdfThumbnails: tools.ghostscript.available,
    imageThumbnails: true,
    queue,
    stuckJobs: Number(stuck.rows[0].n),
    failures: recent.rows.map((row) => ({
      documentId: String(row.document_id),
      version: Number(row.version_number),
      title: row.title,
      kind: row.kind,
      attempts: Number(row.attempts),
      reason: row.last_error,
      finishedAt: row.finished_at,
    })),
  };
}

/**
 * Queues a rendition. Called after upload, alongside extraction.
 *
 * `fileId` names one constituent of a multi-file document; NULL means the
 * document's own current version. Both live in this queue and are drained by
 * the same worker — the only thing that differs is which row supplies the
 * source path.
 */
export async function enqueueRendition(trx, documentId, versionNumber, kind = 'thumbnail', fileId = null) {
  await sql`
    MERGE dbo.rendition_queue WITH (HOLDLOCK) AS target
    USING (SELECT ${documentId} AS document_id, ${versionNumber} AS version_number,
                  ${kind} AS kind, ${fileId} AS file_id) AS source
       ON target.document_id = source.document_id
      AND target.version_number = source.version_number
      AND target.kind = source.kind
      -- Compared with an IS NULL pair rather than equality: SQL's NULL = NULL is
      -- unknown, so an equality-only join would never match an existing
      -- document-level row and every call would try to insert a duplicate.
      AND (target.file_id = source.file_id
           OR (target.file_id IS NULL AND source.file_id IS NULL))
    WHEN MATCHED THEN
      UPDATE SET status = 0, attempts = 0, last_error = NULL, queued_at = SYSUTCDATETIME(), finished_at = NULL
    WHEN NOT MATCHED THEN
      INSERT (document_id, version_number, kind, file_id)
      VALUES (source.document_id, source.version_number, source.kind, source.file_id);
  `.execute(trx);
}

/**
 * How long a rendition may sit claimed before another worker may take it.
 *
 * Must exceed the slowest legitimate job, which here is a LibreOffice
 * conversion of a large document — those are measured in tens of seconds, so
 * fifteen minutes is far beyond any honest run.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000;

/**
 * Atomically claims one job.
 *
 * ─── Why RUNNING is reclaimable ─────────────────────────────────────────────
 *
 * A worker that dies mid-job leaves its row in RUNNING, and this used to select
 * only PENDING and RETRYABLE — so nothing ever moved that row again. The
 * document kept its place in every listing and simply never got a thumbnail,
 * with no error recorded and no sign of a problem. A routine server restart
 * produced it, which is how three documents ended up stranded here.
 *
 * The extraction queue already worked this way; this is the same recovery,
 * arriving late. `attempts` still increments, so a job that reliably kills its
 * worker exhausts its retries and stops rather than looping forever.
 *
 * A NULL `started_at` on a RUNNING row means the row predates migration 0011 —
 * it was stranded before the column existed, so it is exactly the kind of row
 * this is meant to recover.
 */
async function claim(maxAttempts) {
  const result = await sql`
    UPDATE TOP (1) q
       SET status = ${QUEUE.RUNNING},
           started_at = SYSUTCDATETIME(),
           attempts = q.attempts + 1
      OUTPUT INSERTED.queue_id, INSERTED.document_id, INSERTED.version_number,
             INSERTED.kind, INSERTED.attempts, INSERTED.file_id, INSERTED.file_id
      FROM dbo.rendition_queue AS q WITH (READPAST, UPDLOCK, ROWLOCK)
     WHERE (
             q.status IN (${QUEUE.PENDING}, ${QUEUE.RETRYABLE})
             OR (
               q.status = ${QUEUE.RUNNING}
               AND (
                     q.started_at IS NULL
                     OR DATEDIFF(second, q.started_at, SYSUTCDATETIME()) > ${Math.floor(STALE_CLAIM_MS / 1000)}
                   )
             )
           )
       AND q.attempts < ${maxAttempts}
  `.execute(db);

  return result.rows[0] ?? null;
}

async function finish(queueId, status, error) {
  await sql`
    UPDATE dbo.rendition_queue
       SET status = ${status}, finished_at = SYSUTCDATETIME(),
           last_error = ${error ? String(error).slice(0, 1000) : null}
     WHERE queue_id = ${queueId}
  `.execute(db);
}

/** Runs one queued rendition. */
export async function processOne({ maxAttempts = 3 } = {}) {
  const job = await claim(maxAttempts);
  if (!job) return { claimed: false };

  const {
    queue_id: queueId,
    document_id: documentId,
    version_number: versionNumber,
    kind,
    file_id: fileId,
  } = job;

  try {
    // Version 0 is the multi-file document's key — dbo.document_versions
    // constrains version_number >= 1, so it can never collide with a real
    // version. A thumbnail stands for the whole document in a listing, and the
    // first constituent file is the one a reader would recognise it by, so that
    // is what gets rendered. The other files are reachable from the document
    // itself; a listing has room for one image.
    /*
     * Three sources, in order of specificity.
     *
     * A named file is rendered for itself — that is what makes previewing one
     * constituent of a multi-file document possible at all. Without a file id,
     * version 0 still means "the whole multi-file document", whose stand-in is
     * its first constituent, and anything else is an ordinary version.
     */
    const found = fileId
      ? await sql`
          SELECT storage_path, original_filename, mime_type
            FROM dbo.document_files
           WHERE document_id = ${documentId} AND file_id = ${fileId}
        `.execute(db)
      : Number(versionNumber) === 0
        ? await sql`
            SELECT TOP (1) storage_path, original_filename, mime_type
              FROM dbo.document_files
             WHERE document_id = ${documentId}
             ORDER BY sort_order ASC
          `.execute(db)
        : await sql`
            SELECT storage_path, original_filename, mime_type FROM dbo.document_versions
             WHERE document_id = ${documentId} AND version_number = ${versionNumber}
          `.execute(db);

    const version = found.rows[0];
    if (!version) {
      await finish(queueId, QUEUE.SKIPPED, 'version no longer exists');
      return { claimed: true, outcome: 'missing' };
    }

    const name = version.original_filename ?? version.storage_path;
    const absolute = storage.absolute(version.storage_path);

    const produced = kind === 'preview'
      ? await buildPreview(absolute, name)
      : await buildThumbnail(absolute, name);

    if (!produced) {
      await finish(queueId, QUEUE.SKIPPED, 'no renderer for this type');
      return { claimed: true, outcome: 'unsupported' };
    }

    // The file id is part of the path as well as the key: two constituents of
    // one document would otherwise write to the same name and the second would
    // silently overwrite the first.
    const scope = fileId ? `${versionNumber}-f${fileId}` : String(versionNumber);
    const relativePath = `renditions/${documentId}/${scope}-${kind}.${produced.extension}`;
    await storage.putBuffer(produced.buffer, relativePath);

    await sql`
      MERGE dbo.document_renditions WITH (HOLDLOCK) AS target
      USING (SELECT ${documentId} AS document_id, ${versionNumber} AS version_number,
                    ${kind} AS kind, ${fileId ?? null} AS file_id) AS source
         ON target.document_id = source.document_id
        AND target.version_number = source.version_number
        AND target.kind = source.kind
        AND (target.file_id = source.file_id
             OR (target.file_id IS NULL AND source.file_id IS NULL))
      WHEN MATCHED THEN
        UPDATE SET storage_path = ${relativePath}, mime_type = ${produced.mimeType},
                   bytes = ${produced.buffer.length}, created_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (document_id, version_number, kind, file_id, storage_path, mime_type, bytes)
        VALUES (source.document_id, source.version_number, source.kind, source.file_id,
                ${relativePath}, ${produced.mimeType}, ${produced.buffer.length});
    `.execute(db);

    await finish(queueId, QUEUE.DONE, null);
    return { claimed: true, outcome: 'rendered', kind };
  } catch (error) {
    const exhausted = Number(job.attempts) >= maxAttempts;
    await finish(queueId, exhausted ? QUEUE.FAILED : QUEUE.RETRYABLE, error.message);
    log[exhausted ? 'error' : 'warn']({ err: error, documentId: String(documentId) }, 'rendition failed');
    return { claimed: true, outcome: 'error' };
  }
}

/** @returns {Promise<{buffer: Buffer, mimeType: string, extension: string} | null>} */
async function buildThumbnail(absolutePath, filename) {
  const sharp = (await import('sharp')).default;

  if (IMAGE.test(filename)) {
    const buffer = await sharp(absolutePath, { limitInputPixels: SAFE_PIXELS })
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return { buffer, mimeType: 'image/webp', extension: 'webp' };
  }

  // A PDF must be rasterised first, and that needs Ghostscript.
  if (PDF.test(filename)) {
    const tools = await detectTools();
    if (!tools.ghostscript.available) return null;

    const png = await rasterisePdfFirstPage(absolutePath);

    const buffer = await sharp(png)
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return { buffer, mimeType: 'image/webp', extension: 'webp' };
  }

  // An Office file becomes a PDF first, then follows the PDF path.
  if (OFFICE.test(filename)) {
    const pdf = await convertToPdf(absolutePath);
    if (!pdf) return null;

    const workDir = path.dirname(pdf);
    try {
      const png = await rasterisePdfFirstPage(pdf);
      const buffer = await sharp(png)
        .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      return { buffer, mimeType: 'image/webp', extension: 'webp' };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return null;
}

/**
 * Every page of a multi-page scan, assembled into one PDF.
 *
 * sharp decodes the pages and pdf-lib binds them; both are already dependencies,
 * so this needs no external tool and cannot fail for the reason the Office path
 * fails — a missing LibreOffice on the host.
 *
 * Each page becomes a JPEG rather than PNG: these are photographs of paper, and
 * the lossless format triples the size of a rendition whose whole purpose is to
 * be quick to open. The page box is set to the image's own pixel size so the
 * viewer's "actual size" means what it says.
 */
async function scanToPdf(absolutePath, pages) {
  const sharp = (await import('sharp')).default;
  const { PDFDocument } = await import('pdf-lib');

  const wanted = Math.min(pages, MAX_PREVIEW_PAGES);
  if (pages > MAX_PREVIEW_PAGES) {
    // Loud, because the alternative is the silent truncation this whole change
    // exists to remove. The original is always downloadable in full.
    log.warn(
      { pages, rendered: wanted, limit: MAX_PREVIEW_PAGES },
      'scan has more pages than the preview limit; the rest are not rendered',
    );
  }

  const pdf = await PDFDocument.create();

  for (let page = 0; page < wanted; page += 1) {
    const jpeg = await sharp(absolutePath, { page, limitInputPixels: SAFE_PIXELS })
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    const embedded = await pdf.embedJpg(jpeg);
    const sheet = pdf.addPage([embedded.width, embedded.height]);
    sheet.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }

  return {
    buffer: Buffer.from(await pdf.save()),
    mimeType: 'application/pdf',
    extension: 'pdf',
  };
}

/**
 * A browser-viewable rendition, chosen by what the file actually is.
 *
 * ─── Which form, and why ───────────────────────────────────────────────
 *
 *   Office             → PDF. The browser's own viewer then supplies zoom,
 *                        rotate, page navigation and print, none of which this
 *                        application would otherwise have to build.
 *   multi-page scan    → PDF, for the same reason plus a larger one: it is the
 *                        only form that can carry more than one page.
 *   single-page scan   → WebP. One page needs no page navigation, and an image
 *                        is a fraction of the bytes of a one-page PDF.
 *   browser-native     → nothing. PNG, JPEG, GIF, WebP and PDF are served as
 *                        themselves; a rendition would be a second, worse copy
 *                        of a file already on disk.
 *
 * ─── Why multi-page TIFF stopped being an image ────────────────────────
 *
 * It used to become a single WebP of page one, because that is sharp's default
 * for a multi-page input. Every page after the first was then unreachable
 * anywhere in the application — not listed, not counted, not mentioned. A
 * two-page decision looked exactly like a one-page decision, and the reader had
 * no way to discover the difference existed. That is the worst kind of failure
 * this system can have: not an error, but a document quietly shown incomplete.
 */
async function buildPreview(absolutePath, filename) {
  if (IMAGE.test(filename) && !BROWSER_SAFE_IMAGE.test(filename)) {
    const sharp = (await import('sharp')).default;

    const meta = await sharp(absolutePath, { limitInputPixels: SAFE_PIXELS }).metadata();
    const pages = Number(meta.pages ?? 1);

    if (pages > 1) return scanToPdf(absolutePath, pages);

    const buffer = await sharp(absolutePath, { limitInputPixels: SAFE_PIXELS })
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    return { buffer, mimeType: 'image/webp', extension: 'webp' };
  }

  if (!OFFICE.test(filename)) return null;

  const pdf = await convertToPdf(absolutePath);
  if (!pdf) return null;

  const workDir = path.dirname(pdf);
  try {
    return { buffer: await readFile(pdf), mimeType: 'application/pdf', extension: 'pdf' };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** LibreOffice headless. Returns the produced PDF's path, or null. */
async function convertToPdf(absolutePath) {
  const tools = await detectTools();
  if (!tools.libreoffice.available) return null;

  const workDir = await mkdtemp(path.join(tmpdir(), 'dms-render-'));

  const result = await run(
    libreOffice(),
    [
      '--headless',
      // A fresh profile per run: two LibreOffice processes sharing one deadlock,
      // which presents as a hung conversion. Building it costs well under a
      // second — reusing a profile across runs was tried and measured no faster,
      // because startup was never the expensive part. See LIBREOFFICE_ENV.
      //
      // It lives under the OS temp directory because the path has to stay short.
      // LibreOffice builds a deep tree inside the profile and dies outright —
      // 0xC0000409, no message, no output file — once that crosses the Windows
      // 260-character limit.
      `-env:UserInstallation=file:///${workDir.replace(/\\/g, '/')}/profile`,
      '--convert-to',
      'pdf',
      '--outdir',
      workDir,
      absolutePath,
    ],
    { timeoutMs: config.renditions.timeoutMs, cwd: workDir, env: LIBREOFFICE_ENV },
  );

  // Returning null here would be a lie with consequences. The caller reads null
  // as "nothing can render this file type" and marks the job SKIPPED, which is
  // terminal — only PENDING and RETRYABLE are ever claimed again. So a
  // conversion that failed because the machine was briefly busy, or because
  // LibreOffice stalled on something, would be abandoned for good and recorded
  // as an unsupported format. Throwing routes it to the retry path instead, and
  // says what actually happened.
  if (result.timedOut) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`LibreOffice timed out after ${config.renditions.timeoutMs}ms`);
  }

  if (result.code !== 0) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`LibreOffice exited ${result.code}: ${result.stderr.slice(0, 300)}`);
  }

  const files = await readdir(workDir);
  const pdf = files.find((file) => file.toLowerCase().endsWith('.pdf'));
  if (!pdf) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('LibreOffice reported success but produced no PDF');
  }

  return path.join(workDir, pdf);
}

/**
 * Ghostscript, first page only. Returns PNG bytes.
 *
 * Throws rather than returning null for the same reason `convertToPdf` does: the
 * caller treats null as "this file type has no renderer" and gives up
 * permanently, which is the wrong answer for a timeout or a transient failure.
 */
async function rasterisePdfFirstPage(pdfPath) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'dms-raster-'));
  const output = path.join(workDir, 'page.png');

  try {
    const result = await run(
      config.renditions.ghostscriptPath,
      [
        '-dNOPAUSE', '-dBATCH', '-dQUIET',
        // Untrusted input: no PostScript from the file may touch the system.
        '-dSAFER',
        '-sDEVICE=png16m', '-r72',
        '-dFirstPage=1', '-dLastPage=1',
        `-sOutputFile=${output}`,
        pdfPath,
      ],
      { timeoutMs: config.renditions.timeoutMs },
    );

    if (result.timedOut) {
      throw new Error(`Ghostscript timed out after ${config.renditions.timeoutMs}ms`);
    }
    if (result.code !== 0) {
      throw new Error(`Ghostscript exited ${result.code}: ${result.stderr.slice(0, 300)}`);
    }

    return await readFile(output);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The queue entry for a version, if one was ever made.
 *
 * Exists so a caller can tell "not rendered yet" from "will never be rendered".
 * Without it the only observable state is the absence of a rendition, and the
 * only reasonable response to that is to queue the work — forever, for a file
 * type that has no renderer, because `enqueueRendition` resets a SKIPPED row
 * straight back to PENDING. One request an hour made that invisible; a preview
 * pane that asks as the user moves down the list does not.
 */
export async function getRenditionJob({ documentId, versionNumber, kind, fileId = null }) {
  const result = await sql`
    SELECT status, attempts, last_error FROM dbo.rendition_queue
     WHERE document_id = ${documentId} AND version_number = ${versionNumber} AND kind = ${kind}
       AND (file_id = ${fileId} OR (file_id IS NULL AND ${fileId} IS NULL))
  `.execute(db);

  const row = result.rows[0];
  return row
    ? { status: Number(row.status), attempts: Number(row.attempts), lastError: row.last_error }
    : null;
}

/** The stored rendition for a version, if one exists. */
export async function getRendition({ documentId, versionNumber, kind, fileId = null }) {
  const result = await sql`
    SELECT storage_path, mime_type, bytes FROM dbo.document_renditions
     WHERE document_id = ${documentId} AND version_number = ${versionNumber} AND kind = ${kind}
       AND (file_id = ${fileId} OR (file_id IS NULL AND ${fileId} IS NULL))
  `.execute(db);

  const row = result.rows[0];
  return row ? { storagePath: row.storage_path, mimeType: row.mime_type, bytes: Number(row.bytes) } : null;
}

/**
 * Re-queues finished renditions so they are built again by the current rules.
 *
 * ─── Why this has to exist ────────────────────────────────────────────
 *
 * A rendition is derived data that is nevertheless stored, so it records not
 * what the file is but what the renderer believed when it last ran. Change the
 * rules — as making multi-page scans into PDFs did — and every document rendered
 * under the old rules keeps showing the old answer for ever. Nothing expires
 * them and nothing notices they are stale.
 *
 * That is how a fix ships and does not arrive: the code is right, the tests
 * pass, and the one two-page document in the system still previews as one page
 * because its rendition was built last month. Rebuilding is the step that lets a
 * corrected renderer reach documents that already exist.
 *
 * Only the queue is touched. The existing rendition stays readable until its
 * replacement has been built and written, so a rebuild that fails or is
 * interrupted costs nothing.
 */
export async function rebuildRenditions({ kind = 'preview' } = {}) {
  const result = await sql`
    UPDATE q
       SET status = ${QUEUE.PENDING}, attempts = 0, last_error = NULL,
           queued_at = SYSUTCDATETIME(), finished_at = NULL
      OUTPUT INSERTED.document_id
      FROM dbo.rendition_queue q
      JOIN dbo.documents d ON d.document_id = q.document_id
     WHERE q.kind = ${kind}
       AND d.is_deleted = 0
  `.execute(db);

  const queued = result.rows.length;
  log.info({ kind, queued }, 'renditions queued for rebuild');
  return { kind, queued };
}

export async function drainQueue({ max = 20 } = {}) {
  let processed = 0;
  while (processed < max) {
    const result = await processOne();
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
}

export function startRenditionWorker() {
  if (!config.renditions.enabled) {
    log.info('rendition worker disabled');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await drainQueue({ max: 10 });
    } catch (error) {
      log.error({ err: error }, 'rendition loop error');
    } finally {
      if (!stopped) timer = setTimeout(tick, config.renditions.pollMs);
    }
  };

  timer = setTimeout(tick, config.renditions.pollMs);
  log.info('rendition worker started');
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
