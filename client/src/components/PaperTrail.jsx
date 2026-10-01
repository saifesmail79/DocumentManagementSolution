import { useId, useState } from 'react';
import {
  CopyPlus,
  FileText,
  Footprints,
  Inbox,
  MapPin,
  PenLine,
  ScanLine,
  Send,
  Stamp,
  Undo2,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDateTime } from '../format.js';
import { Alert, Button, Card, TextField } from './ui.jsx';
import { Modal } from './Modal.jsx';
import { useDialogs } from './DialogProvider.jsx';
import LetterCopyDialog, { COPY_ACTIONS, describePartialSave } from './LetterCopyDialog.jsx';

/**
 * «مسار الورقة» — one letter's sheet of paper, and everywhere it has been.
 *
 * ─── Why one list and not two ───────────────────────────────────────────────
 *
 * The register already knows two different things about a letter: which copies
 * of the paper were filed (each a version of the document) and where the paper
 * physically went. Shown as two lists they have to be read against each other to
 * answer the only question anybody actually asks — «where is it now, and what
 * happened to it on the way?» — so they are merged by time into the one reading
 * a clerk standing at a counter can follow top to bottom.
 *
 * ─── Why the chip is above the list ─────────────────────────────────────────
 *
 * "Where is the paper" is urgent and "what was done to it" is history. The chip
 * answers the urgent question in one line without reading anything, which is
 * what someone on the telephone needs.
 *
 * Nothing here is drawn for a reader who cannot record: `canRecord` is the
 * server's answer — the mail room, or a department currently holding a transfer
 * — and it is asked rather than re-derived, so this panel and the route cannot
 * disagree about who may act.
 *
 * @param {object} props
 * @param {{letterId: string, reference: string, subject?: string}} props.letter
 * @param {string} props.documentId
 * @param {Array} [props.trail] Versions, each named by the action done on the paper.
 * @param {Array} [props.movements] Hand-offs and returns, oldest first.
 * @param {{state: 'out'|'in', personName?: string, since?: string}|null} [props.location]
 * @param {boolean} [props.canRecord]
 * @param {string[]} [props.names] Unit names, offered as suggestions beside the recent holders.
 * @param {boolean} [props.registrar] True for the mail room — it alone gets the copy dialog's defaults.
 * @param {Function} props.onChanged
 */

/** The trail's vocabulary: «كما ورد» plus the four a returning sheet can carry. */
const ACTION_LABEL = {
  received: 'كما ورد',
  ...Object.fromEntries(COPY_ACTIONS.map((entry) => [entry.value, entry.label])),
};

const ACTION_ICON = {
  received: Inbox,
  instruction: PenLine,
  endorsement: Stamp,
  rescan: ScanLine,
  other: FileText,
};

const MOVE_ERROR = {
  not_found: 'لم يُعد الكتاب موجوداً، أو لا تملك صلاحية الوصول إليه.',
  annulled: 'قيد هذا الكتاب ملغى، فلا تُسجَّل عليه حركات.',
  not_allowed: 'لا تملك صلاحية تسجيل حركة الورقة لهذا الكتاب.',
  invalid_kind: 'نوع الحركة غير صالح.',
  person_required: 'اكتب اسم من سُلّمت إليه الورقة.',
  correspondence_disabled: 'أُوقفت وحدة الوارد والصادر من الإعدادات، فلم يُحفظ شيء.',
};

/**
 * The note's ceiling, in one place.
 *
 * It matches `correspondence_movements.note` exactly — the column takes 1000
 * characters and the service truncates at the same number — so what this field
 * accepts is what the custody log keeps. The field used to accept twice the
 * column, which cut a long note off mid-word with no word said to anybody.
 */
const NOTE_LIMIT = 1000;

function describeMoveFailure(caught) {
  if (!(caught instanceof ApiError)) {
    return 'تعذر الاتصال بالخادم، فلم تُسجَّل الحركة.';
  }
  return (
    MOVE_ERROR[caught.code]
    ?? `تعذر تسجيل حركة الورقة${caught.code ? ` (${caught.code})` : ''}. حاول مجدداً.`
  );
}

/**
 * Both kinds of entry on one timeline.
 *
 * Sorted by the moment each was recorded, with a version placed before a
 * movement that shares its moment: adding a returned copy and recording the
 * return are one action by the clerk, and «تهميش» then «عادت الورقة» is the order
 * the two halves happened in.
 */
