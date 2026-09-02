# Document recognition pilot

A customer with hundreds of thousands of historical scans asked for a module
that recognises a document's type from the shape of its first page, reads the
header (number, date, subject, addressee), and routes it through the workflow
for that type and department, once it is "100% confident".

This pilot is the first step, and only the first step: it **measures** whether
the recognition and the header reading are good enough on the customer's own
documents to build routing on. It changes nothing. It never sets a type, never
writes a field, never starts an approval. Its output is a screen of numbers.

## Off by default, switchable while running

- Environment: `CLASSIFICATION_ENABLED=false` (the default). Nothing runs.
- Stored setting: **Administration › Settings › المعالجة › التعرّف التلقائي على
  الوثائق (تجريبي)**. This overrides the environment without a restart.

Every part reads that switch. While it is off: uploads are not queued, the
worker's tick does nothing (one cached read every 15 s), and the routes answer
`{ enabled: false }` or `409 classification_disabled`. A production install
carrying this code with the switch off runs none of it and shows none of it:
the administration tab reports "disabled", and the document page never offers
the التعرّف tab at all.

Switching it off again keeps every stored fingerprint. Switching it back on
resumes.

## What it needs

The OCR toolchain that is already required: Tesseract 5 with Arabic data and
Ghostscript (see `docs/EXTERNAL_TOOLCHAIN.md`). OCRmyPDF is not used — it
returns text without positions, and the header reader works from positions.
The administration tab says which tool is missing.

## Running the pilot

1. Define the document types (Administration › Metadata). If the header
   values are to be measured too, define custom fields whose names contain
   رقم / العدد, تاريخ, الموضوع, and إلى / الجهة / القسم — the pilot matches
   fields to header roles by name and shows which it matched.
2. Upload **30 to 50 real scans per type**, from the customer's scanner and
   paper, choosing the type at upload and typing the header values into those
   fields. These are the training samples *and* the answer key; no separate
   labelling exists.
3. Switch the pilot on (above).
4. Administration › التعرّف التلقائي (تجريبي) › **احسب للوثائق الناقصة**.
   Documents uploaded after the switch was on are queued automatically; this
   catches up the ones uploaded before. Each costs one Ghostscript and one
   Tesseract pass on page one — measured at 1.5–2.5 s per page on the
   development machine, so a few hundred pages are minutes and 200,000 are
   days, in the background.
5. When the queue is empty, **احسب النتائج**.

## Reading the numbers

- **Accuracy** — of the typed documents, how many the system recognised from
  the others (leave-one-out: each is predicted from all the rest, never from
  itself). Per type: *recall* (of this type, how many were recognised) and
  *precision* (of what was called this type, how much was right).
- **Confusion** — which types get mistaken for which. Two types that are
  confused are usually two layouts that really are alike; the fix is a
  different type definition, not a different model.
- **Automation curve** — at each confidence threshold, how many documents
  would have been decided without a person and how many of those correctly.
  *This table is what replaces "100% confident."* The customer chooses a
  threshold; everything under it goes to a review queue.
- **Unknown** — pages nothing in the training set resembles. This is the
  desired behaviour for a format the system has not seen, not an error.
- **Header fields** — for each of the four, how many pages it was read on, how
  many could be compared with a typed value, and how many matched exactly,
  nearly, or not. Hijri dates are recognised but cannot be compared with a
  Gregorian field and are counted apart.

The document page shows the same thing for one document: the prediction with
its decision, the nearest neighbours with their similarity, and the header as
read with a confidence per field — beside the type and fields a person chose.

## How it works

Page one is rasterised (Ghostscript at 300 dpi for PDFs, sharp for images —
born-digital PDFs are rasterised too, so every document gets a fingerprint
made the same way) and read by Tesseract as TSV, which gives every word with
its box.

Two fingerprints are kept per page:

- **Text** — word unigrams and character trigrams of the normalised words,
  header-band words counted double, pure numbers collapsed to one token.
  Trigrams are what make it survive OCR errors.
- **Layout** — the page shrunk to 32×44 grey pixels and the header band to
  64×24. A letterhead, a form's boxes, a memo's title block survive that
  shrink; the words inside them do not.

A document is compared with every typed document by cosine similarity, blended
0.6 text / 0.25 header / 0.15 page. Its five nearest neighbours vote, weighted
by similarity squared; neighbours less than half as close as the closest do
not vote (with three samples per type, the two right answers were otherwise
outvoted by three irrelevant ones). Decision rule, in `features.js`:

| decision | rule |
|---|---|
| auto | vote share ≥ 0.9 and closest ≥ 0.5 |
| unknown | closest < 0.3 |
| review | everything else |

Header fields are read beside their labels — العدد, التاريخ, الموضوع, إلى and
their variants, in normalised form — from the same line, the neighbouring cell
on the same row, or the line beneath. A number must contain digits; a date
must parse as a real date (numeric or named month, Gregorian or Hijri); a
value that fails is kept, marked unvalidated, and halved in confidence.

## Known limits, measured

- **Handwriting is not read.** A number or date written by hand, or inside a
  hand-filled incoming stamp, will show "not found". Ask the customer whether
  their headers are typed before promising anything about header fields.
- **Arabic-Indic digits are inconsistent.** On the synthetic fixtures,
  Tesseract read `١٢٣٤/٥/٧` in one font as Latin letters and `٥٥` in another
  correctly. An Arabic-only pass did not help. The customer's real documents
  decide this; the header-field table will show it.
- Only page one is read. A document whose header is on page two is not seen.
- Multi-file documents use their first constituent file as page one.
- The comparison index is held in memory and rebuilt when fingerprints or types
  change. Fine at pilot scale (thousands of pages); beyond that it wants
  streaming.
- Metrics run leave-one-out over every typed document, which is quadratic;
  above 1,500 typed documents a random sample is evaluated and the screen
  says so.

## Where things live

| piece | location |
|---|---|
| fingerprints and similarity (pure) | `src/modules/classification/features.js` |
| header extraction (pure) | `src/modules/classification/extract.js` |
| rasterise + OCR page one | `src/modules/classification/page.js` |
| queue, index, predictions, metrics | `src/modules/classification/service.js` |
| worker | `src/modules/classification/worker.js` |
| routes | `src/modules/classification/routes.js` |
| tables | migration `0016`: `classification_queue`, `classification_pages` |
| setting | `classification.enabled` (settings service) |
| environment | `CLASSIFICATION_*` in `.env.example` |
| admin screen | `client/src/components/ClassificationTab.jsx` |
| document panel | `client/src/components/ClassificationPanel.jsx` |
| tests | `tests/classification.test.js` (pure), `tests/classification.integration.test.js` (real engines, skips without them) |
| fixtures | `tests/fixtures/classify/` — see `tests/fixtures/README.md` |

Routes: `GET /api/documents/:id/classification`, `POST …/classification/run`
(READ on the document); `GET /api/admin/classification/status`, `GET …/metrics`,
`POST …/rebuild` (super-admin).

## What comes after the pilot, if the numbers are good

Not built, deliberately: a routing matrix keyed by type *and* department
(templates are per type today), confidence-gated automatic routing with a
review queue for the rest, corrections feeding back as training samples,
document separation for feeder stacks, and a department entity or a designated
"routing field". Each is its own decision, taken on the pilot's numbers.
