# Letter journey test — from a ministry letter to the institute's reply

This walks one official letter through the whole system. The mail room receives and registers it.
HR receives it, and the HR head writes and signs his instruction on the screen and adds a comment.
Finance and Legal give their opinions by a deadline. HR prepares the answer, the head signs it on the
screen, and the mail room registers and sends it. You play every person yourself.
Prepared and rehearsed on the development system on 2026-10-03.

## Before you start

- The development server must be running at `http://localhost:3040`. Refresh the browser once.
- In «الإدارة ← الإعدادات ← الوارد والصادر», the master switch and «التوقيع بخط اليد» must be on. Both are on now.
- The sample papers are in `C:\Users\Saif\Documents\DMS-Test-Letter-Journey`.
- Each person needs their own session. Use five windows, or sign out (the arrow button, top left) and sign in
  again between steps. Chrome, a Chrome incognito window, Edge, an Edge InPrivate window and Firefox give five.
- The head writes with the mouse here. On a tablet with a pen it looks like real handwriting; with a mouse,
  a short line and a signature are enough, and the full instruction is typed in the note.

## Who plays whom

| Person | Username | Password | Department | What they do |
|---|---|---|---|---|
| Mail-room clerk | `diwan` | `Demo!Wared2026` | «قلم الوارد» | Registers the letter, forwards it, registers and sends the reply |
| HR clerk | `hr1` | `Demo!Wared2026` | «الموارد البشرية» | Receives the letter, files the final reply |
| HR head | `hrhead` | `Demo!Wared2026` | «الموارد البشرية» | Writes and signs his instruction on screen, comments, signs the final reply |
| Finance employee | `fin1` | `Demo!Wared2026` | «الشؤون المالية» | Gives the financial opinion |
| Legal employee | `legal1` | `Demo!Wared2026` | «الشؤون القانونية» | Gives the legal opinion |

## The papers

| File | Used in | What it is |
|---|---|---|
| `1 كتاب وزارة التعليم العالي 7731.pdf` | Step 1 | The ministry's letter as it arrived |
| `3 رأي الشؤون المالية.pdf` | Step 5 | Finance's opinion |
| `4 رأي الشؤون القانونية.pdf` | Step 6 | Legal's opinion |
| `5 جواب المعهد إلى الوزارة.pdf` | Steps 7 and 8 | The institute's final reply to the ministry |

The system refuses the same file twice in the same folder, so each paper can be used once. For a second
run, ask for fresh copies.

## Step 1 — Mail room: receive, register, forward to HR (as `diwan`)

1. Sign in as `diwan`. On the home page, in «الوارد والصادر», press «تسجيل كتاب».
2. In the card «كتاب جديد», press «اختيار ملف» and choose paper 1. The letter's page opens on the tab «تسجيل وإحالة».
3. Fill the form:
   - Book «الدفتر»: «وارد».
   - Subject «الموضوع»: «استيضاح بشأن مخصصات التدريب الخارجي للموظفين».
   - Sender «الجهة المرسِلة»: «وزارة التعليم العالي والبحث العلمي».
   - Their number «رقم كتاب الجهة»: 7731. Their date «تاريخ كتاب الجهة»: 2026/10/01.
4. Under «الإحالة إلى الأقسام», press «إضافة قسم» and choose «الموارد البشرية», «للإجراء», due date 2026/10/16.
5. In «نص التهميش (اختياري)» type «لإعداد الجواب». Press «تسجيل الوارد».

You should see:

- The letter gets the next incoming number, for example 7/2026. **Write it down; step 9 needs it.**
- In «مسار الورقة», version 1 is labelled «كما ورد».
- Both `hr1` and `hrhead` get a bell notification, because both are members of HR.

## Step 2 — HR clerk: receive (as `hr1`)

1. Sign in as `hr1`. Open «الوارد إليّ». The letter is there with «لإعداد الجواب» under it. Press «تسلّم».

The head does not need it passed to him: as a member of HR he already has the letter in his own «الوارد إليّ».

## Step 3 — HR head: write and sign the instruction on screen, and comment (as `hrhead`)

1. Sign in as `hrhead`. Open «الوارد إليّ» and press «فتح الوثيقة» on the letter.
2. Open the tab «التوقيع» and press «ابدأ التوقيع». The letter's page appears.
3. With «رسم» selected, draw on the page with the mouse: a short line where the instruction goes, and your signature.
4. Below the page, the question «ما الذي تكتبه على الكتاب …؟» already has «تهميش (توجيه)» selected. Keep it.
5. In «نص التهميش (يظهر لقلم الوارد وفي مسار الورقة)» type
   «الشؤون المالية والشؤون القانونية لإبداء الرأي خلال أسبوع — 2026/10/10».
6. Press «حفظ التوقيع» and confirm with «حفظ التوقيع».
7. Open the tab «المناقشة», type «يُراعى أن تشمل الكلفة تذاكر السفر والإقامة.» and press the send arrow.

You should see:

- The message «حُفظ التوقيع في الإصدار 2 وسُجّل في مسار الورقة «تهميش» وأُبلغ قلم الوارد».
- Under the page, «التوقيعات على هذه الوثيقة» lists «مدير الموارد البشرية» with the instruction text.
- On the tab «تسجيل وإحالة», «مسار الورقة» now shows version 2 «تهميش — مدير الموارد البشرية» with his words.

## Step 4 — Mail room: forward to Finance and Legal on the head's instruction (as `diwan`)

1. As `diwan`, the bell shows «تهميش على كتاب». Press it to open the letter, then the tab «تسجيل وإحالة».
2. «مسار الورقة» shows the head's version 2 and his words.
3. Under «إحالة إلى أقسام أخرى», «نص التهميش» is already filled with the head's words, marked
   «مأخوذ من آخر تهميش في مسار الورقة». Keep it.
