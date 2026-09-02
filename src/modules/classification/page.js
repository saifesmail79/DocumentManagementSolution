/**
 * Page one, as pixels and as words.
 *
 * ─── Every document is read the same way ────────────────────────────────────
 *
 * A fingerprint is only comparable with fingerprints made the same way, so
 * every document — a scanned PDF, a born-digital PDF, a TIFF from a feeder —
 * is rasterised to one grey image of its first page and that image is read
 * by Tesseract. A digital PDF's own text layer is deliberately not used: it
 * would give that document a cleaner fingerprint than its scanned twin and the
 * two would fail to match each other.
 *
 * ─── Tools ──────────────────────────────────────────────────────────────────
 *
 * Ghostscript rasterises PDFs (already required for thumbnails); sharp handles
 * images in-process; Tesseract reads the page and, asked for TSV, returns
 * every word with its box. OCRmyPDF is not involved: it produces text without
 * positions, and positions are what the header extractor works from.
 *
 * As in the OCR module, binaries are spawned with an argument array and no
 * shell, every run has a hard timeout, and the page image reaches Tesseract on
 * stdin — its CLI cannot open a path containing Arabic on Windows.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';
import { detectOcrTools, runCommand, SEGMENTATION_MODES } from '../extraction/ocr.js';
import { detectTools as detectRenditionTools } from '../renditions/service.js';
import {
  parseTsv,
  meaningfulCharacters,
  textFeatures,
  PAGE_THUMB,
  HEADER_THUMB,
  HEADER_FRACTION,
} from './features.js';
import { extractFields } from './extract.js';

const log = moduleLogger('classification');

const IMAGE = /\.(png|jpe?g|tiff?|bmp|webp|gif)$/i;
const PDF = /\.pdf$/i;

/** Decoding is bounded: an image claiming a billion pixels is refused, not attempted. */
const SAFE_PIXELS = 80_000_000;

/** Longest side of a page image handed to Tesseract. Beyond this, more pixels only cost time. */
const MAX_SIDE = 3600;

/** What kind of page a file yields, or null when it has no first page to read. */
export function pageKind(filename, mimeType) {
  const name = String(filename ?? '');
  const mime = String(mimeType ?? '');
  if (PDF.test(name) || mime.includes('pdf')) return 'pdf';
  if (IMAGE.test(name) || mime.startsWith('image/')) return 'image';
  return null;
}

/** Whether the tools this pipeline spawns are present. */
export async function classificationTools({ force = false } = {}) {
  const [ocr, render] = await Promise.all([detectOcrTools({ force }), detectRenditionTools({ force })]);
  return { tesseract: ocr.tesseract, ghostscript: render.ghostscript };
}

/** Ghostscript, first page, grey, at the configured resolution. */
async function rasterisePdf(pdfPath, pngPath) {
  const result = await runCommand(
    config.renditions.ghostscriptPath,
    [
      '-dNOPAUSE', '-dBATCH', '-dQUIET',
      // Untrusted input: no PostScript from the file may touch the system.
      '-dSAFER',
      '-sDEVICE=pnggray',
      `-r${config.classification.dpi}`,
      // Anti-aliased text rasterises closer to what a scanner produces than
      // hard-edged glyphs do, which is what the fingerprints will be compared to.
      '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
      '-dFirstPage=1', '-dLastPage=1',
      `-sOutputFile=${pngPath}`,
      pdfPath,
    ],
    { timeoutMs: config.classification.timeoutMs },
  );

  if (result.timedOut) throw new Error(`Ghostscript timed out after ${config.classification.timeoutMs}ms`);
  if (result.code !== 0) throw new Error(`Ghostscript exited ${result.code}: ${result.stderr.slice(0, 300)}`);
}

/** sharp: first frame, EXIF orientation applied, grey, bounded in size. */
async function rasteriseImage(imagePath, pngPath) {
  await sharp(imagePath, { page: 0, limitInputPixels: SAFE_PIXELS })
    .rotate()
    .grayscale()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(pngPath);
}

