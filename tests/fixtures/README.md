# Test fixtures

## `arabic-scan.png`, `arabic-scan.pdf`

A page of Arabic prose as a **scan**: pixels, with no text layer. Nothing but
OCR can recover a word from either file.

They are not photographs of paper. They were manufactured so the expected text
is known exactly, which is what makes an accuracy assertion possible:

1. `arabic-scan-source.html` — five RTL lines, 22pt, generous leading.
2. LibreOffice headless converted it to PDF.
3. Ghostscript rasterised page 1 at **300 dpi** to `arabic-scan.png`, the
   resolution Tesseract's documentation asks for.
4. `img2pdf` wrapped that PNG back into `arabic-scan.pdf` — an image inside a
   PDF container, which is exactly what a scanner emits.

The expected text lives in `tests/ocr-engine.integration.test.js` beside the
assertions that use it. Regenerating these files means updating that constant.

## `arabic-scan.tiff`

`arabic-scan.png` re-encoded as LZW TIFF:

```
sharp('tests/fixtures/arabic-scan.png').tiff({ compression: 'lzw' })
  .toFile('tests/fixtures/arabic-scan.tiff')
```

It exists because TIFF is what a scanner emits and **no browser can display it**.
The preview rendition is the only thing that makes such a document readable in
the app rather than only downloadable, so it needs a test that runs on the real
format rather than on the PNG that happens to be convenient.

Clean synthetic print is the **easy** case. A real scan of a real page — skew,
speckle, a fold, a stamp over the text — reads worse. Treat the accuracy these
fixtures demonstrate as a ceiling, not as a typical result.

## `arabic-scan-2page.tiff`

A two-page TIFF, the shape a sheet-fed scanner produces from a two-sided page.

It exists because the single-page `arabic-scan.tiff` cannot tell the difference
between a renderer that keeps every page and one that keeps the first: sharp
reads page one by default, so a preview built from it looks correct either way.
This fixture is the one that fails when pages are dropped.

Built from `arabic-scan.pdf` duplicated to two pages and rasterised with
Ghostscript (`-sDEVICE=tiffg4 -r200`), so it carries no content the one-page
fixture does not already carry.

## `classify/letter-{1,2,3}.pdf`, `classify/memo-{1,2,3}.pdf`

Six one-page **scans** — image-only PDFs, no text layer — of two Arabic
layouts, for the document recognition pilot (`docs/CLASSIFICATION_PILOT.md`):

- **letter**: a centred three-line letterhead over a rule, then
  `العدد: … التاريخ: …` on one line, `إلى / … المحترمة`, `م/ …`, a body
  paragraph and a signature. Segoe UI.
- **memo**: a full-width ruled table with a shaded title cell `مذكرة داخلية`,
  then `الرقم / التاريخ`, `من / إلى` and `الموضوع` in its cells, then a body.
  Arial.

The three of each share their layout and differ in number, date, subject,
addressee and body, so a classifier has to learn the shape and not the words.
Made the same way as `arabic-scan.pdf`: HTML rendered to PDF by LibreOffice
headless, then `gs -sDEVICE=pdfimage8 -r300` to strip it back to pixels. The
generating script is not kept; the layouts above are enough to remake them.

What Tesseract makes of them is recorded in
`tests/classification.integration.test.js`: subjects and addressees are read
on all six; the memos' Western-style numerals (`٥٥`, `٩١`) are read; the
letters' Arabic-Indic numerals in Segoe UI come back as Latin letters. Keep
that in mind before treating a header-field number from these fixtures as a
ceiling or a floor — real scans in the customer's own fonts decide it.
