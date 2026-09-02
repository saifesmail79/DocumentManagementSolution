/**
 * The recognition pilot's pure half: fingerprints, neighbours, decisions,
 * and header extraction — on synthetic words, with nothing installed.
 *
 * `classification.integration.test.js` runs the real engines on real scans.
 * These tests pin the rules those scans are judged by: what counts as a
 * label, where a value is looked for, when a date is trusted, how neighbours
 * vote. A rule that changes here changes the numbers on the pilot screen, so
 * each one is stated as a test rather than left implicit in the code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseTsv,
  tokenize,
  textFeatures,
  buildIndex,
  vectorize,
  nearest,
  decide,
  evaluateIndex,
  automationCurve,
  PAGE_THUMB,
  HEADER_THUMB,
  THRESHOLDS,
} = await import('../src/modules/classification/features.js');

const { extractFields, parseDate, parseNumber } = await import('../src/modules/classification/extract.js');

const PAGE = { width: 2480, height: 3508 };

/** One recognised word. */
function word(text, left, top, { width = 120, height = 40, block = 1, par = 1, line = 1, word: index = 1, conf = 90 } = {}) {
  return { text, conf, left, top, width, height, block, par, line, word: index };
}

/** A line of words in reading order — right to left — starting at `right`. */
function rtlLine(texts, { top, right = 2200, block = 1, par = 1, line = 1, conf = 90, width = 150, gap = 20 }) {
  let x = right;
  return texts.map((text, i) => {
    x -= width;
    const w = word(text, x, top, { width, block, par, line, word: i + 1, conf });
    x -= gap;
    return w;
  });
}

/** A thumbnail as base64 grey values: white, with `paint(x, y)` (0–1 coordinates) painted black. */
function thumb({ width, height }, paint) {
  const bytes = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (paint(x / width, y / height)) bytes[y * width + x] = 0;
    }
  }
  return bytes.toString('base64');
}

describe('Tesseract TSV', () => {
  test('words with boxes come out, and the page size comes from the page row', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t2480\t3508\t-1\t',
      '2\t1\t1\t0\t0\t0\t936\t149\t1296\t999\t-1\t',
      '5\t1\t1\t1\t1\t1\t2094\t158\t138\t60\t92.68\tعقد',
      '5\t1\t1\t1\t1\t2\t1898\t149\t164\t91\t90.22\tإيجار',
      '5\t1\t1\t1\t1\t3\t1700\t150\t50\t50\t95\t ',
    ].join('\n');

    const parsed = parseTsv(tsv);
    assert.deepEqual(parsed.page, { width: 2480, height: 3508 });
    assert.equal(parsed.words.length, 2, 'a blank word is not a word');
    assert.equal(parsed.words[0].text, 'عقد');
    assert.equal(parsed.words[0].left, 2094);
    assert.equal(parsed.words[1].conf, 90.22);
    assert.equal(parsed.words[1].word, 2);
  });
});

describe('text fingerprint', () => {
  test('tokens are normalised and short ones dropped', () => {
    assert.deepEqual(tokenize('وَزارَة الاتّصالات ٢٠٢٦ و!'), ['وزاره', 'الاتصالات', '2026']);
  });

  test('header words count double and numbers collapse to one token', () => {
    const words = [
      ...rtlLine(['وزارة'], { top: 200 }),
      ...rtlLine(['وزارة', '١٢٣٤'], { top: 3000, block: 2 }),
    ];
    const features = textFeatures(words, PAGE);
    assert.equal(features['w:وزاره'], 3, 'once in the header (×2) and once in the body (×1)');
    assert.equal(features['#'], 1);
    assert.equal(features['w:1234'], undefined, 'a document number is not a feature');
    assert.ok(features['c:_وز'] >= 3, 'character trigrams are counted too');
  });
});