4. Press «إضافة قسم» twice:
   - «الشؤون المالية», «للإجراء», due date 2026/10/10.
   - «الشؤون القانونية», «للإجراء», due date 2026/10/10.
5. Press «إحالة».

You should see three forwardings on the letter. «متابعة الإحالات» lists the two new ones with their due date.

## Step 5 — Finance: give the opinion and link it (as `fin1`)

1. Sign in as `fin1`. «الوارد إليّ» shows the letter with the head's words and the due date. Press «تسلّم».
2. Press «فتح الوثيقة». The head's handwriting and signature are on the page, and the tab «المناقشة» shows his comment.
3. In the folder tree, open «آراء الأقسام», press «رفع وثيقة» and choose paper 3. Click the new document to open it.
4. Open the tab «العلاقات» and press «ربط وثيقة». Choose «رد على» as the link type. In «ابحث عن وثيقة…» type 7731.
   The suggestions also include opinions and my rehearsal documents, because they mention 7731 too.
   Choose exactly «1 كتاب وزارة التعليم العالي 7731», not anything starting with «تحضير» or «رأي».
5. Go back to «الوارد إليّ», press «إنجاز», type «أُرفق الرأي المالي» and press «تسجيل الإنجاز».

## Step 6 — Legal: the same with paper 4 (as `legal1`)

Repeat step 5 as `legal1`, with paper 4 and the note «أُرفق الرأي القانوني».

## Step 7 — HR clerk: read the opinions and file the final reply (as `hr1`)

1. As `hr1`, open «الوارد إليّ», press «فتح الوثيقة» and open the tab «العلاقات».
   Both opinions are listed as «رد على ←». Open each to read it.
2. In the folder tree, open «المراسلات» then «الصادر», press «رفع وثيقة» and choose paper 5.
   A note says the folder belongs to «الوارد والصادر»; that is expected.

## Step 8 — HR head: sign the final reply on screen (as `hrhead`)

1. As `hrhead`, open «المراسلات» then «الصادر» in the folder tree, and click «5 جواب المعهد إلى الوزارة».
2. Open the tab «التوقيع», press «ابدأ التوقيع» and draw your signature over the signature line.
   The reply is not registered yet, so no «تهميش» question is asked.
3. Type «موافق على الجواب» in the note, press «حفظ التوقيع» and confirm.
4. Then as `hr1`: open «الوارد إليّ», press «إنجاز», type «أُعدّ الجواب ووقّعه المدير» and press «تسجيل الإنجاز».

## Step 9 — Mail room: register the signed reply as outgoing and send it (as `diwan`)

1. As `diwan`, open «تسجيل كتاب». Under «بانتظار التسجيل», the reply «5 جواب المعهد إلى الوزارة» is waiting. Press «سجّل».
2. Fill the form:
   - Book «الدفتر»: «صادر». Issuing department «القسم المصدِر»: «الموارد البشرية».
   - Subject: «جواب كتاب الوزارة 7731 — مخصصات التدريب الخارجي».
   - Addressee «الجهة المرسَل إليها»: «وزارة التعليم العالي والبحث العلمي».
   - In «رد على كتاب وارد (اختياري)» type the incoming number from step 1, for example 7/2026, and choose it.
3. Press «تسجيل الصادر». When the courier has taken it, press «أُرسل» and confirm.

## What you should see at the end

- **The original letter, tab «تسجيل وإحالة»:** status «منجز», the line «أُجيب بالصادر …», all three forwardings closed with their notes, and «مسار الورقة» with version 1 «كما ورد» and version 2 «تهميش — مدير الموارد البشرية».
- **The original letter, tab «المناقشة»:** the head's comment.
- **The original letter, tab «العلاقات»:** three documents, the two opinions and the final reply.
- **The reply, tab «التوقيع»:** the head's signature with «موافق على الجواب»; the sent version is the signed one.
- **«السجل»:** the incoming letter is marked «مُجاب», and the outgoing reply shows «أُرسل».
- **«متابعة الإحالات»:** nothing left from this letter.
- **A finished example to compare with:** incoming 6/2026 and outgoing 5/2026, titled «تحضير ٢». That is my rehearsal of these exact steps, which passed every check.

## Where the system differs from your scenario

1. **A department cannot pass a letter to one named person.** Every member of HR sees it, the head included, so nothing is "forwarded to the head".
2. **Only the mail room forwards to other departments.** The head's instruction now notifies the mail room and fills the forwarding text, but the clerk still presses «إحالة».
3. **A department's answer is not attached when it finishes.** «إنجاز» takes a note only; the opinion is uploaded as its own document and linked by hand in «العلاقات».
4. **Nobody is notified when a department finishes.** HR sees the opinions only by opening the letter's «العلاقات» tab.
5. **Only the mail room registers outgoing letters.** HR prepares the reply, the head signs it, and the clerk registers and sends it.

## Prepared for this test on the development system

- **New department:** the group and department «الشؤون القانونية», with the user `legal1`.
- **HR head:** the user `hrhead` («مدير الموارد البشرية»), a member of «الموارد البشرية».
- **New folder «آراء الأقسام»:** HR, Finance and Legal may read and upload; the mail room may read.
- **«المراسلات» and its subfolders:** HR may now also upload, so its members can sign and file there. Legal may read.
- **To undo:** deactivate `legal1` and `hrhead` in «المستخدمون», deactivate the department in «الأقسام ومجلد الاستلام», and remove the grants in «الصلاحيات».
