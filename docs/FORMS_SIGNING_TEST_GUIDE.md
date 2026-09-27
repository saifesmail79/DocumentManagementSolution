# Letter formats (النماذج) and ink signing (التوقيع) — Test Guide

Phases 3 and 4 of the correspondence plan. Both are switched OFF by default and
carry no cost while off. Follow this from top to bottom; each step names the
screen and the words on it.

The development database already holds a demo template («كتاب صادر — نموذج
تجريبي») and a generated, signed letter (document 37) from the automated run
of 2026-09-27, so you can look before you build.

## 0. Switch on (your admin account, 1 minute)

1. **الإدارة ← الإعدادات ← النماذج والتوقيع**: switch on «النماذج الرسمية» and
   «التوقيع بالقلم». The change takes effect within ten seconds.
2. **الإدارة ← النماذج** shows a readiness line: LibreOffice must be present
   for letters (it is on this machine). The signing tab tells you if
   Ghostscript is missing.

## 1. Design a template in Word (5 minutes)

1. Open Word. Write the letter as the institute writes it — letterhead, tables,
   footer, anything. Wherever a value changes per letter, type a placeholder
   between double braces: `{{العدد}}`, `{{الجهة}}`, `{{الموضوع}}`, `{{النص}}`.
   Arabic or Latin names both work; no spaces inside the braces.
2. Four placeholders are filled by the system and cannot be set by anyone:
   `{{date}}` (27/09/2026), `{{date_iso}}` (2026-09-27), `{{date_ar}}` (the
   date written in Arabic) and `{{author}}` (the display name of whoever
   generates the letter).
3. Save as `.docx`. Headers and footers may carry placeholders too.

## 2. Upload and publish it (الإدارة ← النماذج)

1. Press **نموذج جديد**: name, description, optional document type, optional
   approval template (starts automatically after each letter), optional
   default folder, then the file. A file with a stray `{{` or a placeholder
   named like `{{@x}}` is refused with the reason.
2. The template starts **disabled**. The fields table lists every placeholder
   found: give each an Arabic label, tick «متعدد الأسطر» for the body, «إلزامي»
   where needed. If the template has a document type, a field may be mapped
   to one of that type's text, number or date fields — its value is then also
   stored as searchable metadata (limit 1000 characters).
3. Press **معاينة**: a PDF opens with the labels as sample values. This is the
   place to check that LibreOffice reproduced the letterhead, tables and
   footer faithfully — the answer to open question 5 for that template.
4. **الصلاحية**: choose the groups or users who may use it. Super
   administrators always can.
5. **تفعيل**. Activation is refused while a field has no label, or while the
   document type demands a required field the template does not supply.
6. **استبدال الملف** re-reads the placeholders and shows what was added,
   removed and kept. If a removed placeholder was the only one supplying a
   required field of the document type, the template is taken offline at the
   same time and the alert names those fields; re-map and activate again.

## 3. Write a letter (log in as a member of an allowed group)

1. The home menu shows the **النماذج** tile only to someone with a usable
   template. Open it, pick the template.
2. Fill the fields, choose the destination folder (only folders you may
   upload into are offered; the last one used is remembered per person, and a
   remembered or default folder you may no longer upload into is cleared so
   you choose again), keep or change
   the proposed title, press **إنشاء الكتاب**. The button shows «جارٍ تجهيز
   الكتاب…» for a few seconds.
3. The new document opens. Check: the PDF text, the document type, the
   mapped field values under **البيانات**, and that **المراسلة** can register
   it as a صادر letter like any other document.
4. Expected refusals: a missing required field is refused at once, before
   any conversion; a second press during conversion does nothing; two
   letters at the same instant on a busy server ask the second to retry.

## 4. Sign a page (any single-file PDF; the generated letter is ideal)

1. Open the document, tab **التوقيع**, press **ابدأ التوقيع**. Page 1 appears
   as an image with a page strip above it.
2. Draw with the mouse, a pen or a finger. Try **تراجع** (undoes one stroke),
   **مسح الصفحة**, the two ink colours, the three widths, zoom, and — on a
   tablet — **تحريك** (scroll and pinch without drawing) and **القلم فقط**
   (a resting palm leaves no mark). Ink on one page stays when you flip to
   another; the strip marks pages that carry ink.
3. A page too large to sign at the configured resolution (an A0 plan, for
   example) is marked in the strip and cannot be drawn on; every ordinary
   letter or A4/A3 scan is fine.
4. Add a note, press **حفظ التوقيع**, confirm. The panel reloads: the
   signature list shows who, when, version 2, page 1, the note, and a link to
   that version. **الإصدارات** shows version 2 with the comment «توقيع: …»;
   version 1 is untouched.
5. Download the document: the ink is on the page, with a small grey
   provenance line at the bottom-left («DMS signature: user …, v2, …»).
6. Expected refusals, each explained in the tab instead of a pen: a
   multi-file document; a non-PDF; a document under legal hold; a document
   checked out by someone else; a reader without upload permission on the
   folder. Add a version from another session while ink is drawn, then save:
   «تغيّرت الوثيقة» — the ink is kept until you refresh.

## 5. Audit and evidence (your admin account)

- **الإدارة ← سجل التدقيق ← الوثائق**: `document.created` and
  `form_letter.created` for the letter; `document.version_added` and
  `document.signed` for the signature, the latter naming the version, the
  pages and the two file hashes.
- **الإدارة ← سجل التدقيق ← الإعدادات**: every template change.

## Good to know

- A signature is a picture of handwriting with a full audit trail (who, when,
  which bytes), not a certified electronic signature under Law No. 78 of 2012.
  Whether the institute accepts it is open question 4 in `docs/PENDING.md`;
  keep signing off in production until it is answered.
- Templates are deactivated, never deleted, so old letters keep their
  provenance. A template's file is verified against its recorded hash before
  every letter; replace it only from the administration screen.
- Ordinary letters are not duplicates of each other: LibreOffice stamps a
  time into every PDF, so the duplicate check never fires on generated
  letters.
- Values merged into a letter are kept as provenance with the document and
  are cleared when the document's bytes are purged.