describe('neighbours and decisions', () => {
  const letterLayout = {
    headerThumb: thumb(HEADER_THUMB, (x, y) => y < 0.5 && x > 0.3 && x < 0.7),
    pageThumb: thumb(PAGE_THUMB, (x, y) => y < 0.15 && x > 0.3 && x < 0.7),
  };
  const memoLayout = {
    headerThumb: thumb(HEADER_THUMB, (x, y) => y < 0.1 || y > 0.9 || x < 0.05 || x > 0.95),
    pageThumb: thumb(PAGE_THUMB, (x, y) => y < 0.3 && (y < 0.03 || x < 0.05 || x > 0.95)),
  };
  const blankLayout = { headerThumb: thumb(HEADER_THUMB, () => false), pageThumb: thumb(PAGE_THUMB, () => false) };

  const sample = (id, typeId, text, layout) => ({
    id,
    typeId,
    text: textFeatures(rtlLine(text.split(' '), { top: 200 }), PAGE),
    ...layout,
  });

  const samples = [
    sample('l1', 1, 'جمهورية العراق وزارة الاتصالات العدد التاريخ الموضوع طلب تزويد', letterLayout),
    sample('l2', 1, 'جمهورية العراق وزارة الاتصالات العدد التاريخ الموضوع ترشيح موظفين', letterLayout),
    sample('l3', 1, 'جمهورية العراق وزارة الاتصالات العدد التاريخ الموضوع اعادة تأهيل', letterLayout),
    sample('m1', 2, 'مذكرة داخلية الرقم التاريخ من الى الموضوع عطل الطابعة', memoLayout),
    sample('m2', 2, 'مذكرة داخلية الرقم التاريخ من الى الموضوع رفوف المخزن', memoLayout),
    sample('m3', 2, 'مذكرة داخلية الرقم التاريخ من الى الموضوع مستندات صرف', memoLayout),
  ];
  const index = buildIndex(samples);

  test('a new letter lands next to the letters and is decided automatically', () => {
    const target = vectorize(
      sample('new', null, 'جمهورية العراق وزارة الاتصالات العدد التاريخ الموضوع دعوة اجتماع', letterLayout),
      index.vocabulary,
    );
    const neighbours = nearest(index, target);
    assert.equal(neighbours[0].entry.typeId, 1);
    assert.ok(neighbours[0].combined > 0.5, `closest letter scored ${neighbours[0].combined}`);

    const verdict = decide(neighbours);
    assert.equal(verdict.typeId, 1);
    assert.equal(verdict.decision, 'auto');
    assert.equal(verdict.confidence, 1);
  });

  test('a page like nothing in the set is unknown, not guessed', () => {
    const target = vectorize(sample('odd', null, 'كلمات لا تشبه شيئا هنا ابدا', blankLayout), index.vocabulary);
    const verdict = decide(nearest(index, target));
    assert.equal(verdict.decision, 'unknown');
    assert.equal(verdict.typeId, null);
  });

  test('untyped samples never vote', () => {
    const withUntyped = buildIndex([...samples, sample('u1', null, 'جمهورية العراق وزارة الاتصالات', letterLayout)]);
    const target = vectorize(sample('new', null, 'جمهورية العراق وزارة الاتصالات العدد', letterLayout), withUntyped.vocabulary);
    assert.ok(nearest(withUntyped, target).every((n) => n.entry.typeId !== null));
  });

  test('distant neighbours do not dilute a clear vote', () => {
    const at = (typeId, combined) => ({ entry: { id: `${typeId}-${combined}`, typeId }, combined, text: 0, header: 0, page: 0 });
    // The fixture case: two right answers at 0.63, three wrong ones at ~0.2.
    const clear = decide([at(1, 0.63), at(1, 0.62), at(2, 0.24), at(2, 0.21), at(2, 0.18)]);
    assert.equal(clear.decision, 'auto');
    assert.equal(clear.confidence, 1);
    assert.equal(clear.votes.length, 1, 'the far neighbours were not in the running');

    // Genuinely split: both types close, so a person decides.
    const split = decide([at(1, 0.6), at(2, 0.58), at(1, 0.5)]);
    assert.equal(split.decision, 'review');
    assert.ok(split.confidence < THRESHOLDS.autoConfidence);

    // Close agreement that is nonetheless far from everything: review, not auto.
    const weak = decide([at(1, 0.45), at(1, 0.44)]);
    assert.equal(weak.decision, 'review');
    assert.equal(weak.confidence, 1);
  });

  test('leave-one-out over the set predicts every sample from the others', () => {
    const evaluation = evaluateIndex(index);
    assert.equal(evaluation.evaluated, 6);
    assert.ok(evaluation.results.every((r) => r.correct), JSON.stringify(evaluation.results));
    assert.ok(evaluation.results.every((r) => r.closest.id !== r.id), 'a sample must not be its own neighbour');

    const curve = automationCurve(evaluation.results);
    const policy = curve.find((row) => row.policy);
    assert.equal(policy.automated, 6);
    assert.equal(policy.precision, 1);
    assert.equal(curve.filter((row) => !row.policy).length, 7);
  });
});

