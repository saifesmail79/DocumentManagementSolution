/**
 * Assembles scanned pages into one PDF, client-side.
 *
 * The result is an ordinary File, posted through the same upload endpoint a
 * user-picked file goes through — so permissions, size limits, hashing and the
 * durable write ordering all apply unchanged. The integration guide is explicit
 * that there must not be a separate scan-upload path, and that is the reason:
 * a second path is a second place for the permission check to be missing.
 *
 * pdf-lib is imported dynamically: it is roughly two thirds of the bundle and is
 * only ever needed after someone presses Scan, so a statically imported copy
 * would be paid for on every page load by every user, including the majority
 * whose machine has no scanner attached.
 */

import { pageToBytes } from './scanBridge.js';

/**
 * @param {Array<{mimeType: string, data: string, dpi: number}>} pages
 * @param {{title?: string}} [options]
 * @returns {Promise<File>}
 */
export async function pagesToPdfFile(pages, { title } = {}) {
  if (!pages?.length) throw new Error('no pages to assemble');

  const { PDFDocument } = await import('pdf-lib');

  const pdf = await PDFDocument.create();

  for (const page of pages) {
    const bytes = pageToBytes(page);
    const image =
      page.mimeType === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);

    // PDF units are points. Dividing the pixel dimensions by the scan DPI gives
    // the sheet's real physical size, so an A4 page prints as A4 rather than at
    // whatever size 2592 pixels happens to imply.
    const dpi = page.dpi > 0 ? page.dpi : 300;
    const width = (image.width * 72) / dpi;
    const height = (image.height * 72) / dpi;

    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  // The filename only supplies the extension and a fallback title; the real
  // title is sent as a form field.
  const name = title ? `${title}.pdf` : `scan-${stamp}.pdf`;

  return new File([await pdf.save()], name, { type: 'application/pdf' });
}
