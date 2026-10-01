# Correspondence (الوارد والصادر) — Test Guide

Everything is already set up by the seed script. You only need to follow the
steps. All test users share one password: **`Demo!Wared2026`**

| User    | Who they are            | Department        |
| ------- | ----------------------- | ----------------- |
| `diwan` | Mail room (قلم الوارد)  | — (none)          |
| `fin1`  | Finance employee        | الشؤون المالية    |
| `fin2`  | Finance employee        | الشؤون المالية    |
| `hr1`   | HR employee             | الموارد البشرية   |

`diwan` belongs to no department, and that is deliberate: **الوارد إليّ** is the
department inbox, so it is never offered to that account. A mail-room clerk in no
department lands on **تسجيل كتاب** instead.

Folders created: **المراسلات / الوارد** and **المراسلات / الصادر**. المراسلات is
the intake folder, so the tree marks it **وارد وصادر**; it is an ordinary folder
and keeps its name and place.
The module is already ON. `correspondence.enabled` is the **master switch of the
whole الوارد والصادر area** — letter formats and ink signing sit under it — and
section 9 below is the proof. To re-create all of this on another machine, run:
`node src/cli/seed-correspondence-demo.js`

## 0. Check the setup (your admin account, 2 minutes)

1. Log in with your admin account.
2. Open **الإدارة ← الأقسام ومجلد الاستلام**. You should see: mail-room group =
   قلم الوارد, two departments, the intake folder (المراسلات), and the two year
   counters.

## 1. Register an incoming letter (log in as `diwan`)

1. Logging in takes mail-room staff straight to **تسجيل كتاب** — the mail room's
   front door, in the **الوارد والصادر** section of the home page. `diwan` is in
   no department, so **الوارد إليّ** is not offered at all: the inbox belongs to
   department members, and an empty one is not a starting screen.
2. Press **اختيار ملف** and pick any PDF (or scan with the scanner
   panel). The file uploads and the registration form opens by itself.
3. Keep الدفتر = **وارد** (choosing the book is required — nothing can
   be saved without it). Type a subject and the sender
   (e.g. وزارة التخطيط). Under الإحالة, add:
   - **الشؤون المالية** — للإجراء, with a due date.
   - **الموارد البشرية** — للاطلاع.
4. Press **تسجيل الوارد**. The system gives the letter number **1/2026**
   automatically. Numbers are never typed by hand.
5. Anything scanned but not yet registered waits under **بانتظار
   التسجيل** in the تسجيل كتاب tab — no letter can sit outside the book
   unnoticed.

## 2. Work the letter in the department (log in as `fin1`)

1. Because a letter is waiting for your department, logging in lands you
   on **الوارد إليّ** directly (with nothing waiting, you land on the home
   page instead), and on the home page the **الوارد إليّ** entry in the
   **الوارد والصادر** section carries a red **count badge** whenever letters
   wait for your department. `fin1` is a department member and nothing more, so
   that section holds **الوارد إليّ** alone — no register, no follow-up. The
   **bell** carries the notification too — `fin2` got the same one.
2. **Shortest path:** click the notification. It opens the document —
   read it there, and the **تسجيل وإحالة** tab has the **تسلّم** and
   **إنجاز** buttons for your department. Two clicks, done.
3. (Alternative path: home page → **الوارد والصادر ← الوارد إليّ** lists
   everything waiting for your department, with the same buttons.)
   Note: تسلّم only means "we received it" — the letter stays **محال**
   until the department presses **إنجاز**.
4. Optional: instead of closing it, put the document on an approval
   workflow from its **الاعتماد** tab — that feature works as before.

## 3. The information copy (log in as `hr1`)

1. Open **الوارد والصادر ← الوارد إليّ**. The same letter shows **للاطلاع**.
2. Press **اطلعت عليه**. It closes by itself — information copies need
   nothing more.

## 4. Follow up (log in as `diwan`)

1. Open **الوارد والصادر ← السجل**. The **عند الأقسام** column shows each
   department's own status (e.g. الشؤون المالية · منجز, الموارد
   البشرية · منجز). The letter itself shows **منجز** once every
   للإجراء department pressed إنجاز — if it still shows **محال**, that
   column tells you which department is still holding it.
   The same detail is on the document's **تسجيل وإحالة** tab.
2. Open **متابعة الإحالات** — empty, because nothing is still open.
3. The "wrong department" case, step by step:
   1. Upload a new PDF into الوارد (from the folder screen), open it →
      **تسجيل وإحالة**, register it routed to **الموارد البشرية** (pretend
      that was a mistake).
   2. It does not matter if `hr1` already pressed تسلّم — the pull-back
      works either way.
   3. As `diwan`, open the document's **تسجيل وإحالة** tab and press
      **سحب الإحالة** on the HR line (or do the same from
      **متابعة الإحالات**).
      A withdrawal **reason is required** (5 characters or more) and is
      kept on the cancelled line.
   4. In the same tab, forward it to **الشؤون المالية** under
      «إحالة إلى أقسام أخرى». Finance gets notified; HR's withdrawn
      line stays in the history as ملغاة.

