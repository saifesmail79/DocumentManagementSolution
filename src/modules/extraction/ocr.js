/**
 * OCR, for documents that have no text layer.
 *
 * ─── Why external binaries rather than a library ────────────────────────────
 *
 * The engine choice was researched and is not open: Tesseract 5. The
 * alternatives were rejected on Arabic specifically — Surya's character error
 * rate is catastrophic on Arabic script, PaddleOCR emits left-to-right visual
 * order which destroys Arabic word order, and EasyOCR is materially worse than
 * Tesseract on Arabic print. Tesseract runs ~85-93% on clean modern Arabic
 * print, which is enough to make search work and nowhere near enough to be
 * shown to a user as the document's text.
 *
 * That last point is the rule this file exists under: OCR output feeds the
 * full-text index ONLY. It is never returned by an API, never rendered, never
 * presented as a transcription. A user who sees "٨٥%-accurate Arabic" as though
 * it were the document will act on words the machine invented.
 *
 * ─── Untrusted input, external process ──────────────────────────────────────
 *
 * These spawn binaries against user-uploaded files. Every invocation uses
 * spawn() with an argument array and no shell, so a filename can never become
 * part of a command line. Every invocation has a hard timeout and is killed on
 * expiry — an OCR run that hangs would otherwise hold a worker slot forever.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('ocr');

/** Extensions OCR can do something with. Everything else is genuinely unreadable. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);

/**
 * Page segmentation modes to try, in order, until one reads the page.
 *
 * ─── Why this is a list and not a setting ───────────────────────────────────
 *
 * 1 is automatic segmentation WITH orientation and script detection, and it
 * earns its place: a scan fed upside down is otherwise read as mirrored
 * nonsense that every status in the system reports as a success.
 *
 * But mode 1 has a failure mode of its own, and it is total. Its OSD stage
 * needs enough clean blobs to decide an orientation; when it cannot, it does
 * not fall back — it abandons the page and Tesseract prints nothing at all:
 *
 *   Too few characters. Skipping this page
 *   OSD: Weak margin (1.96) for 46 blob text block
 *
 * That is what happened to two photographs of an Iraqi residence card. Both
 * were perfectly legible to a person, and both produced ZERO characters at
 * mode 1 and again at mode 3 — while mode 6 read 379 and 31 characters of the
 * printed Arabic. The cards are small (693×468), and carry a stamp, a green
 * guilloche security pattern and handwriting over the printed lines, which is
 * plenty to defeat layout analysis without troubling a human reader at all.
 *
 * 6 — "assume a single uniform block of text" — skips both the orientation
 * stage and the layout analysis, which is exactly why it survives a page the
 * other two give up on. It cannot correct orientation, so it is the fallback
 * and never the first choice.
 *
 * 11 — "sparse text, in no particular order" — is last because it is the one
 * that stops assuming the page is a page at all. The back of that same card is
 * a stamp, a signature scrawled across everything, and a handful of short
 * printed labels stranded between them: mode 6 found 31 characters there and
 * mode 11 found 127, including نموذج, الرمز, تاريخ and اسم ورتبة. A form whose
 * printed text is scattered labels rather than paragraphs is common in exactly
 * the paperwork this system holds.
 *
 * Upscaling was measured and rejected: at 2x, 3x and 4x, with and without
 * greyscale, sharpening and contrast normalisation, nothing beat the original
 * image at mode 6. The resolution was never the problem — the segmentation was.
 */
export const SEGMENTATION_MODES = Object.freeze(['1', '6', '11']);

/**
 * How much of a string is actual text rather than punctuation and noise.
 *
 * Letters and digits by Unicode class, so Arabic counts: a blank page comes
 * back as a couple of dozen characters of whitespace and page separators, which
 * clears any length floor and is then recorded as a successful OCR.
 */
