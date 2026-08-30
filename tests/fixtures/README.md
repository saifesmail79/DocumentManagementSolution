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

Clean synthetic print is the **easy** case. A real scan of a real page — skew,
speckle, a fold, a stamp over the text — reads worse. Treat the accuracy these
fixtures demonstrate as a ceiling, not as a typical result.