/** One Tesseract pass, TSV out. */
async function runTesseractTsv(pngPath, psm) {
  const result = await runCommand(
    config.ocr.tesseractPath,
    [
      '-',
      'stdout',
      '-l',
      config.ocr.languages,
      ...(config.ocr.tessdataDir ? ['--tessdata-dir', config.ocr.tessdataDir] : []),
      '--psm',
      psm,
      'tsv',
    ],
    { timeoutMs: config.classification.timeoutMs, input: pngPath },
  );

  if (result.timedOut) throw new Error(`OCR timed out after ${config.classification.timeoutMs}ms`);
  if (result.code !== 0) throw new Error(`tesseract exited ${result.code}: ${result.stderr.slice(0, 300)}`);
  return result.stdout;
}

/**
 * Reads the words off a page image, trying the segmentation modes in the
 * same order and for the same reasons as the OCR module: automatic with
 * orientation first, then the modes that survive a page the layout analysis
 * gives up on. The best pass by recognised characters wins.
 */
async function recogniseWords(pngPath) {
  let best = null;
  for (const psm of SEGMENTATION_MODES) {
    const parsed = parseTsv(await runTesseractTsv(pngPath, psm));
    const chars = meaningfulCharacters(parsed.words);
    if (!best || chars > best.chars) best = { psm, chars, ...parsed };
    if (best.chars >= config.ocr.minCharacters) break;
  }
  return best;
}

/** Collapses a multi-channel raw buffer to one grey byte per pixel. */
function toGrey(data, channels) {
  if (channels === 1) return data;
  const pixels = data.length / channels;
  const grey = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i += 1) {
    let sum = 0;
    for (let c = 0; c < Math.min(channels, 3); c += 1) sum += data[i * channels + c];
    grey[i] = Math.round(sum / Math.min(channels, 3));
  }
  return grey;
}

/** The two layout thumbnails, as base64 grey values. */
async function thumbnails(pngPath, { width, height }) {
  const source = sharp(pngPath, { limitInputPixels: SAFE_PIXELS }).grayscale();

  const page = await source
    .clone()
    .resize(PAGE_THUMB.width, PAGE_THUMB.height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const headerHeight = Math.max(1, Math.round(height * HEADER_FRACTION));
  const header = await source
    .clone()
    .extract({ left: 0, top: 0, width, height: headerHeight })
    .resize(HEADER_THUMB.width, HEADER_THUMB.height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    page: toGrey(page.data, page.info.channels).toString('base64'),
    header: toGrey(header.data, header.info.channels).toString('base64'),
  };
}

/**
 * Fingerprints one file's first page and reads its header.
 *
 * @param {string} absolutePath
 * @param {{kind: 'pdf'|'image'}} options
 * @returns {Promise<{page: {width: number, height: number}, psm: string, chars: number,
 *   words: object[], features: object, extracted: object}>}
 */
export async function fingerprintPage(absolutePath, { kind }) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'dms-classify-'));
  const pngPath = path.join(workDir, 'page.png');

  try {
    if (kind === 'pdf') await rasterisePdf(absolutePath, pngPath);
    else await rasteriseImage(absolutePath, pngPath);

    const meta = await sharp(pngPath, { limitInputPixels: SAFE_PIXELS }).metadata();
    const page = { width: meta.width, height: meta.height };

    const read = await recogniseWords(pngPath);
    // Tesseract reports the page size it saw; sharp's is the same image, and
    // is the fallback when a pass produced no page row at all.
    const dimensions = read.page.width > 0 ? read.page : page;

    const layout = await thumbnails(pngPath, page);
    const text = textFeatures(read.words, dimensions);
    const extracted = extractFields(read.words, dimensions);

    log.info(
      { kind, psm: read.psm, words: read.words.length, chars: read.chars, page: dimensions },
      'page fingerprinted',
    );

    return {
      page: dimensions,
      psm: read.psm,
      chars: read.chars,
      words: read.words,
      features: {
        text,
        layout,
        ocr: { psm: read.psm, words: read.words.length, chars: read.chars },
      },
      extracted,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
