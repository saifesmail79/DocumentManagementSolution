/**
 * QR stamping.
 *
 * ─── What the code points at ────────────────────────────────────────────────
 *
 * The document's URL in this system, not a share link. A printed contract that
 * carries a QR leading to an unauthenticated share would be a permanent public
 * link to a private document, sitting in a filing cabinet. Scanning this one
 * lands on the login page if you are not signed in, which is the correct
 * behaviour for a piece of paper that may end up anywhere.
 *
 * ─── The stored file is never modified ──────────────────────────────────────
 *
 * Stamping happens on the way out, per download. The stored bytes keep matching
 * the recorded SHA-256 — a stamped copy on disk would break every integrity
 * check and make the version's hash a lie.
 */

import { config } from '../../config/index.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('documents');

/** The URL a scan should land on. */
export function documentUrl(documentId) {
  return `${config.auth.resetLinkBase}/documents/${documentId}`;
}

/** A QR code as PNG bytes. */
export async function qrPng(documentId, { size = 256 } = {}) {
  const QRCode = (await import('qrcode')).default;

  return QRCode.toBuffer(documentUrl(documentId), {
    type: 'png',
    width: Math.min(Math.max(Number(size) || 256, 64), 1024),
    margin: 1,
    errorCorrectionLevel: 'M',
  });
}

/**
 * Returns a copy of a PDF with a QR code and caption stamped on every page.
 *
 * Returns null rather than throwing when the file cannot be parsed — a stamp is
 * a convenience, and failing the download of a slightly malformed PDF to add a
 * decoration would be the wrong trade.
 */
export async function stampPdf(buffer, { documentId, title }) {
  try {
    const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');

    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: false });
    const png = await pdf.embedPng(await qrPng(documentId, { size: 256 }));
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const box = 56;
    const margin = 18;

    for (const page of pdf.getPages()) {
      const { width } = page.getSize();

      // Bottom-left in PDF coordinates. Deliberately not the right-hand side:
      // an Arabic document's content runs to the right margin, and the left is
      // where a stamp is least likely to cover text.
      page.drawRectangle({
        x: margin - 4,
        y: margin - 4,
        width: box + 8,
        height: box + 20,
        color: rgb(1, 1, 1),
        opacity: 0.85,
      });

      page.drawImage(png, { x: margin, y: margin + 14, width: box, height: box });

      // The id, not the title: a title can be Arabic, and the standard PDF fonts
      // have no Arabic glyphs. Embedding one for a caption would add hundreds of
      // kilobytes to every stamped download.
      page.drawText(`DMS #${documentId}`, {
        x: margin,
        y: margin + 2,
        size: 7,
        font,
        color: rgb(0.35, 0.35, 0.35),
      });

      // Keeps the stamp off the page edge on very narrow pages.
      if (width < box + margin * 2) break;
    }

    return Buffer.from(await pdf.save());
  } catch (error) {
    log.warn({ err: error, documentId: String(documentId) }, 'could not stamp a QR code; serving unstamped');
    return null;
  }
}