## 5. An outgoing letter (log in as `diwan`)

1. Upload the signed reply into the folder **المراسلات / الصادر** (from the
   folder screen — the mail screens do not upload into it).
2. Open it → **تسجيل وإحالة** → choose الدفتر = **صادر** and the issuing
   department. Save — it gets the next صادر number.
3. In **السجل**, switch to دفتر الصادر and press **أُرسل** after the paper
   copy is actually dispatched. Status becomes أُرسل.

## 6. Admin cases (your admin account)

1. **Continue a paper book:** الإدارة ← الأقسام ومجلد الاستلام ← counters. Set دفتر
   الصادر's next number to e.g. 500 (as if the paper book stopped at 499).
   Register an outgoing letter — it gets 500. Then try setting the counter
   **below** 500 — the system refuses: numbers are never reused.
2. **Cancel an entry:** in السجل press **إلغاء القيد** on a letter. A reason
   is required. The row stays in the book, struck through — like a paper
   register. The next letter still gets the next number.
3. **Kill switch:** الإدارة ← الإعدادات ← **الوارد والصادر** ← the first row,
   **الوارد والصادر (المفتاح الرئيس)** = off. The whole **الوارد والصادر**
   section leaves the home page — heading, hint and every screen under it — and
   the **تسجيل وإحالة** tab leaves the documents. It now takes **إنشاء كتاب**
   and **التوقيع** with it, because it is the master switch of the area and not
   of the register alone. Nothing is deleted. Section 9 walks the whole proof;
   turn it back on when you are done here.

## 7. The department's archive (any department user)

In **الوارد إليّ**, tick **عرض المنجزة أيضاً** and use the search box:
every letter ever routed to your department — closed ones included —
is found by number, subject, or sender. This is how 10,000 accumulated
letters stay reachable without folder filing.

## 8. The paper trail: one letter, one number, many copies (20 minutes)

This is the journey the owner described. A letter arrives, and then **the paper
itself travels** — deputy, director, departments — and every trip may be
rescanned. All of those scans stay **one letter with one number**: each is a new
version of the letter's own document, named by what was done on the sheet.

Nothing in this section is required by the system. Every field has a default,
nothing blocks a referral, and a letter whose paper is never recorded behaves
exactly as it did before. Record what you know.

### 8.1 The letter arrives and is registered (log in as `diwan`)

1. **الوارد والصادر ← تسجيل كتاب** → **اختيار ملف**, pick any PDF (or scan).
   The registration form opens by itself.
2. الدفتر = **وارد**, الموضوع = «طلب تخصيص مالي», الجهة = «وزارة التخطيط».
   Leave **الإحالة إلى الأقسام** empty: the director has not seen the paper yet,
   so there is nothing to tell a department.
3. **تسجيل الوارد** → the letter gets e.g. **12/2026**.
4. Open the document → **تسجيل وإحالة**. Under the register card is the new
   **مسار الورقة** panel, already holding one line: **كما ورد · إصدار 1**, with
   your name under «سجّلها». The register wrote it; nobody typed it. The chip at
   the top right reads **الورقة في القلم**.

### 8.2 The paper goes up to the deputy

1. In **مسار الورقة** press **تسليم الورقة**. سُلّمت الورقة إلى =
   «أ. سعاد — معاون المدير الإداري», ملاحظة = «للتأشير ثم الإعادة» →
   **تسجيل التسليم**.
2. The chip now reads **الورقة مع أ. سعاد** with the time, and the timeline
   carries **سُلّمت إلى أ. سعاد**.
3. **الوارد والصادر ← السجل** shows the same fact in the new **الورقة** column —
   beside the status, not instead of it. **مقيّد** describes the register entry;
   the sheet is on somebody's desk. The two move independently, which is why
   they are two columns.

### 8.3 The initialled copy comes back (version 2)

1. **مسار الورقة ← إضافة نسخة معادة**. Read the dialog before touching it:
   the action is already **تهميش**, من قام بالإجراء is already **أ. سعاد** (where
   the paper is), and **الورقة عادت إلى القلم** is already ticked. A clerk who
   presses save without reading anything still records something true — that is
   the answer to «this requires very high discipline from Zainab».
