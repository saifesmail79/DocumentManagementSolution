# Pending

Questions still waiting for an answer, phases not yet built, and loose ends
already known. Kept here so nothing depends on anyone's memory. When an
answer arrives, write it in the last column with its date; when an item is
built, remove it and say so in the commit message.

Last reviewed: 2026-10-03.

## Questions for the institute

Written in the correspondence study of 5 September 2026. Ask them before the
phase each one blocks is started.

| # | Question | Why it matters | Blocks | Answer |
|---|----------|----------------|--------|--------|
| 1 | On incoming letters, are the header details (number, date, subject, addressee) **typed or handwritten**? | The recognition pilot cannot read handwriting and misreads Arabic-Indic digits in some fonts. | Phase 2 | 2026-09-27: handwritten, and hard even for a person to read. Phase 2 dropped. |
| 2 | Must the book numbers be **gapless** by regulation? | Already built gapless: an entry is annulled in place and keeps its number, and the starting number can be set so a paper book continues where it stopped. Confirmation only. | Confirmation | |
| 3 | The **real list of departments**, and which staff group belongs to each. | Entered on الإدارة ← الأقسام ومجلد الاستلام. The demo seed has two departments; the real ones are needed at go-live. | Go-live | |
| 4 | Is a signature **drawn on a tablet** and stamped on the letter acceptable as an official signature, or only as a picture of one? (Iraqi Electronic Signature and Electronic Transactions Law No. 78 of 2012.) | Signing is built as a facsimile with an audit trail (who, when, which bytes), not a cryptographic signature, and the tab says so. Keep `signing.enabled` off in production until this is answered in writing. | Switching signing on in production | 2026-10-01: signing is now also behind the master switch `correspondence.enabled`, so an institute that leaves the letter area off cannot reach it at all. The question still stands for one that switches the area on. |
| 5 | How **complex are the official letter templates**: logos, tables, multiple columns, footers? | Letter formats are built on Word templates converted through LibreOffice. The administration screen's «معاينة» renders any template with sample values, so each real template can be checked for fidelity as it is uploaded. | Confirmation per template | |
| 6 | Should printed outgoing letters carry a **QR code** linking back to the archived letter, so a recipient can verify it? | The existing download option already stamps a QR code on any document on the way out (`?stamp=qr`); nothing more is needed unless a permanent, printed-in code is wanted. | Confirmation | |
| 7 | Will the staff actually **record hand-overs and returned copies**, or will they keep writing on the paper only? | This is the owner's own doubt about the paper trail: «this requires very high discipline from Zainab and intervention on each step». Everything was built optional — defaults filled in, nothing blocking a referral, departments able to record for themselves — but if nobody records, the trail is empty rows and the honest answer is to leave `correspondence.enabled` **off** and run the core DMS alone. Ask after one real week, not before. | Switching the area on in production | |
| 8 | Should a department be able to **forward a letter to another department** inside the system? | **Not built.** Today only the mail room routes a letter; a department holding it can record that the paper moved and add a copy, but cannot create a transfer. If departments pass letters sideways in practice, the register will show the paper moving with no referral behind it — truthful, but incomplete. Building it means deciding who may send, whether the mail room is notified, and whether the original referral stays open. | A possible phase 5 | |

## Correspondence phases

| Phase | What it does | State |
|-------|--------------|-------|
| 1 | **Manual mail room.** The mail room registers incoming and outgoing letters with automatic book numbers, forwards them to departments for action or information, departments mark them received and done, the mail room follows up, withdraws, annuls and marks outgoing letters dispatched. | Built. Committed 2026-09-27. The paper trail (versions named by action, the custody log, the typed تهميش, reply links) added 2026-10-01. Off by default behind `correspondence.enabled`, which is now the MASTER switch of the whole area. |
| 2 | **Automatic routing assist.** The system reads the header of a scanned incoming letter and proposes the department and type. | **Dropped 2026-09-27.** Letter headers are handwritten; a machine would misread what people already struggle to read. |
| 3 | **Official letter formats.** Word templates with `#placeholders#` (the older `{{…}}` form still accepted), uploaded and labelled by an administrator, assigned to groups, filled by users, converted to PDF and filed as new documents with metadata and provenance; optional automatic approval. | Built 2026-09-27. Off by default behind `forms.enabled`, which since 2026-10-01 works only while the master switch `correspondence.enabled` is also on. Guide: `docs/FORMS_SIGNING_TEST_GUIDE.md`. |
| 4 | **Signing on a tablet.** A signature and handwritten notes drawn in the browser on a rendered page and flattened into a NEW version of the file — a PDF, or a scanned image (JPEG, PNG, WebP, single-page TIFF) which keeps its format — with a ledger of who signed which bytes and when. | Built 2026-09-27; image signing added 2026-09-28. Off by default behind `signing.enabled`, which since 2026-10-01 works only while the master switch `correspondence.enabled` is also on. Gated on question 4 for production use. |

2026-09-30 — **the two areas.** Everyday document work and letter work no longer
share one flat menu. The system is now «الوثائق والأرشيف» and «الوارد والصادر»,
plus «إدارة النظام» for super admins, each area declared once in
`client/src/navigation.js` and drawn as its own home-page section in a fixed
order. The mail area lists its screens directly instead of hiding them behind a
tile, and an area with nothing to offer is not drawn at all. «تسجيل كتاب» is the
letter that ARRIVED and «إنشاء كتاب» the letter WE WRITE; «الوارد إليّ» is offered
only to a member of a department (a new `member` flag on the correspondence status
reply, honest for super admins too); «المتابعة» became «متابعة الإحالات» so it can
no longer be confused with «ما أتابعه»; the two administration tabs became
«الأقسام ومجلد الاستلام» and «نماذج الكتب». No schema change, no new migration, no
route or `?tab=` key changed. The letters folder keeps its name and place and is
marked «وارد وصادر» in the tree.

