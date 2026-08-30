# External toolchain

Four external programs give the system OCR and previews. **None of them is
required to run.** Without them the application starts, uploads work, and search
works on files that already carry a text layer; scanned pages simply stay
unsearchable and Office files simply have no preview.

| tool | what stops working without it |
|---|---|
| Tesseract 5 | OCR of scanned **images** (png, jpg, tiff…) |
| OCRmyPDF | OCR of scanned **PDFs** — needs Tesseract and Ghostscript |
| Ghostscript | thumbnails of PDFs, and OCRmyPDF |
| LibreOffice | Office previews, and Office thumbnails |

Image thumbnails need nothing installed — `sharp` is bundled.

Verify an install by running the real-engine suites, which skip with a message
naming exactly what is missing rather than passing quietly:

```
node --test tests/ocr-engine.integration.test.js tests/renditions.integration.test.js
```

---

## Every trap in this document fails silently

That is the point of writing it down. Each item below was hit during setup, and
not one produced an error message. The system reported itself healthy and simply
did less than it claimed.

---

## 1. Tesseract

Install the UB Mannheim build to the default location, then set:

```
OCR_ENABLED=true
OCR_LANGUAGES=ara+eng
OCR_TESSERACT_PATH=C:\Program Files\Tesseract-OCR\tesseract.exe
```

Use absolute paths, not bare names. A Windows service inherits the *machine*
PATH, not the PATH of whoever installed the tool.

### The installer does not include Arabic

It ships `eng` and `osd` only. With Arabic missing, Tesseract still reports
itself present and healthy, and returns **empty text** for every Arabic page —
no error, no warning, just documents that are never findable.

Download `ara.traineddata` from
[tessdata_best](https://github.com/tesseract-ocr/tessdata_best) and place it
beside the others. If you cannot write to `Program Files`, put it anywhere and
point at that directory:

```
OCR_TESSDATA_DIR=C:\path\to\tessdata
```

### A directory of language files is not a tessdata directory

Tesseract also reads *config* files from `<tessdata>/configs`. OCRmyPDF asks for
the `hocr` config and dies with `read_params_file: Can't open hocr` if it is not
there. A custom `OCR_TESSDATA_DIR` must therefore also contain, copied from the
installed `tessdata`:

```
configs\        tessconfigs\        pdf.ttf
```

Confirm with `tesseract --list-langs --tessdata-dir <dir>` — it must list `ara`.
The admin extraction status screen reports the same thing.

### It cannot open a file whose path is Arabic

Tesseract's CLI opens its input through Leptonica, which on Windows converts the
path to the machine's **ANSI codepage** before calling `fopen`. Arabic has no
representation in CP1252, so the path arrives full of question marks and the open
fails:

```
Error, cannot read input file C:/dms-storage/2026/08/9_v1_?_?_?_-_235_??_8-3-2026.tif: Invalid argument
```

This is not an edge case here. Storage paths carry the document's title, and
`sanitizeTitle` deliberately keeps Arabic so files stay legible on disk — so in
an Arabic office *every scanned image* failed, recorded as a bare `ocr_failed`
and indistinguishable from a corrupt file.

`ocrImage` therefore passes `-` and streams the image to Tesseract's **stdin**,
which never touches the codepage. Staging an ASCII-named copy would have worked
too, but only until the temp directory itself sat under an Arabic user profile.

PDFs were never affected: OCRmyPDF is Python, opens the file itself, and hands
Tesseract its own ASCII-named rasters.

---

## 2. OCRmyPDF

```
pip install --user ocrmypdf
OCR_OCRMYPDF_PATH=%APPDATA%\Python\Python3xx\Scripts\ocrmypdf.exe
```

OCRmyPDF spawns Tesseract itself, so `--tessdata-dir` never reaches it, and it
resolves Ghostscript as the bare name `gs`. The application supplies both in the
child environment (`TESSDATA_PREFIX`, plus Ghostscript's directory prepended to
`PATH`), so neither needs to be on the machine PATH.

`TESSDATA_PREFIX` must point at the directory *holding* the `.traineddata`
files. Tesseract 5 changed this — before 4.x it was the parent directory, and
most advice online still says so.

---

## 3. Ghostscript

```
RENDITIONS_GHOSTSCRIPT_PATH=C:\Program Files\gs\gs10.xx.x\bin\gswin64c.exe
```

OCRmyPDF looks for `gs`, so a `gs.exe` copy or alias must exist beside
`gswin64c.exe`.

---

## 4. LibreOffice

```
RENDITIONS_ENABLED=true
RENDITIONS_LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe
```

### `soffice.exe` never exits when spawned without a console

It is a GUI-subsystem binary. Spawned from a service it produces no output and
does not terminate — measured here at over two minutes with no result. The
console front end `soffice.com`, sitting in the same directory, answers in
milliseconds.

The application resolves `soffice.exe` to `soffice.com` automatically on
Windows, so the path above is correct as written. This is noted because the
symptom — Office previews never appearing, with nothing in the log — otherwise
takes a long time to attribute.

### The profile path must stay short

Each conversion gets a throwaway profile under the OS temp directory.
LibreOffice builds a deep tree inside it and crashes with `0xC0000409`, no
message and no output file, once that crosses the Windows 260-character path
limit. Do not point `TEMP` at a deeply nested directory.

---

## 5. The server's default printer — check this before blaming the code

**LibreOffice queries the Windows default printer during startup, even
headless, even when converting to PDF and printing nothing.** If that printer is
an unreachable network device, the call blocks in the print spooler.

Measured on the development machine, whose default was a RICOH on a WSD port
that had stopped answering:

| printer | capability query |
|---|---|
| Microsoft Print to PDF | 1.0s |
| OneNote (Desktop) | 0.1s |
| AnyDesk Printer | 0.1s |
| RICOH MP C5503 AirPrint *(the default)* | **48.6s** |

Every conversion took ~52 seconds, essentially all of it that one call, and
Windows displayed "waiting for printer" each time. Windows reported the printer
as idle and online throughout.

The application sets `SAL_DISABLE_DEFAULTPRINTER` and `SAL_DISABLE_PRINTERLIST`
in LibreOffice's environment, which short-circuits both spooler calls before
they are made. That took conversions from ~52s to ~3.5s and is why no printer
configuration is required on the server.

It is worth knowing anyway, for two reasons: the variables are a LibreOffice
implementation detail and could change, and **the same stall affects every other
application on that machine** — Word, Excel, browsers, anything that opens a
print dialog. A server whose default printer is a local one
(`Microsoft Print to PDF`) avoids the whole class of problem.

---

## What OCR is and is not for

Recognition is roughly 85–93% accurate on clean Arabic print, and worse on a
real scan — skew, speckle, a fold, a stamp across the text. On the synthetic
300 dpi fixture in `tests/fixtures` it is currently perfect, which is the
*ceiling*, not a typical result.

That is good enough to **find** a document and not good enough to **read** as
one. Recognised text is therefore indexed for search and never returned by any
API, which `tests/ocr.integration.test.js` enforces.