2. Set ما الذي جرى على الورقة؟ = **توقيع أو تأشير**, ملاحظة = «أشّرت بالعرض على
   السيد المدير», pick the initialled sheet (**ملف من القرص**, or **مسح ضوئي**
   and scan it) → **حفظ النسخة**.
3. The timeline grows two lines from the one action: **توقيع أو تأشير — أ. سعاد ·
   إصدار 2** and **عادت من أ. سعاد**, and the chip is back to **الورقة في القلم**.
4. Press **فتح هذه النسخة** on the إصدار 2 line — exactly the bytes you just
   filed. Then open the document's **الإصدارات** tab: version 2's comment reads
   **توقيع أو تأشير — أ. سعاد: أشّرت بالعرض على السيد المدير**. Remember this;
   section 9 is about it.
5. Check what did **not** happen: **السجل** still holds one entry, still
   **12/2026**. A returning sheet never draws a number.

### 8.4 The director's instruction (version 3), and forwarding it

1. **تسليم الورقة** → «د. حسين — مدير المعهد». Note that the field now offers
   «أ. سعاد» and the department names in its list: it remembers everyone the
   paper has been with, so the same three or four names are never retyped.
2. **إضافة نسخة معادة**: leave the action on **تهميش**, person **د. حسين**,
   ملاحظة = «الموارد البشرية للإجراء والمالية للاطلاع», leave **الورقة عادت إلى
   القلم** ticked, pick the rescanned sheet → **حفظ النسخة** → **إصدار 3**.
3. Now type the director's words where the departments will read them. In the
   same tab, under **إحالة إلى أقسام أخرى**, fill **نص التهميش (اختياري)** with
   «الموارد البشرية للإجراء والمالية للاطلاع» — **once**, not per department —
   then add two rows: **الموارد البشرية** للإجراء with a due date, and
   **الشؤون المالية** للاطلاع. Press **إحالة**.
4. Both transfer lines now carry **التهميش: الموارد البشرية للإجراء والمالية
   للاطلاع**. That column has existed since the register was built and nothing
   ever wrote it, so every department used to read the letter and guess.
5. Log in as `hr1` → **الوارد إليّ**: the instruction is on the card under the
   subject. Nothing has to be guessed and nobody has to telephone the mail room.

### 8.5 A department records for itself (log in as `hr1`)

The owner's other warning: «the letter could move between departments without
reaching Zainab». A department holding a live transfer may record too.

