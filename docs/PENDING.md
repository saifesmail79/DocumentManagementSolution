# Pending

Questions still waiting for an answer, phases not yet built, and loose ends
already known. Kept here so nothing depends on anyone's memory. When an
answer arrives, write it in the last column with its date; when an item is
built, remove it and say so in the commit message.

Last reviewed: 2026-09-27.

## Questions for the institute

Written in the correspondence study of 5 September 2026. Ask them before the
phase each one blocks is started.

| # | Question | Why it matters | Blocks | Answer |
|---|----------|----------------|--------|--------|
| 1 | On incoming letters, are the header details (number, date, subject, addressee) **typed or handwritten**? | The recognition pilot cannot read handwriting and misreads Arabic-Indic digits in some fonts. | Phase 2 | 2026-09-27: handwritten, and hard even for a person to read. Phase 2 dropped. |
| 2 | Must the book numbers be **gapless** by regulation? | Already built gapless: an entry is annulled in place and keeps its number, and the starting number can be set so a paper book continues where it stopped. Confirmation only. | Confirmation | |
| 3 | The **real list of departments**, and which staff group belongs to each. | Entered on الإدارة ← المراسلات. The demo seed has two departments; the real ones are needed at go-live. | Go-live | |
| 4 | Is a signature **drawn on a tablet** and stamped on the letter acceptable as an official signature, or only as a picture of one? (Iraqi Electronic Signature and Electronic Transactions Law No. 78 of 2012.) | Signing is built as a facsimile with an audit trail (who, when, which bytes), not a cryptographic signature, and the tab says so. Keep `signing.enabled` off in production until this is answered in writing. | Switching signing on in production | |
| 5 | How **complex are the official letter templates**: logos, tables, multiple columns, footers? | Letter formats are built on Word templates converted through LibreOffice. The administration screen's «معاينة» renders any template with sample values, so each real template can be checked for fidelity as it is uploaded. | Confirmation per template | |
| 6 | Should printed outgoing letters carry a **QR code** linking back to the archived letter, so a recipient can verify it? | The existing download option already stamps a QR code on any document on the way out (`?stamp=qr`); nothing more is needed unless a permanent, printed-in code is wanted. | Confirmation | |

## Correspondence phases

| Phase | What it does | State |
|-------|--------------|-------|
| 1 | **Manual mail room.** The mail room registers incoming and outgoing letters with automatic book numbers, forwards them to departments for action or information, departments mark them received and done, the mail room follows up, withdraws, annuls and marks outgoing letters dispatched. | Built. Committed 2026-09-27. Off by default behind `correspondence.enabled`. |
| 2 | **Automatic routing assist.** The system reads the header of a scanned incoming letter and proposes the department and type. | **Dropped 2026-09-27.** Letter headers are handwritten; a machine would misread what people already struggle to read. |
| 3 | **Official letter formats.** Word templates with `{{placeholders}}`, uploaded and labelled by an administrator, assigned to groups, filled by users, converted to PDF and filed as new documents with metadata and provenance; optional automatic approval. | Built 2026-09-27. Off by default behind `forms.enabled`. Guide: `docs/FORMS_SIGNING_TEST_GUIDE.md`. |
| 4 | **Signing on a tablet.** A signature and handwritten notes drawn in the browser on a rendered page and flattened into a NEW version of the PDF, with a ledger of who signed which bytes and when. | Built 2026-09-27. Off by default behind `signing.enabled`. Gated on question 4 for production use. |

## Loose ends already known

None blocks go-live of what exists.

Letter formats and signing (found while building, 2026-09-27):
- The duplicate-policy pass-through from letter generation is code-inspected, not tested: LibreOffice stamps a time into every PDF, so two identical letters never produce identical bytes.
- A template with an automatic approval, used by a person who holds upload but not read permission on the destination folder, files the letter but the approval does not start (it needs read permission); the outcome is reported and audited, not silent.
- Changing the document type of an already-active template clears invalid field mappings but does not re-run the activation rules; a required field of the new type may then be missing until the template is re-activated.
- Refusals for a missing Ghostscript, a render timeout, an encrypted PDF and a failed ledger insert are implemented but not covered by tests, because they cannot be provoked on a machine where the tools work.
- After a signature, the document's «preview» rendition is not re-queued (only the thumbnail is), so the preview shows the unsigned page until the renditions are rebuilt. Pre-existing behaviour of `addVersion`.
- A template blob left behind by a failed delete after a file replacement is reported by the storage reconciler but not swept.
- The signing page strip draws one button per page with no virtualisation; fine for letters, heavy for a 500-page scan.
- Pinch-zoom in «تحريك» mode zooms the browser viewport, not the page element; element zoom is by the toolbar buttons.

Correspondence (found in the review of 2026-09-26):
- **Test guide** (`docs/CORRESPONDENCE_TEST_GUIDE.md`): steps 4.3 and 5.1 ask for uploads the correspondence screens do not offer; step 6.3 says the المراسلات tile disappears when the module is off, but it stays.
- **Register and follow-up**: no print or export of السجل or المتابعة; no filters or sorting on المتابعة; a registered letter's subject or counterparty cannot be corrected except by annulling and registering again.
- **Department archive folder**: stored and shown on the unit, but nothing files a finished letter into it and no screen sets it.
- **Notifications and audit gaps**: no notification to a department when its copy is withdrawn or the letter is annulled; no audit entry for receipt, done, or dispatched.
- **Webhooks created before signing** keep sending unsigned deliveries until each secret is rotated from الإدارة ← الويب هوكس and handed to the receiver.
- **Deactivating a person** reports the approvals it strands but nothing reassigns or cancels them.
- **Demo accounts** diwan, fin1, fin2 and hr1 share one password and exist in the development database. Deactivate them before production.
- **Recognition pilot**: Arabic-Indic digits were misread in the test fonts. Now moot for routing (phase 2 dropped); the pilot stays off.
- **First sign-in with a temporary password** lands on the menu, not on the mail screen; the landing rule applies from the second sign-in.