2026-10-03 — **the head writes on the screen.** A head or director can now write
his instruction and sign on a registered letter from the **التوقيع** tab, without
paper. On a registered letter the tab asks whether the writing is «تهميش (توجيه)»
or «توقيع أو تأشير»; the new version is named that way in «مسار الورقة» under the
signer's own name, with the words typed in the note. An instruction on an incoming
letter — written on screen, or filed as a returned copy by a department — sends the
mail room a «تهميش على كتاب» notice, and the forwarding form starts from those words.
Walk-through: `docs/LETTER_JOURNEY_TEST.md` (the test users `hrhead` and `legal1`
were added to the development system for it).

2026-10-01 — **the paper trail, and one master switch.** A registered letter's
sheet of paper is now followed, and the whole الوارد والصادر area hangs on one
setting.

- **One letter, many versions.** A returned, re-annotated or rescanned sheet is
  added as a NEW VERSION of the letter's own document through the core version
  mechanism — never a second letter and never a second number. Each version is
  named by the act done on the paper: «كما ورد» (written by the register itself
  when an incoming letter is entered), «تهميش», «توقيع أو تأشير», «إعادة مسح»,
  «أخرى», with an optional free-text person and note.
- **Where the paper is.** A custody log of hand-overs («سُلّمت الورقة إلى …») and
  returns («عادت الورقة من …») by name; the current location is the latest entry,
  shown as a chip on the letter, in a new **الورقة** column of السجل, and as a
  list of letters currently out on the تسجيل كتاب screen.
- **The director's words.** Registration and forwarding now write
  `correspondence_transfers.note` — the column existed since phase 1 and the
  department queue always displayed it, but nothing wrote it. One shared
  **نص التهميش** is typed once and attached to every department forwarded in that
  step.
- **Reply links.** An outgoing letter can be registered as the answer to an
  incoming one; stored as a core `reply_to` document relation, so the صادر shows
  «رد على الوارد …», the وارد shows «أُجيب بالصادر …» and the register marks it
  **مُجاب**.
- **Departments record too.** A member of a unit holding a transfer in `pending`
  or `received` may add a version (still subject to the core UPLOAD permission on
  the folder) and record movements, because the paper may move without reaching
  the mail room. Department-to-department forwarding is not built — question 8.
- **One master switch.** `correspondence.enabled` is now the master switch of the
  whole area: `forms.enabled` and `signing.enabled` are read as «their own switch
  AND the master», so with it off the system is the core document management only
  — no mail section, no «إنشاء كتاب», no «التوقيع» tab, no «تسجيل وإحالة» tab, no
  paper trail. All three still default to OFF. The isolation is real in both
  directions: core code never reads a correspondence table, and the action words
  are written into the core version comment as well, so the ordinary الإصدارات
  list still reads «تهميش — د. حسين: …» with the area switched off.
- Migration `0024-correspondence-paper-trail`; two new audit actions
  (`mail.paper_version`, `mail.paper_moved`) under the الوثائق category. No core
  table was changed. Guide: `docs/CORRESPONDENCE_TEST_GUIDE.md` sections 8 and 9.

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

The paper trail and the master switch (found while building, 2026-10-01):
- **Departments cannot add a copy without an upload grant.** The demo seed gives
  department groups قراءة on the letters folder, so a department holding a letter
  can record movements but its first «إضافة نسخة معادة» is refused for want of
  **رفع**. Correct behaviour, but it will look like a bug at go-live: decide per
  institute whether departments get رفع on the الوارد folder.
- **A trail row can fail while its version commits.** The `/versions` reply then
  carries `trail: false` — the scan is filed and the act is unnamed. No screen
  surfaces the flag, so the only sign is a version with no line in مسار الورقة.
- **No screen edits or removes a trail entry.** A wrong action or a misspelled
  name stays as recorded; the fix is another entry. Deliberate (it is a log), but
  nobody has agreed it yet.
- **The paper's whereabouts are not reported on.** No filter, print or export of
  "letters out for more than N days", which is the first thing a follow-up clerk
  will ask for once the trail is being kept.

Correspondence (found in the review of 2026-09-26):
- **Test guide** (`docs/CORRESPONDENCE_TEST_GUIDE.md`): steps 4.3 and 5.1 ask for uploads the correspondence screens do not offer — they are done from the folder screen.
- **Register and follow-up**: no print or export of السجل or متابعة الإحالات; no filters or sorting on متابعة الإحالات; a registered letter's subject or counterparty cannot be corrected except by annulling and registering again.
- **Department archive folder**: stored and shown on the unit, but nothing files a finished letter into it and no screen sets it.
- **Notifications and audit gaps**: no notification to a department when its copy is withdrawn or the letter is annulled; no audit entry for receipt, done, or dispatched.
- **Webhooks created before signing** keep sending unsigned deliveries until each secret is rotated from الإدارة ← الويب هوكس and handed to the receiver.
- **Deactivating a person** reports the approvals it strands but nothing reassigns or cancels them.
- **Demo accounts** diwan, fin1, fin2 and hr1 share one password and exist in the development database. Deactivate them before production.
- **Recognition pilot**: Arabic-Indic digits were misread in the test fonts. Now moot for routing (phase 2 dropped); the pilot stays off.
- **First sign-in with a temporary password** lands on the menu, not on the mail screen; the landing rule applies from the second sign-in.
