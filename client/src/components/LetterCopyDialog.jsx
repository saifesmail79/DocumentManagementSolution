import { useId, useRef, useState } from 'react';
import { CopyPlus, FileText, Upload } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { Alert, Button, TextField } from './ui.jsx';
import { Modal } from './Modal.jsx';
import ScanPanel from './ScanPanel.jsx';

/**
 * Adding the paper back, after it travelled.
 *
 * ─── Why this is a version and not a letter ─────────────────────────────────
 *
 * A letter is registered once and carries one number for life. Everything that
 * happens to the sheet afterwards — the deputy's initials, the director's
 * «تهميش», a rescan because the first pass was crooked — happens to the SAME
 * letter, so each returning copy is a new version of the document that was
 * registered, never a second registration. That is the whole reason this dialog
 * exists rather than sending the clerk back to «تسجيل كتاب»: the front door
 * draws a number, and a returning sheet must not be given one.
 *
 * ─── Why every field has a default ──────────────────────────────────────────
 *
 * The owner's own objection to this feature was that it «requires very high
 * discipline from Zainab». So nothing here is required beyond the file: the
 * action starts at «تهميش» because that is what comes back from the director's
 * office, the person starts as whoever the paper was last handed to, and the
 * return is recorded in the same step rather than as a second errand the clerk
 * has to remember. A clerk who presses save without reading anything still
 * records something truthful.
 *
 * ─── Why those defaults belong to the mail room alone ───────────────────────
 *
 * Each default is a statement about the paper: «it came back to the قلم» and
 * «the last holder is who acted on it». Both are true when the mail room is
 * typing. Both are false when the department that was HOLDING the sheet types:
 * the paper is in its own hands, not back at the counter, and the name the
 * custody log offers is that department itself. So a holder starts from nothing
 * and states what happened — the checkbox is still offered, because a
 * department may be handing the sheet back in the same gesture, but it is never
 * ticked on its behalf.
 *
 * @param {object} props
 * @param {{letterId: string, reference: string, subject?: string}} props.letter
 * @param {{state: 'out'|'in', personName?: string, since?: string}|null} [props.location]
 * @param {string[]} [props.names] Suggestions for the person field — unit names and recent movements.
 * @param {boolean} [props.registrar] True only for the mail room, which owns the defaults below.
 * @param {Function} props.onClose
 * @param {Function} props.onDone Called with the server's answer after the copy was filed, so the
 *   caller can both reload AND say what did not land — see describePartialSave.
 */

/**
 * The four actions a RETURNING sheet can carry.
 *
 * «كما ورد» is deliberately absent: it is recorded by the register itself when
 * an incoming letter is first filed, and is the one action nobody can perform on
 * a paper that has already travelled. Exported because the trail reads the same
 * words back out, and two copies of this vocabulary would eventually disagree.
 */
export const COPY_ACTIONS = [
  { value: 'instruction', label: 'تهميش' },
  { value: 'endorsement', label: 'توقيع أو تأشير' },
  { value: 'rescan', label: 'إعادة مسح' },
  { value: 'other', label: 'أخرى' },
];

/**
 * Arabic for every refusal the contract names.
 *
 * The core version mechanism does the filing, so its own reasons arrive here
 * unchanged — a legal hold, a checked-out document, a blocked extension. Each is
 * answered in the vocabulary of THIS screen («لا يمكن إضافة نسخة») rather than
 * the generic one, because the reader is holding a sheet of paper and needs to
 * know whether to put it down or fetch somebody.
 */