function meaningfulCharacters(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * Runs a command with an argument array and no shell.
 *
 * `input` is a path whose bytes are streamed to the child's stdin, for a tool
 * that can be handed its input rather than sent to fetch it. See ocrImage.
 *
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
function run(command, args, { timeoutMs = 60_000, cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell: false is the default and is load-bearing — a filename containing
      // a quote or a semicolon must never be parsed as shell syntax.
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      return reject(error);
    }

    if (input) {
      // A child that rejects its input closes stdin early, and one killed on
      // timeout closes it abruptly — both break the pipe mid-write. Neither is
      // an error of ours: the child reports what happened through its exit code
      // and stderr, which the caller is already reading. An unhandled EPIPE
      // here would instead crash the worker.
      child.stdin.on('error', () => {});

      const source = createReadStream(input);
      source.on('error', (error) => {
        // The file itself is unreadable — deleted, or permissions. Stop the
        // child rather than leaving it blocked on a stdin that will never end.
        child.kill('SIGKILL');
        reject(error);
      });
      source.pipe(child.stdin);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: Tesseract does not always honour a polite
      // signal mid-page, and a worker slot held by a wedged process is worse
      // than an abrupt kill of a job we are about to fail anyway.
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      // Bounded: a runaway process must not fill memory with its own output.
      if (stdout.length < 8_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/**
 * The environment OCRmyPDF needs, which is not the one it inherits.
 *
 * Two things have to be injected:
 *
 *   TESSDATA_PREFIX — OCRmyPDF shells out to Tesseract itself, so our
 *   `--tessdata-dir` flag never reaches it. Without this it refuses the job up
 *   front with "does not have language data for: ara", even though Tesseract
 *   run directly reads Arabic fine. Note that Tesseract 5 wants the directory
 *   holding the .traineddata files, not its parent — the pre-4.x convention.
 *
 *   PATH — OCRmyPDF resolves Ghostscript as the bare name `gs`. A per-user
 *   Ghostscript install is not on the machine PATH, and a Windows service gets
 *   the machine PATH rather than the installing user's, so the directory is
 *   prepended here instead of being assumed.
 */
function ocrChildEnv() {
  const env = { ...process.env };

  if (config.ocr.tessdataDir) env.TESSDATA_PREFIX = config.ocr.tessdataDir;

  const ghostscript = config.renditions.ghostscriptPath;
  if (ghostscript && path.isAbsolute(ghostscript)) {
    const binDir = path.dirname(ghostscript);
    // Windows env keys are case-insensitive but the object's are not, so reuse
    // whatever casing the real environment used rather than adding a second key
    // that the child would ignore.
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = env[key] ? `${binDir}${path.delimiter}${env[key]}` : binDir;
  }

  return env;
}

let detected = null;

/**
 * Probes for the OCR tools. Cached — the answer changes only when someone
 * installs something, which does not happen mid-process.
 */
export async function detectOcrTools({ force = false } = {}) {
  if (detected && !force) return detected;

  const probe = async (command) => {
    try {
      const result = await run(command, ['--version'], { timeoutMs: 10_000 });
      if (result.code !== 0) return { available: false };
      const version = (result.stdout || result.stderr).split('\n')[0]?.trim();
      return { available: true, version };
    } catch {
      // ENOENT: not installed, which is a normal state, not an error.
      return { available: false };
    }
  };

  const [tesseract, ocrmypdf] = await Promise.all([
    probe(config.ocr.tesseractPath),
    probe(config.ocr.ocrmypdfPath),
  ]);

  detected = { tesseract, ocrmypdf };
  return detected;
}

/**
 * True when anything can be OCR'd at all.
 *
 * `enabled` is a policy decision and arrives from the caller, defaulting to the
 * environment. It is deliberately not read from the settings table here: this
 * module is a thin adapter over two binaries, and giving it a database
 * dependency would make it unusable from a context that has none.
 */
export async function ocrAvailable({ enabled = config.ocr.enabled } = {}) {
  if (!enabled) return false;
  const tools = await detectOcrTools();
  return tools.tesseract.available;
}

/**
 * Reports what OCR can currently do, for a diagnostics screen.
 *
 * Worth surfacing because "why is search not finding my scans" has exactly one
 * answer most of the time, and it is this.
 */
export async function ocrStatus({ enabled = config.ocr.enabled } = {}) {
  const tools = await detectOcrTools({ force: true });
  const languages = await installedLanguages();

  return {
    enabled,
    tesseract: tools.tesseract,
    ocrmypdf: tools.ocrmypdf,
    configuredLanguages: config.ocr.languages,
    installedLanguages: languages,
    // The specific failure that produces silently empty Arabic OCR: the engine
    // is present but its Arabic training data is not.
    arabicAvailable: languages.includes('ara'),
  };
}

async function installedLanguages() {
  try {
    const result = await run(
      config.ocr.tesseractPath,
      [...(config.ocr.tessdataDir ? ['--tessdata-dir', config.ocr.tessdataDir] : []), '--list-langs'],
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0) return [];
    return (result.stdout || result.stderr)
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * OCRs an image file.
 *
 * `stdout` output, so nothing is written next to the user's document.
 *
 * ─── Why the image arrives on stdin rather than as a path ───────────────────
 *
 * Tesseract's CLI opens its input through Leptonica, which on Windows converts
 * the path down to the machine's ANSI codepage before calling fopen. Arabic has
 * no representation in CP1252, so every Arabic character in the path became a
 * question mark and the open failed:
 *
 *   Error, cannot read input file C:/dms-storage/2026/08/9_v1_?_?_?_-_235_??_...
 *
 * Storage paths carry the document's title — sanitizeTitle deliberately keeps
 * Arabic letters so files stay legible on disk — so in an Arabic office this is
 * not an edge case, it is most of the library. Every Arabic-titled image failed
 * with `ocr_failed` while looking, from the outside, like an unreadable file.
 *
 * `-` means "read the image from stdin", which never goes near the codepage.
 * That fixes the whole class rather than Arabic specifically: any title in any
 * script the server's ANSI codepage cannot express would have failed the same
 * way. It also avoids staging a copy, which would only have moved the problem
 * to whether the temporary directory's own path is representable — and on a
 * Windows box whose user account is named in Arabic, it is not.
 *
 * PDFs never had this bug: OCRmyPDF is Python, opens the file itself, and hands
 * Tesseract its own ASCII-named rasters.
 */
async function ocrImage(absolutePath) {
  let best = '';

  for (const psm of SEGMENTATION_MODES) {
    const text = await runTesseract(absolutePath, psm);
    if (meaningfulCharacters(text) > meaningfulCharacters(best)) best = text;

    // The first mode that reads the page wins, so an ordinary scan costs one
    // pass and only a page the layout analysis choked on pays for a second.
    if (meaningfulCharacters(best) >= config.ocr.minCharacters) break;
  }

  return best;
}

/** One Tesseract pass at one segmentation mode. */
async function runTesseract(absolutePath, psm) {
  const result = await run(
    config.ocr.tesseractPath,
    [
      '-',
      'stdout',
      '-l',
      config.ocr.languages,
      // Only when configured: passing an empty --tessdata-dir makes tesseract
      // look in the wrong place and report every language as missing.
      ...(config.ocr.tessdataDir ? ['--tessdata-dir', config.ocr.tessdataDir] : []),
      '--psm',
      psm,
    ],
    { timeoutMs: config.ocr.timeoutMs, input: absolutePath },
  );

  if (result.timedOut) throw new Error(`OCR timed out after ${config.ocr.timeoutMs}ms`);
  if (result.code !== 0) throw new Error(`tesseract exited ${result.code}: ${result.stderr.slice(0, 300)}`);

  return result.stdout;
}

/**
 * OCRs a PDF that has no text layer.
 *
 * OCRmyPDF does the whole job — rasterise, deskew, recognise — and `--sidecar`
 * writes the recognised text to a plain file, which is all that is wanted here.
 * The output PDF goes to a temporary directory and is discarded: the stored
 * document must stay exactly the bytes the user uploaded, because its SHA-256 is
 * recorded and verified. That is also why rotating and deskewing here is safe —
 * they change the copy being read, never the file being kept.
 */
async function ocrPdf(absolutePath) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'dms-ocr-'));
  const outputPdf = path.join(workDir, 'out.pdf');
  const sidecar = path.join(workDir, 'out.txt');

  try {
    const result = await run(
      config.ocr.ocrmypdfPath,
      [
        '--sidecar',
        sidecar,
        '--language',
        config.ocr.languages,
        // Pages that already carry text are left alone rather than failing the
        // run: a mixed PDF (scanned pages plus a digital cover sheet) is common.
        '--skip-text',
        // A page fed upside down reads as mirrored nonsense — "physical" comes
        // back as "jeaisAyd" — and nothing anywhere reports a problem, because
        // OCR did produce plenty of characters. OCRmyPDF can detect and correct
        // the orientation, but does nothing about it unless asked.
        '--rotate-pages',
        '--rotate-pages-threshold',
        String(config.ocr.rotateThreshold),
        // Feeders introduce a degree or two of skew, which costs accuracy on
        // Arabic far more than on Latin script.
        '--deskew',
        '--optimize',
        '0',
        '--output-type',
        'pdf',
        absolutePath,
        outputPdf,
      ],
      { timeoutMs: config.ocr.timeoutMs, cwd: workDir, env: ocrChildEnv() },
    );

    if (result.timedOut) throw new Error(`OCR timed out after ${config.ocr.timeoutMs}ms`);

    // OCRmyPDF uses exit code 6 for "already has text", which is a success for
    // our purposes — the sidecar still holds whatever it found.
    if (result.code !== 0 && result.code !== 6) {
      throw new Error(`ocrmypdf exited ${result.code}: ${result.stderr.slice(0, 300)}`);
    }

    return await readFile(sidecar, 'utf8').catch(() => '');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Attempts OCR on one file.
 *
 * @returns {Promise<{ok: true, text: string, engine: string} | {ok: false, reason: string}>}
 */
export async function attemptOcr(absolutePath, { filename, mimeType, enabled = config.ocr.enabled } = {}) {
  if (!enabled) return { ok: false, reason: 'ocr_disabled' };

  const tools = await detectOcrTools();
  if (!tools.tesseract.available) return { ok: false, reason: 'ocr_not_installed' };

  const name = String(filename ?? absolutePath).toLowerCase();
  const extension = name.slice(name.lastIndexOf('.'));
  const isPdf = extension === '.pdf' || String(mimeType ?? '').includes('pdf');
  const isImage = IMAGE_EXTENSIONS.has(extension) || String(mimeType ?? '').startsWith('image/');

  if (!isPdf && !isImage) return { ok: false, reason: 'not_ocrable' };

  // A PDF needs rasterising before Tesseract can see it, which is OCRmyPDF's
  // job. Without it, PDFs cannot be OCR'd even though images can — so say that
  // rather than failing obscurely.
  if (isPdf && !tools.ocrmypdf.available) return { ok: false, reason: 'ocrmypdf_not_installed' };

  const text = isPdf ? await ocrPdf(absolutePath) : await ocrImage(absolutePath);
  const trimmed = String(text ?? '').trim();

  // OCR that finds almost nothing has failed, whatever its exit code — a blank
  // page, a photograph of a wall, a document in a script the language data does
  // not cover. Indexing a handful of stray characters looks like success.
  //
  // The same measure the image path uses to decide whether a segmentation mode
  // read the page, so "not worth indexing" and "try the next mode" cannot drift
  // apart and leave a document rejected by one rule that the other accepted.
  const meaningful = meaningfulCharacters(trimmed);

  if (meaningful < config.ocr.minCharacters) {
    return { ok: false, reason: 'ocr_found_no_text', detail: `${meaningful} letters or digits` };
  }

  log.info(
    { engine: isPdf ? 'ocrmypdf' : 'tesseract', characters: trimmed.length, meaningful },
    'OCR produced text',
  );

  return {
    ok: true,
    text: trimmed.slice(0, config.ocr.maxChars),
    engine: isPdf ? 'ocrmypdf' : 'tesseract',
  };
}

/** Test seam: forget the cached probe. */
export function resetOcrDetection() {
  detected = null;
}

/*
 * Shared with the recognition pilot, which spawns the same engine for word
 * boxes rather than text. One runner, so the stdin delivery, the hard timeout
 * and the no-shell rule cannot drift between the two callers.
 */
export { run as runCommand };