describe('header extraction', () => {
  test('reads the four fields off an official letter', () => {
    const words = [
      ...rtlLine(['جمهورية', 'العراق'], { top: 150, right: 1600, block: 1 }),
      ...rtlLine(['العدد:', '١٢٣٤/٥/٧'], { top: 400, right: 2300, block: 2 }),
      ...rtlLine(['التاريخ:', '١٥/٣/٢٠٢٦'], { top: 400, right: 1100, block: 3 }),
      ...rtlLine(['إلى', '/', 'مديرية', 'الشؤون', 'المالية', 'المحترمة'], { top: 600, block: 4 }),
      ...rtlLine(['م/', 'طلب', 'تزويد', 'المديرية'], { top: 700, block: 5 }),
      ...rtlLine(['بالإشارة', 'إلى', 'كتابكم', 'رقم', '٩٨٧'], { top: 900, block: 6 }),
    ];

    const fields = extractFields(words, PAGE);

    assert.equal(fields.number.value, '1234/5/7');
    assert.equal(fields.number.validated, true);
    assert.equal(fields.number.anchor, 'العدد:');
    assert.equal(fields.number.source, 'line');

    assert.equal(fields.date.iso, '2026-03-15');
    assert.equal(fields.date.calendar, 'gregorian');
    assert.equal(fields.date.validated, true);

    assert.equal(fields.addressee.value, 'مديرية الشؤون المالية', 'the honorific is cut and the slash skipped');
    assert.equal(fields.subject.value, 'طلب تزويد المديرية');

    for (const field of Object.values(fields)) {
      assert.ok(field.confidence > 0 && field.confidence <= 1);
      assert.equal(field.inHeader, true);
    }
  });

  test('a form puts the label in one cell and the value in the next', () => {
    const words = [
      ...rtlLine(['الرقم'], { top: 300, right: 2300, block: 1 }),
      ...rtlLine(['٥٥'], { top: 300, right: 1900, block: 2 }),
      ...rtlLine(['التاريخ'], { top: 300, right: 1300, block: 3 }),
      ...rtlLine(['٢٠٢٦/٣/١٥'], { top: 300, right: 900, block: 4 }),
    ];

    const fields = extractFields(words, PAGE);
    assert.equal(fields.number.value, '55');
    assert.equal(fields.number.source, 'row');
    assert.equal(fields.date.iso, '2026-03-15');
    assert.equal(fields.date.source, 'row');
  });

  test('a label alone on its line takes the line beneath, and stops at the gap', () => {
    const words = [
      ...rtlLine(['الموضوع:'], { top: 500, block: 1, line: 1 }),
      ...rtlLine(['عطل', 'في', 'الطابعة'], { top: 560, block: 1, line: 2 }),
      ...rtlLine(['تحية', 'طيبة'], { top: 700, block: 2, line: 1 }),
    ];

    const fields = extractFields(words, PAGE);
    assert.equal(fields.subject.value, 'عطل في الطابعة');
    assert.equal(fields.subject.source, 'below');
  });

  test('a colon makes a label even in the middle of a line', () => {
    const fields = extractFields(rtlLine(['من:', 'قسم', 'التدقيق', 'إلى:', 'قسم', 'الحسابات'], { top: 300 }), PAGE);
    assert.equal(fields.addressee.value, 'قسم الحسابات');
  });

  test('"إلى" inside body text is not an addressee', () => {
    const fields = extractFields(rtlLine(['بالإشارة', 'إلى', 'كتابكم', 'المرقم'], { top: 1500 }), PAGE);
    assert.equal(fields.addressee, null);
  });

  test('a value that fails its check is kept, marked, and halved', () => {
    const fields = extractFields(rtlLine(['التاريخ:', 'TVI/IPAT'], { top: 300 }), PAGE);
    assert.equal(fields.date.value, 'TVI/IPAT');
    assert.equal(fields.date.validated, false);
    assert.ok(fields.date.confidence <= 0.5);

    const noDigits = extractFields(rtlLine(['العدد:', 'غير', 'مقروء'], { top: 300 }), PAGE);
    assert.equal(noDigits.number, null, 'a number without digits is no number at all');
  });

  test('a Hijri date is recognised and not converted', () => {
    const fields = extractFields(rtlLine(['التاريخ:', '١٥/٣/١٤٤٧', 'هـ'], { top: 300 }), PAGE);
    assert.equal(fields.date.calendar, 'hijri');
    assert.equal(fields.date.hijri, '1447-03-15');
    assert.equal(fields.date.iso, null);
    assert.equal(fields.date.validated, true);
  });

  test('nothing is invented when the labels are absent', () => {
    const fields = extractFields(rtlLine(['نص', 'عادي', 'بلا', 'تسميات'], { top: 300 }), PAGE);
    assert.deepEqual(fields, { number: null, date: null, subject: null, addressee: null });
    assert.deepEqual(extractFields([], PAGE), { number: null, date: null, subject: null, addressee: null });
  });
});

describe('parsers', () => {
  test('numbers: the longest digit run, separators and a short prefix kept', () => {
    assert.equal(parseNumber('العدد: ١٢٣٤/٥/٧ لسنة'), '1234/5/7');
    assert.equal(parseNumber('ص/1234'), 'ص/1234');
    assert.equal(parseNumber('لا أرقام هنا'), null);
  });

  test('dates: numeric in either order, named months, both calendars', () => {
    assert.equal(parseDate('١٥/٣/٢٠٢٦').iso, '2026-03-15');
    assert.equal(parseDate('2026-03-15').iso, '2026-03-15');
    assert.equal(parseDate('15 آذار 2026').iso, '2026-03-15');
    assert.equal(parseDate('15 مارس 2026').iso, '2026-03-15');
    assert.equal(parseDate('١٥/٣/١٤٤٧').calendar, 'hijri');
    assert.equal(parseDate('12 شعبان 1447').hijri, '1447-08-12');
    assert.equal(parseDate('31/2/2026').valid, false, 'a date that does not exist is not a date');
    assert.equal(parseDate('99/99/9999').valid, false);
    assert.equal(parseDate('الأول من شهر آب'), null);
  });
});
