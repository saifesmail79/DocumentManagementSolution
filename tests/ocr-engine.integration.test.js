/**
 * OCR against the real engines, on a real scan.
 *
 * ─── Why this file exists separately ────────────────────────────────────────
 *
 * `ocr.integration.test.js` substitutes `node` for Tesseract to exercise the
 * plumbing — spawning, stdout capture, timeouts, normalisation, indexing —
 * without needing anything installed. It deliberately proves nothing about
 * recognition, because a stub cannot.
 *
 * This file proves the other half: that Tesseract and OCRmyPDF are installed,
 * that they can actually read Arabic script, and that the language data is
 * reachable through our configuration rather than only from a shell.
 *
 * It skips when the tools are absent, so a checkout without them still passes.
 * A skip here is not a pass — it means the claim went unverified on this
 * machine.
 *
 * ─── The failure this is really guarding ────────────────────────────────────
 *
 * Every Tesseract installer ships English and omits Arabic. The engine then
 * reports itself present and healthy, and silently returns nothing for Arabic
 * pages: no error, no warning, just documents that are never findable. Both
 * halves — engine reachable AND `ara` reachable — have to be asserted, and
 * asserted through `config`, since the tessdata directory is deployment state.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Must precede any import of src/config, which reads process.env once and
// freezes. Everything else — binary paths, tessdata directory — comes from
// .env, so this asserts against the deployment's real configuration.
process.env.OCR_ENABLED = 'true';

/** Exactly the five lines rendered into the fixtures. See fixtures/README.md. */
const EXPECTED_LINES = [
  'عقد إيجار مبنى الإدارة',
  'الطرف الأول وزارة الاتصالات',
  'الطرف الثاني شركة النور للمقاولات',
  'قيمة العقد خمسة ملايين دينار',
  'تاريخ التوقيع الأول من شهر آب',
];

// Probed before the suite is declared: the skip reason should name what is
// missing, so a skipped run is diagnosable without opening this file.
const ocr = await import('../src/modules/extraction/ocr.js');
let status = await ocr.ocrStatus();

const missing = [];
if (!status.tesseract.available) missing.push('tesseract');
if (!status.ocrmypdf.available) missing.push('ocrmypdf');
if (status.tesseract.available && !status.arabicAvailable) {
  missing.push(`Arabic data (installed: ${status.installedLanguages.join(', ') || 'none'})`);
}

const SKIP = missing.length > 0 ? `OCR toolchain incomplete — missing ${missing.join(', ')}` : false;

/**
 * Character-level accuracy by Levenshtein distance.
 *
 * Word-level accuracy is the wrong measure for Arabic: a word is one connected
 * run of letters, so a single misread character fails the entire word and the
 * number badly understates a result that is perfectly usable for search.
 */
function accuracy(expected, actual) {
  const cols = actual.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i <= expected.length; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return 1 - previous[cols - 1] / Math.max(expected.length, 1);
}

/** Collapses whitespace runs, so line breaks and spacing do not count as errors. */
const flatten = (text) => text.replace(/\s+/g, ' ').trim();

