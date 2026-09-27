# Correspondence (الوارد والصادر) — Test Guide

Everything is already set up by the seed script. You only need to follow the
steps. All test users share one password: **`Demo!Wared2026`**

| User    | Who they are            | Department        |
| ------- | ----------------------- | ----------------- |
| `diwan` | Mail room (قلم الوارد)  | —                 |
| `fin1`  | Finance employee        | الشؤون المالية    |
| `fin2`  | Finance employee        | الشؤون المالية    |
| `hr1`   | HR employee             | الموارد البشرية   |

Folders created: **المراسلات / الوارد** and **المراسلات / الصادر**.
The module is already ON. To re-create all of this on another machine, run:
`node src/cli/seed-correspondence-demo.js`

## 0. Check the setup (your admin account, 2 minutes)

1. Log in with your admin account.
2. Open **الإدارة ← المراسلات**. You should see: mail-room group = قلم الوارد,
   two departments, and the two year counters.

## 1. Register an incoming letter (log in as `diwan`)

1. Logging in takes mail-room staff straight to **المراسلات**, on the
   **تسجيل كتاب** tab — this is the mail room's front door.
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
   on **المراسلات** directly (with nothing waiting, you land on the main
   menu instead), and the main-menu tile carries a red **count badge**
   whenever letters wait for your department. The **bell** carries the notification too — `fin2` got
   the same one.
2. **Shortest path:** click the notification. It opens the document —
   read it there, and the **المراسلة** tab has the **تسلّم** and
   **إنجاز** buttons for your department. Two clicks, done.
3. (Alternative path: the **المراسلات** tile → **الوارد إليّ** lists
   everything waiting for your department, with the same buttons.)
   Note: تسلّم only means "we received it" — the letter stays **محال**
   until the department presses **إنجاز**.
4. Optional: instead of closing it, put the document on an approval
   workflow from its **الاعتماد** tab — that feature works as before.

## 3. The information copy (log in as `hr1`)

1. Open **المراسلات ← الوارد إليّ**. The same letter shows **للاطلاع**.
2. Press **اطلعت عليه**. It closes by itself — information copies need
   nothing more.

## 4. Follow up (log in as `diwan`)

1. Open **المراسلات ← السجل**. The **عند الأقسام** column shows each
   department's own status (e.g. الشؤون المالية · منجز, الموارد
   البشرية · منجز). The letter itself shows **منجز** once every
   للإجراء department pressed إنجاز — if it still shows **محال**, that
   column tells you which department is still holding it.
   The same detail is on the document's **المراسلة** tab.
2. Open **المتابعة** — empty, because nothing is still open.
3. The "wrong department" case, step by step:
   1. Upload a new PDF into الوارد, open it → **المراسلة**, register it
      routed to **الموارد البشرية** (pretend that was a mistake).
   2. It does not matter if `hr1` already pressed تسلّم — the pull-back
      works either way.
   3. As `diwan`, open the document's **المراسلة** tab and press
      **سحب الإحالة** on the HR line (or do the same from **المتابعة**).
      A withdrawal **reason is required** (5 characters or more) and is
      kept on the cancelled line.
   4. In the same tab, forward it to **الشؤون المالية** under
      «إحالة إلى أقسام أخرى». Finance gets notified; HR's withdrawn
      line stays in the history as ملغاة.

## 5. An outgoing letter (log in as `diwan`)

1. Upload the signed reply into **المراسلات ← الصادر**.
2. Open it → **المراسلة** → choose الدفتر = **صادر** and the issuing
   department. Save — it gets the next صادر number.
3. In **السجل**, switch to دفتر الصادر and press **أُرسل** after the paper
   copy is actually dispatched. Status becomes أُرسل.

## 6. Admin cases (your admin account)

1. **Continue a paper book:** الإدارة ← المراسلات ← counters. Set دفتر
   الصادر's next number to e.g. 500 (as if the paper book stopped at 499).
   Register an outgoing letter — it gets 500. Then try setting the counter
   **below** 500 — the system refuses: numbers are never reused.
2. **Cancel an entry:** in السجل press **إلغاء القيد** on a letter. A reason
   is required. The row stays in the book, struck through — like a paper
   register. The next letter still gets the next number.
3. **Kill switch:** الإدارة ← الإعدادات ← `correspondence.enabled` = off.
   All correspondence screens disappear; nothing is deleted. Turn it back on.

## 7. The department's archive (any department user)

In **الوارد إليّ**, tick **عرض المنجزة أيضاً** and use the search box:
every letter ever routed to your department — closed ones included —
is found by number, subject, or sender. This is how 10,000 accumulated
letters stay reachable without folder filing.

## Good to know

- The letter's PDF never moves when it is forwarded. Who can OPEN it is
  still decided by folder permissions only. Departments can read the
  الوارد folder because the seed granted their groups قراءة on it.
- The mail room (قلم الوارد group) is the only one who can register,
  forward, cancel, and see السجل / المتابعة. Super admins always can.
- These are demo accounts. Deactivate them before production
  (الإدارة ← المستخدمون).