1. As `hr1`, open the letter → **تسجيل وإحالة**. **مسار الورقة** is there with
   its buttons: HR holds a transfer in **محالة**/**مستلمة**, so the server allows
   HR to record. (`fin2`, with only the للاطلاع copy, may record as well; a user
   with no transfer on this letter sees the trail read-only.)
2. **تسليم الورقة** → «شعبة التعيينات» → **تسجيل التسليم**. The paper moved
   inside HR without passing the mail room, and the register knows.
3. **إضافة نسخة معادة** → **حفظ النسخة**. Expect a refusal in the dialog:
   **«يلزم لإضافة نسخة صلاحية الرفع على مجلد هذا الكتاب»**. Recording where the
   paper went needs nothing; adding a scan is a new document version and needs
   **رفع**, which the demo seed gives the mail room only.
4. Grant it (your admin account): **الإدارة ← الصلاحيات** → folder
   **المراسلات / الوارد** → group **الموارد البشرية** → add **رفع**. Back as
   `hr1`, repeat step 3 with action **إعادة مسح** → **إصدار 4**, and the entry
   reads «سجّلها» with the HR user's name, not the clerk's.
5. As `diwan`, reopen the letter: the HR hand-off and the HR copy are on the same
   one timeline as yours, in time order.

### 8.6 The reply, linked to the letter it answers (log in as `diwan`)

1. Upload the signed reply into **المراسلات / الصادر** from the folder screen
   (the mail screens do not upload into it).
2. Open it → **تسجيل وإحالة** → الدفتر = **صادر**, pick the issuing department.
3. In **رد على كتاب وارد (اختياري)** type `12` (or a word of the subject — two
   characters start the search). Pick **12/2026** from the list; it collapses to
   **رد على · وارد 12/2026** with an × to undo. Save.
4. The outgoing letter's card now carries **رد على الوارد 12/2026** as a link.
   Follow it: the incoming letter carries **أُجيب بالصادر …** back. One stored
   fact, read from both ends — it cannot go out of step.
5. **السجل ← دفتر الوارد**: row 12/2026 carries a green **مُجاب** badge beside
   its status. Switch to دفتر الصادر and press **أُرسل** once the paper copy
   actually leaves.
6. Try to break it: register another outgoing letter and pick an **annulled**
   incoming letter as the reply target — the picker leaves annulled letters out,
   and the server refuses one sent anyway with «الكتاب المختار للرد لم يُعد
   صالحاً».

### 8.7 The clerk's shortcut, for the sheet that comes back cold

1. **تسليم الورقة** on some letter, then go to **الوارد والصادر ← تسجيل كتاب**.
2. The **نسخة معادة لكتاب مسجّل** card lists every letter whose paper is out,
   with who has it and since when, and a **نسخة معادة** button on each row. The
   clerk picks by sight instead of searching — and cannot accidentally register
   the returning sheet as a second letter, which is the mistake this card exists
   to prevent.
3. For a sheet that travelled without being recorded, type its number or subject
   in **بحث برقم الكتاب أو موضوعه** — that searches both books, not only the
   letters that are out.

### 8.8 The audit trail (your admin account)

**الإدارة ← سجل التدقيق ← الوثائق** holds, for every step above:
`mail.paper_version` (naming the letter, the version and the action) and
`mail.paper_moved`, beside the `document.version_added` each copy also produced.
Claims about a physical sheet are only as good as the name and time attached to
them.

## 9. The master switch: the core DMS and nothing else (5 minutes)

The owner's condition for building any of this: «I want a clear isolation of the
features so that I can simply disable the inbound/outbound process and keep the
core DMS features only — most institutes may refuse this and prefer
handwriting». One switch does it.

1. **الإدارة ← الإعدادات ← الوارد والصادر**. One section, three rows:
   **الوارد والصادر (المفتاح الرئيس)**, **نماذج الكتب**, **التوقيع بخط اليد**.
2. Switch **نماذج الكتب** and **التوقيع بخط اليد** ON and leave them on — that
   is the point of the test. Now switch **الوارد والصادر (المفتاح الرئيس)** OFF.
   Changes take effect within about ten seconds.
3. The two rows under it immediately read **لا يعمل ما دام المفتاح الرئيس
   متوقفاً**, instead of claiming «مفعّل» for something that does nothing.
4. Reload the home page. There is **no الوارد والصادر heading at all** — no
   تسجيل كتاب, no الوارد إليّ, no السجل, no متابعة الإحالات, and **no إنشاء كتاب**
   even though نماذج الكتب is still switched on. What is left is
   «الوثائق والأرشيف» (and «إدارة النظام» for an administrator): the core
   document management.
5. Open the letter from section 8. It has **no تسجيل وإحالة tab** and **no
   التوقيع tab**. Folders, search, versions, permissions, approvals, sharing and
   the recycle bin are untouched.
6. Now the part that matters. Open the letter's **الإصدارات** tab:

   | الإصدار | التعليق |
   | ------- | ------- |
   | 1 | كما ورد |
   | 2 | توقيع أو تأشير — أ. سعاد: أشّرت بالعرض على السيد المدير |
   | 3 | تهميش — د. حسين: الموارد البشرية للإجراء والمالية للاطلاع |
   | 4 | إعادة مسح — شعبة التعيينات |

   The paper trail panel is gone; **the words are still there**, because every
   action is written into the core version comment as well as into the
   correspondence table. Core code never reads a correspondence table, so the
   version history stands on its own with the area switched off — an institute
   that refuses the letter process still inherits a readable set of scans.
7. Check the administration side: **الإدارة ← نماذج الكتب** says نماذج الكتب is
   on but **the master switch above it is off**, and names that switch — not the
   one that is already on.
8. Visit `/correspondence` or `/forms` by typing the URL. Both refuse; the server
   rejects every route of the area independently of the menu. The page at
   `/forms` says «الوارد والصادر متوقف» and names the master switch.
9. Turn the master switch back on. Everything returns complete — the register,
   the numbers, the transfers, the instruction texts, the reply links and the
   whole paper trail. Nothing was ever deleted.

## Good to know

- The letter's PDF never moves when it is forwarded. Who can OPEN it is
  still decided by folder permissions only. Departments can read the
  الوارد folder because the seed granted their groups قراءة on it.
- The mail room (قلم الوارد group) is the only one who can register,
  forward, cancel, and see السجل / متابعة الإحالات. Super admins always can.
- **الوارد إليّ** is the one mail screen that does not follow from the mail-room
  group: it is offered to members of a department and to nobody else, super
  admins included. Put an account in a department group to see it.
- Recording the paper's movements needs no folder permission — it is a note
  about a physical object. Adding a returned copy is a document version and
  needs **رفع** on the letter's folder, like any other version. A legal hold, a
  check-out by someone else, or a multi-file document refuses the copy and says
  so in the dialog.
- Department-to-department forwarding inside the system is **not** built: a
  department can record that the paper moved, but only the mail room routes a
  letter. Open question 8 in `docs/PENDING.md`.
- These are demo accounts. Deactivate them before production
  (الإدارة ← المستخدمون).