function merge(trail, movements) {
  const entries = [
    ...(trail ?? []).map((item) => ({ ...item, type: 'version' })),
    ...(movements ?? []).map((item) => ({ ...item, type: 'movement' })),
  ];

  return entries.sort((left, right) => {
    const at = new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime();
    if (at !== 0) return at;
    if (left.type === right.type) return 0;
    return left.type === 'version' ? -1 : 1;
  });
}

export default function PaperTrail({
  letter,
  documentId,
  trail,
  movements,
  location,
  canRecord = false,
  names = [],
  registrar = false,
  onChanged,
}) {
  const { confirm } = useDialogs();
  const [copying, setCopying] = useState(false);
  const [handing, setHanding] = useState(false);
  const [error, setError] = useState(null);
  /*
   * «the copy is filed, but part of it was not recorded».
   *
   * Kept on the panel rather than inside the dialog because the dialog closes:
   * the scan is committed, so holding the form open would invite a second scan
   * of the same sheet. The sentence has to outlive the dialog to be read at all.
   */
  const [warning, setWarning] = useState(null);
  const [busy, setBusy] = useState(false);

  const out = location?.state === 'out';
  const entries = merge(trail, movements);

  /*
   * Whoever the paper has been with before, offered beside the unit names: the
   * same three or four people sign a year's worth of letters, and typing a name
   * by hand every time is the discipline the owner was worried about.
   */
  const suggestions = [
    ...new Set([...(movements ?? []).map((move) => move.personName), ...names].filter(Boolean)),
  ];

  async function move(payload) {
    setBusy(true);
    setError(null);
    try {
      await api.correspondence.move(letter.letterId, payload);
      setHanding(false);
      onChanged?.();
      return true;
    } catch (caught) {
      setError(describeMoveFailure(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function takeBack() {
    const ok = await confirm({
      title: `استلام الورقة — ${letter.reference}`,
      message: location?.personName
        ? `تُسجَّل عودة الورقة من ${location.personName} إلى القلم.`
        : 'تُسجَّل عودة الورقة إلى القلم.',
      confirmLabel: 'عادت إلى القلم',
    });
    if (!ok) return;
    await move({ kind: 'back', personName: location?.personName ?? null });
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
          <Footprints size={15} className="text-primary" />
          مسار الورقة
        </h3>
        <LocationChip location={location} />
      </div>

      {/* Hidden while the hand-over dialog is open: there the dialog's own copy
          of this sentence is the readable one, and this card sits under the
          modal's scrim. */}
      {error && !handing ? (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {warning ? (
        <div className="mt-3">
          <Alert tone="warning">{warning}</Alert>
        </div>
      ) : null}

      {canRecord ? (
        <div className="mt-3 flex flex-row flex-wrap gap-2">
          <Button
            icon={CopyPlus}
            disabled={busy}
            onClick={() => {
              // A warning belongs to the save that earned it.
              setWarning(null);
              setCopying(true);
            }}
            className="!px-3 !py-1 text-xs"
          >
            إضافة نسخة معادة
          </Button>
          <Button
            variant="secondary"
            icon={Send}
            disabled={busy}
            onClick={() => setHanding(true)}
            className="!px-3 !py-1 text-xs"
          >
            تسليم الورقة
          </Button>
          {/* Only while the paper is out: there is nothing to receive otherwise. */}
          {out ? (
            <Button
              variant="secondary"
              icon={Undo2}
              disabled={busy}
              onClick={takeBack}
              className="!px-3 !py-1 text-xs"
            >
              استلام الورقة
            </Button>
          ) : null}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          لا حركات ولا نسخ مسجّلة على هذه الورقة بعد.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((entry) => (
            <TrailEntry
              key={entry.type === 'version' ? `v${entry.versionNumber}` : `m${entry.movementId}`}
              entry={entry}
              documentId={documentId}
            />
          ))}
        </ul>
      )}

      {copying ? (
        <LetterCopyDialog
          letter={letter}
          location={location}
          names={suggestions}
          registrar={registrar}
          onClose={() => setCopying(false)}
          onDone={(saved) => {
            setCopying(false);
            setWarning(describePartialSave(saved));
            onChanged?.();
          }}
        />
      ) : null}

      {handing ? (
        <HandOverDialog
          letter={letter}
          names={suggestions}
          busy={busy}
          error={error}
          onClose={() => {
            setHanding(false);
            // A refusal belongs to the attempt that earned it: left standing it
            // would greet the next person who opens this dialog.
            setError(null);
          }}
          onSubmit={(payload) => move({ kind: 'out', ...payload })}
        />
      ) : null}
    </Card>
  );
}

/** Where the paper is, in one line — the answer somebody on the telephone wants. */
function LocationChip({ location }) {
  if (location?.state === 'out') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-600">
        <MapPin size={11} />
        الورقة مع {location.personName ?? 'جهة غير مسمّاة'}
        {location.since ? <span className="num">منذ {formatDateTime(location.since)}</span> : null}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] text-text-muted">
      <MapPin size={11} />
      الورقة في القلم
    </span>
  );
}

function describeIcon(entry) {
  if (entry.type === 'version') return ACTION_ICON[entry.action] ?? FileText;
  return entry.kind === 'out' ? Send : Undo2;
}

/**
 * An unknown code is printed rather than hidden.
 *
 * A server that grows a fifth action before this screen knows about it should
 * show the raw word — a blank line in a paper trail is worse than an untranslated
 * one, because only the blank line is invisible to the person reading it.
 */
function describeLabel(entry) {
  if (entry.type === 'version') return ACTION_LABEL[entry.action] ?? entry.action;
  const who = entry.personName ?? 'جهة غير مسمّاة';
  return entry.kind === 'out' ? `سُلّمت إلى ${who}` : `عادت من ${who}`;
}

/** One line of the timeline: a filed copy, or a hand-off. */
function TrailEntry({ entry, documentId }) {
  const isVersion = entry.type === 'version';
  const Icon = describeIcon(entry);
  const label = describeLabel(entry);

  return (
    <li className="rounded-lg border border-border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Icon size={13} className="shrink-0 text-primary" />
        <span className="font-medium text-text">{label}</span>
        {isVersion && entry.personName ? (
          <span className="text-text">— {entry.personName}</span>
        ) : null}
        {isVersion ? (
          <span className="num text-text-muted">إصدار {entry.versionNumber}</span>
        ) : null}
        <span className="num ms-auto text-text-muted">{formatDateTime(entry.recordedAt)}</span>
      </div>

      {entry.note ? <p className="mt-1 whitespace-pre-line text-text">{entry.note}</p> : null}

      <div className="mt-1 flex flex-row flex-wrap items-center gap-2 text-text-muted">
        {entry.recordedBy ? <span>سجّلها {entry.recordedBy}</span> : null}
        {/* The same link the الإصدارات tab uses — one path to a version's bytes. */}
        {isVersion ? (
          <a
            href={api.contentUrl(documentId, entry.versionNumber)}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            فتح هذه النسخة
          </a>
        ) : null}
      </div>
    </li>
  );
}

/**
 * «سُلّمت الورقة إلى …».
 *
 * A name and nothing else is required, because that is the whole record: the
 * person who took the paper away. Free text for the same reason the copy dialog
 * uses it — the director is not a user of this system.
 */
function HandOverDialog({ letter, names, busy, error, onClose, onSubmit }) {
  const listId = useId();
  const [personName, setPersonName] = useState('');
  const [note, setNote] = useState('');

  const ready = personName.trim().length > 0;
  // Counted only once the note is nearly full: a counter beside an empty field
  // is noise, and running into the ceiling unawares is what it exists to stop.
  const nearFull = note.length >= NOTE_LIMIT * 0.8;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      icon={Send}
      size="sm"
      title="تسليم الورقة"
      subtitle={`كتاب ${letter.reference}`}
      footer={
        <>
          <Button
            disabled={busy || !ready}
            onClick={() => onSubmit({ personName: personName.trim(), note: note.trim() || null })}
          >
            {busy ? 'جارٍ التسجيل…' : 'تسجيل التسليم'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* Inside the dialog, because the panel's own Alert is behind this
            modal's scrim: a refusal rendered out there cannot be read, so the
            clerk sees the button re-enable and presses «تسجيل التسليم» again. */}
        {error ? <Alert tone="error">{error}</Alert> : null}

        <TextField
          label="سُلّمت الورقة إلى"
          list={listId}
          maxLength={200}
          value={personName}
          onChange={(event) => setPersonName(event.target.value)}
          placeholder="اسم الشخص أو الجهة"
          required
        />
        <datalist id={listId}>
          {names.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">ملاحظة (اختياري)</span>
          <textarea
            dir="rtl"
            rows={2}
            maxLength={NOTE_LIMIT}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="مثال: للتهميش ثم الإعادة"
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
              placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {nearFull ? (
            <span className="mt-1 block text-xs text-text-muted">
              بقي <span className="num">{NOTE_LIMIT - note.length}</span> حرفاً من
              {' '}
              <span className="num">{NOTE_LIMIT}</span>
            </span>
          ) : null}
        </label>
      </div>
    </Modal>
  );
}