const COPY_ERROR = {
  invalid_letter_id: 'معرّف الكتاب غير صالح. أعد فتح الكتاب من السجل وحاول مجدداً.',
  not_found: 'لم يُعد الكتاب موجوداً، أو لا تملك صلاحية الوصول إليه.',
  annulled: 'قيد هذا الكتاب ملغى، فلا تُضاف إليه نسخ.',
  not_allowed:
    'لا تملك صلاحية إضافة نسخة لهذا الكتاب. النسخ يضيفها قلم الوارد أو القسم المحال إليه الكتاب.',
  invalid_action: 'نوع الإجراء غير صالح. اختر أحد الإجراءات المعروضة.',
  correspondence_disabled: 'أُوقفت وحدة الوارد والصادر من الإعدادات، فلم يُحفظ شيء.',
  forbidden: 'يلزم لإضافة نسخة صلاحية الرفع على مجلد هذا الكتاب. راجع مدير النظام.',
  legal_hold: 'الوثيقة تحت حجز قانوني: لا يُضاف إليها إصدار جديد، والنسخة إصدار جديد.',
  locked: 'الوثيقة مسحوبة للتعديل لدى شخص آخر. تُضاف النسخة بعد إعادتها.',
  multi_file_document: 'هذه وثيقة متعددة الملفات، ولا تُضاف إليها إصدارات.',
  blocked_extension: 'صيغة الملف غير مسموح بها في إعدادات الرفع. راجع مدير النظام.',
  too_large: 'حجم الملف يتجاوز الحد المسموح.',
  empty_file: 'الملف فارغ.',
  no_file: 'لم يصل أي ملف. اختر ملفاً أو امسح الكتاب.',
  storage_failed: 'تعذّر الكتابة إلى وحدة التخزين — راجع مدير النظام.',
  person_required: 'اكتب اسم من كانت الورقة عنده.',
};

/**
 * What was saved and what was not, in one sentence — or null when all of it landed.
 *
 * The route answers 201 as soon as the version is committed, because it IS
 * committed: the trail row and the «عادت الورقة» movement are written after it
 * and are allowed to fail without undoing the scan. Those flags are the only
 * record of such a failure, so discarding them leaves a copy filed with no entry
 * in مسار الورقة and nobody aware of it. Exported because the two screens that
 * file a copy — the document's trail and the intake card — must say the same
 * thing about the same half-landed save.
 */
export function describePartialSave(saved) {
  const trailLost = saved?.trail === false;
  const moveLost = saved?.movementFailed === true;
  if (!trailLost && !moveLost) return null;

  const head = 'حُفظت النسخة إصداراً جديداً للكتاب';
  if (trailLost && moveLost) {
    return `${head}، لكن لم يُسجَّل الإجراء في مسار الورقة ولم تُسجَّل عودة الورقة إلى القلم.`
      + ' سجّل العودة بزر «استلام الورقة»، وراجع مدير النظام بشأن المسار.';
  }
  if (trailLost) {
    return `${head}، لكن تعذّر تسجيل الإجراء في مسار الورقة، فلن تظهر هذه النسخة في المسار.`
      + ' النسخة نفسها محفوظة في إصدارات الوثيقة — راجع مدير النظام.';
  }
  return `${head}، لكن لم تُسجَّل عودة الورقة إلى القلم — ما تزال الورقة مسجّلة خارجه.`
    + ' سجّل العودة بزر «استلام الورقة».';
}

function describeCopyFailure(caught) {
  if (!(caught instanceof ApiError)) {
    return 'تعذر الاتصال بالخادم، فلم تُحفظ النسخة. تحقق من الاتصال وحاول مجدداً.';
  }
  // 413 never reaches our code — the route's own body limit refuses it first —
  // so it arrives with no reason of ours, and the size sentence is the useful one.
  if (caught.status === 413) return COPY_ERROR.too_large;
  return (
    COPY_ERROR[caught.code]
    ?? `تعذر حفظ النسخة${caught.code ? ` (${caught.code})` : ''}. حاول مجدداً.`
  );
}

