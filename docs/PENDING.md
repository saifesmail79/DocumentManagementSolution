# Pending

Questions still waiting for an answer, phases not yet built, and loose ends
already known. Kept here so nothing depends on anyone's memory. When an
answer arrives, write it in the last column with its date; when an item is
built, remove it and say so in the commit message.

Last reviewed: 2026-09-27.

## Questions for the institute

Written in the correspondence study of 5 September 2026. Ask them before the
phase each one blocks is started. None has been answered yet.

| # | Question | Why it matters | Blocks | Answer |
|---|----------|----------------|--------|--------|
| 1 | On incoming letters, are the header details (number, date, subject, addressee) **typed or handwritten**? | The recognition pilot cannot read handwriting and misreads Arabic-Indic digits in some fonts. If most headers are handwritten, automatic routing is not possible and the mail room stays the router. | Phase 2 | |
| 2 | Must the book numbers be **gapless** by regulation? | Already built gapless: an entry is annulled in place and keeps its number, and the starting number can be set so a paper book continues where it stopped. Confirmation only. | Confirmation | |
| 3 | The **real list of departments**, and which staff group belongs to each. | Entered on الإدارة ← المراسلات. The demo seed has two departments; the real ones are needed at go-live. | Go-live | |
| 4 | Is a signature **drawn on a tablet** and stamped on the letter acceptable as an official signature, or only as a picture of one? (Iraqi Electronic Signature and Electronic Transactions Law No. 78 of 2012.) | The feature is a facsimile with an audit trail, not a cryptographic signature. Written confirmation is needed before it is built. | Phase 4 | |
| 5 | How **complex are the official letter templates**: logos, tables, multiple columns, footers? | Decides whether Word templates with fill-in fields, converted to PDF through LibreOffice, will reproduce them faithfully. | Phase 3 | |
| 6 | Should printed outgoing letters carry a **QR code** linking back to the archived letter, so a recipient can verify it? | A small addition to outgoing letters; the QR stamping path already exists for documents. | Phase 3 | |

## Correspondence phases

| Phase | What it does | State |
|-------|--------------|-------|
| 1 | **Manual mail room.** The mail room registers incoming and outgoing letters with automatic book numbers, forwards them to departments for action or information, departments mark them received and done, the mail room follows up, withdraws, annuls and marks outgoing letters dispatched. | Built. Committed 2026-09-27. Off by default behind `correspondence.enabled`. |
| 2 | **Automatic routing assist.** The system reads the header of a scanned incoming letter, proposes the department and the letter type, and the mail room confirms with one click instead of typing. Only offered when its measured accuracy on the institute's own scans is high enough; never routes on its own. | Not started. Gated on question 1 and on the recognition pilot's numbers on real scans. |
| 3 | **Official letter formats.** Templates designed by the institute in Word, assigned to groups, filled in from the document's fields, converted to PDF, and routed through approvals. Optional QR code on outgoing prints. | Not started. Gated on questions 5 and 6. |
| 4 | **Signing on a tablet.** A signature and handwritten notes drawn in the browser and flattened onto the page as a new version of the document, with an audit trail of who signed and when. | Not started. Gated on question 4, in writing. |

## Loose ends already known

Found in the review of 2026-09-26. None blocks go-live of what exists.

- **Test guide** (`docs/CORRESPONDENCE_TEST_GUIDE.md`): steps 4.3 and 5.1 ask for uploads the correspondence screens do not offer; step 6.3 says the المراسلات tile disappears when the module is off, but it stays.
- **Register and follow-up**: no print or export of السجل or المتابعة; no filters or sorting on المتابعة; a registered letter's subject or counterparty cannot be corrected except by annulling and registering again.
- **Department archive folder**: stored and shown on the unit, but nothing files a finished letter into it and no screen sets it.
- **Notifications and audit gaps**: no notification to a department when its copy is withdrawn or the letter is annulled; no audit entry for receipt, done, or dispatched.
- **Webhooks created before signing** keep sending unsigned deliveries until each secret is rotated from الإدارة ← الويب هوكس and handed to the receiver.
- **Deactivating a person** reports the approvals it strands but nothing reassigns or cancels them.
- **Demo accounts** diwan, fin1, fin2 and hr1 share one password and exist in the development database. Deactivate them before production.
- **Recognition pilot**: Arabic-Indic digits were misread in the test fonts. Measure on the institute's real scans before anything routes on it.
- **First sign-in with a temporary password** lands on the menu, not on the mail screen; the landing rule applies from the second sign-in.
