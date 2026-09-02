/**
 * The scan-coverage rule.
 *
 * ─── What this is guarding ──────────────────────────────────────────────────
 *
 * A three-page feeder scan produced a valid 719 KB PDF in which most of every
 * page was black. Each page was 2592×4200 pixels labelled 300 dpi, but only the
 * top-left 829×1344 held the document — exactly 32.0% of each axis, which is
 * 96/300. Nothing in the chain objected: the bridge logged `dpi=300 …
 * warnings=[]`, the PDF was structurally sound, the upload succeeded.
 *
 * The numbers below are taken from that file, so this fails if the rule stops
 * recognising the case it was written for.
 *
 * The measurement is a pure function over a greyscale grid precisely so it can
 * be tested here — there is no client test runner in this project, and a check
 * that needed a browser would not be run at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { measureCoverage } from '../client/src/scanCoverage.js';

const GRID = 64;

/**
 * A page whose content fills the given fraction of each axis; the rest is black.
 *
 * `value` is the brightness of the content area — scans are paper, so bright by
 * default, but it is a parameter because a dark photograph must not be mistaken
 * for a truncated page.
 */
function page(fractionX, fractionY, { value = 230, size = GRID } = {}) {
  const luma = new Uint8Array(size * size); // 0 = black everywhere to begin with
  const lastX = Math.round(fractionX * size);
  const lastY = Math.round(fractionY * size);

  for (let y = 0; y < lastY; y += 1) {
    for (let x = 0; x < lastX; x += 1) luma[y * size + x] = value;
  }
  return luma;
}

describe('scan coverage', () => {
  /** The observed failure: 829/2592 and 1344/4200, both 32%. */
  test('the real 96-dpi-into-a-300-dpi-buffer scan is caught', () => {
    const result = measureCoverage(page(829 / 2592, 1344 / 4200), GRID, GRID);

    assert.equal(result.truncated, true, 'a page two thirds black was accepted');
    assert.equal(result.blank, false, 'it has content, so it is not a blank page');
    assert.ok(result.coverageX < 0.35, `coverageX ${result.coverageX}`);
    assert.ok(result.coverageY < 0.35, `coverageY ${result.coverageY}`);
  });

  test('a scan that reaches its own edges is accepted', () => {
    const result = measureCoverage(page(1, 1), GRID, GRID);

    assert.equal(result.truncated, false);
    assert.equal(result.blank, false);
  });

  /**
   * A correct scan does not end at a perfect edge — there is a shadow at the
   * lead edge, a dark strip where the sheet ended. The threshold has to leave
   * room for that or every scan would be reported as broken.
   */
  test('an ordinary narrow dark edge is not a fault', () => {
    const result = measureCoverage(page(0.97, 0.98), GRID, GRID);
    assert.equal(result.truncated, false);
  });

  /**
   * Both axes matter independently. An extent wrong in one dimension only is
   * just as broken, and just as invisible, as one wrong in both.
   */
  test('a page truncated in one axis only is still caught', () => {
    assert.equal(measureCoverage(page(0.32, 1), GRID, GRID).truncated, true, 'narrow');
    assert.equal(measureCoverage(page(1, 0.32), GRID, GRID).truncated, true, 'short');
  });

  /**
   * A wholly dark image is a different fault — a closed lid, a failed exposure,
   * a blank sheet — with a different remedy. Reporting it as a wrong scan area
   * would send someone to fix a setting that is not wrong.
   */
  test('an entirely black page reads as blank, not as truncated', () => {
    const result = measureCoverage(new Uint8Array(GRID * GRID), GRID, GRID);

    assert.equal(result.blank, true);
    assert.equal(result.truncated, false, 'blank and truncated are different problems');
  });

  /**
   * The threshold is about exposure, not about the subject. A dark photograph
   * that covers the whole sheet is a normal thing to scan.
   */
  test('a dark but fully covered page is not reported', () => {
    // Above the lit threshold but far from white — a dense photograph.
    const result = measureCoverage(page(1, 1, { value: 60 }), GRID, GRID);
    assert.equal(result.truncated, false);
  });

  test('an empty grid is handled rather than throwing', () => {
    const result = measureCoverage(new Uint8Array(0), 0, 0);
    assert.equal(result.blank, true);
    assert.equal(result.truncated, false);
  });
});