/** The substring of `text` most similar to `target`, for per-line assertions. */
function closestRun(text, target) {
  let best = '';
  let bestScore = -1;

  // The sidecar is one flat string, so slide a window of the expected length
  // rather than assuming the engine preserved the original line breaks.
  for (let start = 0; start <= Math.max(0, text.length - target.length); start += 1) {
    const candidate = text.slice(start, start + target.length);
    const score = accuracy(target, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

describe('OCR engines (real Tesseract and OCRmyPDF)', { skip: SKIP }, () => {
  before(async () => {
    // force: detection is cached, and another suite in the same process may
    // already have probed a stub.
    await ocr.detectOcrTools({ force: true });
    status = await ocr.ocrStatus();
  });

  after(async () => {
    // Importing config opens no connection, but a sibling suite sharing the
    // process might have; closing is harmless either way.
    const { closeDatabase } = await import('../src/db/index.js');
    await closeDatabase().catch(() => {});
  });

  test('Arabic language data is reachable through the configured tessdata directory', () => {
    assert.ok(status.installedLanguages.includes('ara'), 'ara.traineddata must be installed');
    assert.equal(status.arabicAvailable, true);
    assert.ok(status.tesseract.version?.length > 0, 'the engine should report a version');
  });

  test('an Arabic page image is recognised accurately', async () => {
    const result = await ocr.attemptOcr(path.join(FIXTURES, 'arabic-scan.png'), {
      filename: 'arabic-scan.png',
      mimeType: 'image/png',
    });

    assert.equal(result.ok, true, `OCR failed: ${result.reason ?? ''}`);
    assert.equal(result.engine, 'tesseract');

    const score = accuracy(flatten(EXPECTED_LINES.join(' ')), flatten(result.text));

    // Clean synthetic print at 300 dpi is the easy case, so the bar is high.
    // A floor rather than an equality assertion: a Tesseract upgrade may shift
    // a character, and that is not a regression.
    assert.ok(
      score >= 0.95,
      `Arabic accuracy ${(score * 100).toFixed(1)}% — got: ${flatten(result.text)}`,
    );
  });

  test('every line of the page is recovered, not just the first', async () => {
    const result = await ocr.attemptOcr(path.join(FIXTURES, 'arabic-scan.png'), {
      filename: 'arabic-scan.png',
      mimeType: 'image/png',
    });

    const text = flatten(result.text);

    // A page-segmentation misconfiguration typically reads one line and stops,
    // which a whole-page score alone would partly absorb.
    for (const line of EXPECTED_LINES) {
      assert.ok(accuracy(line, closestRun(text, line)) >= 0.9, `line not recovered: ${line}`);
    }
  });

  /**
   * The path, not the image.
   *
   * Tesseract's CLI opens its input through Leptonica, which on Windows
   * converts the path to the machine's ANSI codepage first. Arabic does not
   * survive that conversion — every Arabic character arrived as a question
   * mark and the open failed with "cannot read input file ... Invalid
   * argument". Storage paths carry the document's title, so in an Arabic office
   * this was not an edge case: every scanned image failed, recorded only as
   * `ocr_failed`, indistinguishable from a corrupt file.
   *
   * The fixture is the same one the test above recognises at 95%+, so a failure
   * here can only be the path. Arabic-Indic digits are in the name deliberately
   * — they are equally unrepresentable, and a fix that special-cased letters
   * would pass without them.
   */
  test('an image whose path is Arabic is recognised, not refused', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'dms-ocr-path-'));
    // The shape sanitizeTitle produces: Arabic kept, spaces collapsed.
    const arabicPath = path.join(workDir, 'وثيقة_عربية_٢٣٥.png');

    try {
      await copyFile(path.join(FIXTURES, 'arabic-scan.png'), arabicPath);

      const result = await ocr.attemptOcr(arabicPath, {
        filename: 'وثيقة عربية ٢٣٥.png',
        mimeType: 'image/png',
      });

      assert.equal(
        result.ok,
        true,
        `OCR failed on an Arabic path: ${result.reason ?? ''} ${result.detail ?? ''}`,
      );

      const score = accuracy(flatten(EXPECTED_LINES.join(' ')), flatten(result.text));
      assert.ok(
        score >= 0.95,
        `Arabic path scored ${(score * 100).toFixed(1)}% — got: ${flatten(result.text)}`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * A scanned PDF — an image in a PDF container with no text layer — is the
   * shape most of an office's paper arrives in, and it takes the OCRmyPDF path
   * rather than the Tesseract one.
   */
  test('a scanned PDF is recognised through OCRmyPDF', async () => {
    const result = await ocr.attemptOcr(path.join(FIXTURES, 'arabic-scan.pdf'), {
      filename: 'arabic-scan.pdf',
      mimeType: 'application/pdf',
    });

    assert.equal(result.ok, true, `OCR failed: ${result.reason ?? ''}`);
    assert.equal(result.engine, 'ocrmypdf');

    const score = accuracy(flatten(EXPECTED_LINES.join(' ')), flatten(result.text));
    assert.ok(
      score >= 0.95,
      `Arabic accuracy ${(score * 100).toFixed(1)}% — got: ${flatten(result.text)}`,
    );
  });

  /**
   * A page fed upside down.
   *
   * This is the failure that prompted the whole check: a real scan came back as
   * 2,685 characters of mirrored nonsense — "physical" as "jeaisAyd", "Network"
   * as "JIO0MIaN" — and every status in the system said the document had been
   * OCR'd successfully. Plenty of characters were produced, so nothing looked
   * wrong anywhere.
   *
   * OCRmyPDF had in fact detected the page as facing down, with confidence
   * 11.28, and declined to rotate because its own default threshold is 14.
   */
  test('a page scanned upside down is corrected, not read as nonsense', async () => {
    const result = await ocr.attemptOcr(path.join(FIXTURES, 'arabic-scan-upside-down.pdf'), {
      filename: 'arabic-scan-upside-down.pdf',
      mimeType: 'application/pdf',
    });

    assert.equal(result.ok, true, `OCR failed: ${result.reason ?? ''}`);

    const score = accuracy(flatten(EXPECTED_LINES.join(' ')), flatten(result.text));
    assert.ok(
      score >= 0.9,
      `upside-down page scored ${(score * 100).toFixed(1)}% — got: ${flatten(result.text).slice(0, 160)}`,
    );
  });

  /**
   * OCRmyPDF spawns Tesseract itself, so our `--tessdata-dir` flag never
   * reaches it — the directory has to arrive as TESSDATA_PREFIX in the child
   * environment. It also resolves Ghostscript as the bare name `gs`, which a
   * per-user install is not, and reads its own config files from
   * `<tessdata>/configs`, which a directory holding only .traineddata lacks.
   *
   * All three were real failures during setup and all three present as either
   * "language data missing" or a bare non-zero exit. Recovering text at all
   * means every one of them is resolved.
   */
  test('the OCRmyPDF child environment carries tessdata, its configs, and Ghostscript', async () => {
    const result = await ocr.attemptOcr(path.join(FIXTURES, 'arabic-scan.pdf'), {
      filename: 'arabic-scan.pdf',
      mimeType: 'application/pdf',
    });

    assert.equal(result.ok, true, `OCR failed: ${result.reason ?? ''}`);
    assert.ok(result.text.includes('عقد'), 'the sidecar should carry recognised Arabic');
  });
});