export default function LetterCopyDialog({
  letter,
  location,
  names = [],
  registrar = false,
  onClose,
  onDone,
}) {
  const listId = useId();
  const fileInput = useRef(null);
  const out = location?.state === 'out';
  // The one condition under which this form may answer for the reader: see «Why
  // those defaults belong to the mail room alone» above.
  const prefilled = registrar && out;

  const [file, setFile] = useState(null);
  const [source, setSource] = useState('file');
  const [action, setAction] = useState('instruction');
  const [personName, setPersonName] = useState(prefilled ? location?.personName ?? '' : '');
  const [note, setNote] = useState('');
  // Checked by default only while the MAIL ROOM has the paper out: the sheet is
  // in the clerk's hand as she types, so the common case is that it came back
  // with the copy. A holder's copy says nothing about the sheet's return.
  const [returned, setReturned] = useState(prefilled);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Deduplicated, because the holder's name is usually also a unit name and the
  // browser would otherwise offer it twice.
  const suggestions = [...new Set(names.filter(Boolean))];

  async function save() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.correspondence.addCopy(letter.letterId, file, {
        action,
        personName: personName.trim() || undefined,
        note: note.trim() || undefined,
        returned: out && returned,
      });
      /*
       * The answer is handed up rather than thrown away.
       *
       * A 201 does not mean every part landed, and the caller is the one place
       * that can still say so after this dialog is gone. It closes either way:
       * the scan IS filed, and a form left open on a filed copy is an invitation
       * to scan the same sheet twice.
       */
      onDone?.(saved);
    } catch (caught) {
      setError(describeCopyFailure(caught));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      icon={CopyPlus}
      title="إضافة نسخة معادة"
      subtitle={`كتاب ${letter.reference}${letter.subject ? ` — ${letter.subject}` : ''}`}
      footer={
        <>
          <Button disabled={busy || !file} onClick={save}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ النسخة'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <p className="text-xs text-text-muted">
          تُحفظ النسخة إصداراً جديداً للكتاب نفسه — لا يُسحب رقم جديد ولا يُنشأ قيد ثانٍ.
        </p>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-text">مصدر النسخة</span>
          <div className="flex flex-row flex-wrap gap-2">
            <Button
              variant={source === 'file' ? 'primary' : 'secondary'}
              icon={Upload}
              disabled={busy}
              onClick={() => setSource('file')}
              className="!px-3 !py-1 text-xs"
            >
              ملف من القرص
            </Button>
            <Button
              variant={source === 'scan' ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => setSource('scan')}
              className="!px-3 !py-1 text-xs"
            >
              مسح ضوئي
            </Button>
          </div>
        </div>

        {source === 'file' ? (
          <div className="flex flex-row flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon={Upload}
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="!px-3 !py-1 text-xs"
            >
              اختيار ملف
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) setFile(picked);
                event.target.value = '';
              }}
            />
          </div>
        ) : (
          // The hand-off form: the panel assembles the PDF and gives it here
          // rather than filing it into a folder, because this copy's destination
          // is a version of a document that already exists.
          <ScanPanel onScanned={(produced) => setFile(produced)} />
        )}

        {file ? (
          <p className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs text-text">
            <FileText size={14} className="shrink-0 text-primary" />
            <span className="min-w-0 truncate">{file.name}</span>
          </p>
        ) : null}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">ما الذي جرى على الورقة؟</span>
          <select
            value={action}
            onChange={(event) => setAction(event.target.value)}
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
              focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {COPY_ACTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        {/* Free text, not a user picker: the director who writes the «تهميش» need
            not have an account, and in most institutes he does not have one. */}
        <TextField
          label="من قام بالإجراء (اختياري)"
          list={listId}
          maxLength={200}
          value={personName}
          onChange={(event) => setPersonName(event.target.value)}
          placeholder="مثال: د. حسين — مدير المعهد"
          hint={
            location?.personName
              ? prefilled
                ? `الورقة مسلّمة إلى ${location.personName} — عُدّل الاسم إن قام بها غيره.`
                : `الورقة مسلّمة إلى ${location.personName} — اكتب من قام بالإجراء على الورقة.`
              : undefined
          }
        />
        <datalist id={listId}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">ملاحظة (اختياري)</span>
          <textarea
            dir="rtl"
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="يظهر في مسار الورقة وفي سجل إصدارات الوثيقة"
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
              placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>

        {/* Offered only while the paper is out, because there is nothing to come
            back from otherwise — and a checkbox that cannot be true is noise. */}
        {out ? (
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={returned}
              onChange={(event) => setReturned(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            الورقة عادت إلى القلم
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
