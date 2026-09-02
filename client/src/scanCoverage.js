/**
 * Detects a scan whose image is larger than the area the scanner actually read.
 *
 * ─── The fault this catches ─────────────────────────────────────────────────
 *
 * A three-page feeder scan came back as a perfectly valid 719 KB PDF in which
 * most of every page was black. The pages were 2592×4200 pixels labelled 300
 * dpi, but only the top-left 829×1344 pixels held the document — exactly 32.0%
 * of each dimension, which is 96/300. The scanner had read the sheet at 96 dpi
 * into a buffer sized for 300 and zero-filled the rest.
 *
 * Nothing anywhere objected. The bridge logged `dpi=300 … warnings=[]`, the PDF
 * was structurally sound, the upload succeeded, and the document was filed. The
 * only signal that something was wrong was a person looking at it.
 *
 * The proper fix belongs in the scanner bridge, which is the only component that
 * can ask the driver what resolution it truly applied. This is the seatbelt: it
 * does not care WHY the image is bigger than the scan, so it will still catch
 * the next driver that does something equally inventive.
 *
 * ─── Why it warns rather than blocks ────────────────────────────────────────
 *
 * A wide dark margin is overwhelming evidence of a bad scan and not quite proof
 * — a photograph on a black backing sheet, a page scanned deliberately off the
 * platen edge. Refusing the upload would make this code the final authority on
 * an image it has only measured very crudely. Naming what it found and letting
 * the person decide keeps that authority where it belongs.
 */

/** Below this, a sample counts as unexposed rather than as dark content. */
const LIT_THRESHOLD = 32;

/**
 * The fraction of each axis that must carry content before a page is accepted.
 *
 * Generous on purpose. A correct scan reaches its own edges — the observed
 * failure filled 32%, and a scan that genuinely stops at 85% is unusual enough
 * to be worth a sentence.
 */
const MIN_COVERAGE = 0.85;

/**
 * Measures how far content extends across a greyscale sample grid.
 *
 * Pure and synchronous, so the rule can be tested without a browser: decoding
 * an image is the caller's problem.
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} luma row-major grey samples, 0–255
 * @param {number} width  samples per row
 * @param {number} height rows
 * @returns {{coverageX: number, coverageY: number, blank: boolean, truncated: boolean}}
 */
export function measureCoverage(luma, width, height, { litThreshold = LIT_THRESHOLD, minCoverage = MIN_COVERAGE } = {}) {
  if (!width || !height) return { coverageX: 0, coverageY: 0, blank: true, truncated: false };

  let lastLitColumn = -1;
  let lastLitRow = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (luma[y * width + x] > litThreshold) {
        if (x > lastLitColumn) lastLitColumn = x;
        if (y > lastLitRow) lastLitRow = y;
      }
    }
  }

  // Nothing above the threshold anywhere: a wholly dark image. That is a
  // different fault from a dark margin — a closed lid, a failed exposure — and
  // calling it "truncated" would send someone looking for the wrong problem.
  if (lastLitColumn < 0) return { coverageX: 0, coverageY: 0, blank: true, truncated: false };

  const coverageX = (lastLitColumn + 1) / width;
  const coverageY = (lastLitRow + 1) / height;

  return {
    coverageX,
    coverageY,
    blank: false,
    // Either axis is enough. The observed fault shrank both, but an extent wrong
    // in one dimension only is just as broken and just as invisible.
    truncated: coverageX < minCoverage || coverageY < minCoverage,
  };
}

/**
 * Reduces an image to a small greyscale grid.
 *
 * Deliberately coarse. The question is "does content reach the edges", which a
 * thumbnail answers as well as full resolution and answers instantly — a 2592×
 * 4200 page is 10.9 million samples, and this is 4,096 of them.
 */
const GRID = 64;

/**
 * Measures one scanned page in the browser.
 *
 * @param {{mimeType: string, data: string}} page as returned by the bridge
 * @returns {Promise<{coverageX: number, coverageY: number, blank: boolean, truncated: boolean}|null>}
 *          null when the image cannot be measured, which is never treated as a fault
 */
export async function measurePage(page) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(`data:${page.mimeType};base64,${page.data}`)).blob());

    // OffscreenCanvas keeps this off the document and out of layout; it is
    // available everywhere this app runs, and the catch covers anywhere it is not.
    const canvas = new OffscreenCanvas(GRID, GRID);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, GRID, GRID);
    bitmap.close?.();

    const { data } = context.getImageData(0, 0, GRID, GRID);

    const luma = new Uint8Array(GRID * GRID);
    for (let i = 0; i < luma.length; i += 1) {
      // Rec. 601 luma. The scans are usually greyscale already, in which case
      // this is the identity, and it costs nothing to be right about colour ones.
      luma[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    }

    return measureCoverage(luma, GRID, GRID);
  } catch {
    // A page that cannot be decoded is not evidence of a bad scan. The upload
    // path is unaffected either way.
    return null;
  }
}

/**
 * Checks a scan for the fault, sampling the first few pages.
 *
 * Sampling is sound here because the cause is a misconfigured scan area, which
 * applies identically to every page of a run — all three pages of the observed
 * failure were truncated by exactly the same 32%. Measuring fifty pages to
 * re-confirm what the first three agree on only delays the warning.
 *
 * @returns {Promise<{truncated: boolean, blank: boolean, coverageX: number, coverageY: number, sampled: number}>}
 */
export async function inspectScan(pages, { sample = 3 } = {}) {
  const measured = (await Promise.all((pages ?? []).slice(0, sample).map(measurePage))).filter(Boolean);

  if (measured.length === 0) {
    return { truncated: false, blank: false, coverageX: 1, coverageY: 1, sampled: 0 };
  }

  // The worst page decides. One good page does not redeem a run.
  const worst = measured.reduce((a, b) =>
    Math.min(a.coverageX, a.coverageY) <= Math.min(b.coverageX, b.coverageY) ? a : b,
  );

  return { ...worst, sampled: measured.length };
}
