/**
 * Text extraction, per format.
 *
 * ─── What this can and cannot do ────────────────────────────────────────────
 *
 * These read a document's EXISTING text layer. A scanned page has none — it is a
 * photograph of a page — so a scan extracts nothing and is reported as
 * `no_text_layer` rather than as a failure. That is the honest answer and it is
 * also the work list for OCR later: the documents that need it are exactly the
 * ones marked that way.
 *
 * Since most documents here arrive from a scanner, expect content search to
 * cover born-digital files (Word, Excel, exported PDFs) and not scans, until OCR
 * exists.
 *
 * ─── Untrusted input ────────────────────────────────────────────────────────
 *
 * Every byte reaching this file was uploaded by a user, and PDF parsers have a
 * long history of being an execution surface — the current pdfjs advisory is
 * literally "arbitrary JavaScript execution upon opening a malicious PDF". So:
 * eval is disabled explicitly, the built-in JS engine is off, no external
 * resources are fetched, and extraction is capped in both bytes and characters.
 */

import { readFile } from 'node:fs/promises';

import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('extraction');

/** Outcomes. `unsupported` and `no_text_layer` are normal, not errors. */
export const OUTCOME = Object.freeze({
  EXTRACTED: 'extracted',
  NO_TEXT_LAYER: 'no_text_layer',
  UNSUPPORTED: 'unsupported',
});

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const TEXT_EXTENSIONS = new Set(['.txt', '.csv', '.md', '.json', '.xml', '.html', '.htm', '.rtf']);

/**
 * A PDF whose text layer yields less than this is treated as having none.
 *
 * Not zero: a scanned PDF often carries a few stray characters — a header
 * stamped by the scanner, a page number — and indexing "1" as the entire content
 * of a 40-page contract is worse than indexing nothing, because it looks like
 * extraction succeeded.
 */
const MIN_MEANINGFUL_CHARS = 24;

function extensionOf(name) {
  const value = String(name ?? '').toLowerCase();
  const dot = value.lastIndexOf('.');
  return dot > 0 ? value.slice(dot) : '';
}

/**
 * Extracts text from one file.
 *
 * @param {string} absolutePath
 * @param {{filename?: string, mimeType?: string, maxChars?: number}} context
 * @returns {Promise<{outcome: string, text: string, detail?: string}>}
 */
export async function extractText(absolutePath, { filename, mimeType, maxChars = 2_000_000 } = {}) {
  const extension = extensionOf(filename) || extensionOf(absolutePath);
  const type = String(mimeType ?? '').toLowerCase();

  if (extension === '.pdf' || type === 'application/pdf') {
    return extractPdf(absolutePath, maxChars);
  }

  if (OFFICE_EXTENSIONS.has(extension) || type.includes('officedocument') || type.includes('opendocument')) {
    return extractOffice(absolutePath, maxChars);
  }

  if (TEXT_EXTENSIONS.has(extension) || type.startsWith('text/')) {
    return extractPlainText(absolutePath, maxChars);
  }

  // Images are the common case here and are genuinely unsupported until OCR.
  return { outcome: OUTCOME.UNSUPPORTED, text: '', detail: extension || type || 'unknown type' };
}

async function extractPdf(absolutePath, maxChars) {
  // Imported lazily so a process that never extracts a PDF does not pay to load
  // the parser, and so a broken install surfaces here rather than at boot.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(await readFile(absolutePath));

  const task = getDocument({
    data,
    // Hardening for untrusted input. isEvalSupported is the one that matters:
    // it is the setting behind the "arbitrary JavaScript execution" advisory
    // class, and nothing here needs it.
    isEvalSupported: false,
    // Documents can carry their own JavaScript. We are reading text, not
    // running a form.
    enableXfa: false,
    // Never reach out to the network for a font or an image while parsing a
    // file a user uploaded.
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  let pdf;
  try {
    pdf = await task.promise;

    const parts = [];
    let total = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      // items carry positioning; joining with spaces is enough for a search
      // index, which does not care about layout.
      const pageText = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');

      parts.push(pageText);
      total += pageText.length;

      // Release the page before moving on: a large PDF held page-by-page is how
      // an extraction worker ends up holding hundreds of megabytes.
      page.cleanup();

      if (total >= maxChars) break;
    }

    const text = parts.join('\n').slice(0, maxChars);

    if (text.trim().length < MIN_MEANINGFUL_CHARS) {
      return {
        outcome: OUTCOME.NO_TEXT_LAYER,
        text: '',
        detail: `${pdf.numPages} page(s), ${text.trim().length} characters of text`,
      };
    }

    return { outcome: OUTCOME.EXTRACTED, text };
  } finally {
    // Release through the LOADING TASK, not the document. PDFDocumentProxy has
    // no destroy() in pdfjs 6 — only cleanup(), which frees page resources but
    // leaves the worker running. Skipping this leaks a worker per document and
    // the process slowly stops responding.
    await task.destroy().catch(() => {});
  }
}

async function extractOffice(absolutePath, maxChars) {
  // officeparser 6 renamed parseOfficeAsync to parseOffice and changed what it
  // returns: a result object, not a string. Calling the old name threw
  // "parseOfficeAsync is not a function" on every Word and Excel upload, and the
  // job retried three times and gave up — so Office documents were stored,
  // listed, and never searchable.
  //
  // String(result) is NOT the fix. The object stringifies to "[object Object]",
  // which is long enough to look like a successful extraction and would have
  // indexed that literal text for every document.
  const { parseOffice } = await import('officeparser');

  const parsed = await parseOffice(absolutePath);
  const text = String(parsed.toText()).slice(0, maxChars);

  return text.trim().length < MIN_MEANINGFUL_CHARS
    ? { outcome: OUTCOME.NO_TEXT_LAYER, text: '', detail: 'document carried no readable text' }
    : { outcome: OUTCOME.EXTRACTED, text };
}

async function extractPlainText(absolutePath, maxChars) {
  const buffer = await readFile(absolutePath);

  // Strip a UTF-8 BOM: Windows tools write one, and left in place it becomes the
  // first character of the first indexed word.
  const text = buffer
    .toString('utf8')
    .replace(/^﻿/, '')
    .slice(0, maxChars);

  return text.trim().length === 0
    ? { outcome: OUTCOME.NO_TEXT_LAYER, text: '', detail: 'empty file' }
    : { outcome: OUTCOME.EXTRACTED, text };
}

export { log as extractionLog };
