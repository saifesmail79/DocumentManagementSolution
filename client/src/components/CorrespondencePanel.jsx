import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  CornerDownLeft,
  Mailbox,
  Plus,
  Reply,
  Search,
  Send,
  Trash2,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatDateTime } from '../format.js';
import { MODULES, visibleTabs } from '../navigation.js';
import { Button, Card, Alert, Spinner, TextField } from './ui.jsx';
import { useDialogs } from './DialogProvider.jsx';
import PaperTrail from './PaperTrail.jsx';
import { StatusChip } from '../pages/Correspondence.jsx';

/**
 * The «تسجيل وإحالة» tab of a document: its entry in the وارد/صادر register.
 *
 * Registration happens HERE, on the document, because that is where the mail
 * room is standing when the scan finishes: scan into the folder, open the
 * document, register and forward in one visit. The area's own page
 * (/correspondence) holds the queues and the books; this panel holds the one
 * letter — and says so at the top, because a tab on a document page is the one
 * place in this area with no heading of its own to tell the reader which kind of
 * work they have just stepped into.
 *
 * `onEnabled(false)` tells the page the module is off, so the tab disappears —
 * the same contract as the recognition pilot's panel.
 */

/** The registry entry this panel asks about who may open which screen. */
const CORRESPONDENCE = MODULES.find((module) => module.key === 'correspondence');

const TRANSFER_STATUS = {
  pending: 'بانتظار التسلّم',
  received: 'قيد الإجراء',
  done: 'منجزة',
  cancelled: 'ملغاة',
};

/**
 * Arabic for the refusals registration can answer with.
 *
 * `reply_to_forbidden` is deliberately its own sentence rather than folded into
 * `invalid_reply_to`: a كتاب the reader may not open is not a كتاب that went
 * wrong, and «اختر غيره» is useless advice when the fix is a permission. The
 * server tells the two apart, so this screen must too.
 */
const REGISTER_ERROR = {
  not_registrar: 'التسجيل من صلاحية قلم الوارد وحده.',
  already_registered: 'هذه الوثيقة مقيّدة في السجل بالفعل.',
  invalid_reply_to:
    'الكتاب المختار للرد لم يُعد صالحاً — يجب أن يكون كتاباً وارداً غير ملغى. اختر غيره أو أزل الربط.',
  reply_to_forbidden:
    'لا تملك صلاحية الوصول إلى هذا الكتاب، فلا يمكن ربط هذا الصادر به. اختر غيره أو أزل الربط.',
};

const BLANK_ROW = { unitId: '', purpose: 'action', dueDate: '' };

export default function CorrespondencePanel({ documentId, version = null, documentTitle, canRead, onCount, onEnabled }) {
  const { prompt, confirm } = useDialogs();
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) {
      onEnabled?.(false);
      return;
    }
    try {
      const [moduleStatus, letter] = await Promise.all([
        api.correspondence.status(),
        api.correspondence.forDocument(documentId).catch((caught) => {
          // Disabled answers 409 here while status still says so cleanly.
          if (caught instanceof ApiError && caught.code === 'correspondence_disabled') return null;
          throw caught;
        }),
      ]);
      setStatus(moduleStatus);
      setData(letter);
      onEnabled?.(moduleStatus.enabled === true);
      onCount?.(letter?.registered ? Math.max(1, letter.transfers?.length ?? 0) : 0);
    } catch (caught) {
      // A missing route means an older server: behave as if the module is off.
      if (caught instanceof ApiError && caught.status === 404) onEnabled?.(false);
      else setError('تعذر تحميل بيانات الوارد والصادر لهذه الوثيقة.');
    }
  }, [documentId, canRead, onEnabled, onCount, version]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canRead) return null;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!status || !data) return <Spinner />;
  if (!status.enabled) return null;

  if (!data.registered) {
    if (!status.registrar) {
      return (
        <div className="space-y-3">
          <AreaLine status={status} />
          <Card className="p-4 text-sm text-text-muted">
            هذه الوثيقة غير مقيّدة في سجل الوارد والصادر. التسجيل من صلاحية قلم الوارد.
          </Card>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <AreaLine status={status} />
        <RegisterForm
          documentId={documentId}
          documentTitle={documentTitle}
          units={status.units}
          onDone={load}
        />
      </div>
    );
  }

  const { letter, transfers } = data;
  const unitNames = (status.units ?? []).map((unit) => unit.name);

  async function addTransfers(rows) {
    setBusy(true);
    setError(null);
    try {
      await api.correspondence.addTransfers(letter.letterId, rows);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'already_routed_to_unit'
          ? 'الكتاب محال إلى هذا القسم بالفعل وإحالته ما تزال مفتوحة.'
          : 'تعذرت الإحالة.',
      );
    } finally {
      setBusy(false);
    }
  }

  // The reader is already standing on the letter, so the queue's gestures work
  // from here too — تسلّم and إنجاز for the unit, سحب for the mail room.
  async function actOnTransfer(action, transfer) {
    let note = null;
    if (action === 'close') {
      note = await prompt({
        title: `إنجاز الكتاب ${letter.reference}`,
        label: 'ما الذي أُنجز؟ (اختياري)',
        placeholder: 'يظهر في سجل الإحالة',
        confirmLabel: 'تسجيل الإنجاز',
      });
      if (note === null) return;
    }
    let cancelReason = null;
    if (action === 'cancel') {
      cancelReason = await prompt({
        title: `سحب الإحالة من ${transfer.unitName}`,
        message: 'تُسحب الإحالة ويمكن بعدها إحالة الكتاب إلى القسم الصحيح من هذا التبويب.',
        label: 'سبب السحب (إلزامي)',
        placeholder: 'مثال: أُحيل إلى القسم الخطأ',
        confirmLabel: 'سحب الإحالة',
        variant: 'warning',
      });
      if (cancelReason === null) return;
      if (cancelReason.trim().length < 5) {
        setError('سبب السحب إلزامي — خمسة أحرف على الأقل، ليُفهم القيد عند مراجعته لاحقاً.');
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      if (action === 'receive') await api.correspondence.receive(transfer.transferId);
      else if (action === 'close') await api.correspondence.close(transfer.transferId, note || null);
      else await api.correspondence.cancelTransfer(transfer.transferId, cancelReason.trim());
      await load();
    } catch {
      setError('تعذر تسجيل الإجراء. حدّث الصفحة وحاول مجدداً.');
    } finally {
      setBusy(false);
    }
  }

  async function annul() {
    const reason = await prompt({
      title: `إلغاء قيد الكتاب ${letter.reference}`,
      message: 'الإلغاء شطبٌ في السجل لا محوٌ منه: يبقى القيد ورقمه ويُكتب سبب الإلغاء.',
      label: 'سبب الإلغاء',
      confirmLabel: 'إلغاء القيد',
      variant: 'warning',
    });
    if (reason === null) return;
    if (reason.trim().length < 5) {
      setError('سبب الإلغاء إلزامي — خمسة أحرف على الأقل، فهو ما يُقرأ في الدفتر مكان القيد المشطوب.');
      return;
    }
    setBusy(true);
    try {
      await api.correspondence.annul(letter.letterId, reason.trim());
      await load();
    } catch {
      setError('تعذر إلغاء القيد.');
    } finally {
      setBusy(false);
    }
  }

  async function markSent() {
    const ok = await confirm({
      title: `تأشير الإرسال — ${letter.reference}`,
      message: 'يُسجَّل الكتاب الصادر مُرسلاً بعد تسليمه فعلاً للجهة الخارجية.',
      confirmLabel: 'أُرسل',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.correspondence.setStatus(letter.letterId, 'sent');
      await load();
    } catch {
      setError('تعذر تحديث الحالة.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <AreaLine status={status} />

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
            <Mailbox size={15} className="text-primary" />
            {letter.direction === 'in' ? 'وارد' : 'صادر'}
            <span className="num text-primary">{letter.reference}</span>
          </h3>
          <StatusChip status={letter.status} />
        </div>

        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <Row label="الموضوع" value={letter.subject} />
          <Row
            label={letter.direction === 'in' ? 'الجهة المرسِلة' : 'الجهة المرسَل إليها'}
            value={letter.externalParty}
          />
          <Row label="رقم الجهة" value={letter.externalRef} numeric />
          <Row label="تاريخ الكتاب" value={letter.externalDate ? formatDate(letter.externalDate) : null} numeric />
          {letter.direction === 'out' ? <Row label="القسم المصدِر" value={letter.unitName} /> : null}
          <Row label="سُجّل" value={`${formatDateTime(letter.registeredAt)} · ${letter.registeredBy ?? ''}`} numeric />
          {letter.status === 'annulled' ? <Row label="سبب الإلغاء" value={letter.annulReason} /> : null}
        </dl>

        {/*
          The other half of a conversation, in both directions.

          A reply is a core document relation, so it is one fact stored once and
          read from either end: the صادر says what it answers, the وارد says what
          answered it. Both are links, because the next thing anybody does after
          reading «أُجيب بالصادر 42/2026» is open 42/2026.
        */}
        <ReplyLinks replyTo={data.replyTo} answeredBy={data.answeredBy} />

        {status.registrar && letter.status !== 'annulled' ? (
          <div className="mt-3 flex flex-row flex-wrap gap-2 border-t border-border/60 pt-3">
            {letter.direction === 'out' && letter.status === 'registered' ? (
              <Button disabled={busy} icon={Send} onClick={markSent} className="!px-3 !py-1 text-xs">
                أُرسل
              </Button>
            ) : null}
            <Button
              variant="danger"
              disabled={busy}
              icon={XCircle}
              onClick={annul}
              className="!px-3 !py-1 text-xs"
            >
              إلغاء القيد
            </Button>
          </div>
        ) : null}
      </Card>

      {/*
        The paper itself — where it is and what was done to it.

        Drawn for anyone who may read the letter, because «where is the paper?» is
        a question a department asks as often as the mail room does. Only the
        recording buttons are gated, and by the server's own `canRecord` rather
        than by a second copy of the rule here — the holder of a transfer may act
        too, and this panel is in no position to work that out.

        `registrar` answers a different question and is passed separately: not
        «who may record» but «whose defaults may the returned-copy form fill in».
        A holding department may record, yet the paper is in its own hands — so
        it is never told on its behalf that the sheet came back to the قلم.
      */}
      <PaperTrail
        letter={letter}
        documentId={documentId}
        trail={data.trail}
        movements={data.movements}
        location={data.location}
        canRecord={data.canRecord === true && letter.status !== 'annulled'}
        names={unitNames}
        registrar={status.registrar === true}
        onChanged={load}
      />

      {letter.direction === 'in' ? (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-text">الإحالات</h3>

          {transfers.length === 0 ? (
            <p className="text-sm text-text-muted">لم يُحَل الكتاب إلى أي قسم بعد.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {transfers.map((transfer) => (
                <li key={transfer.transferId} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text">{transfer.unitName}</span>
                    {transfer.purpose === 'info' ? (
                      <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-600">
                        للاطلاع
                      </span>
                    ) : null}
                    <span className="text-[11px] text-text-muted">{TRANSFER_STATUS[transfer.status]}</span>
                    {transfer.overdue ? (
                      <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">
                        متأخّرة
                      </span>
                    ) : null}
                  </div>
                  <p className="num mt-0.5 text-xs text-text-muted">
                    أُحيل {formatDateTime(transfer.routedAt)}
                    {transfer.dueDate ? ` · الاستحقاق ${formatDate(transfer.dueDate)}` : ''}
                    {transfer.closedAt
                      ? ` · ${transfer.status === 'cancelled' ? 'سُحبت' : 'أُغلقت'} ${formatDateTime(transfer.closedAt)} (${transfer.closedBy ?? ''})`
                      : ''}
                  </p>
                  {/* The director's own words, typed where the department reads
                      them — the same note the queue shows on its card. */}
                  {transfer.note ? (
                    <p className="mt-1 whitespace-pre-line rounded border border-border bg-surface-muted/40 px-2 py-1 text-xs text-text">
                      <span className="text-text-muted">التهميش: </span>
                      {transfer.note}
                    </p>
                  ) : null}
                  {transfer.closeNote ? (
                    <p className="mt-1 text-xs text-text">
                      {transfer.status === 'cancelled' ? `سبب السحب: ${transfer.closeNote}` : transfer.closeNote}
                    </p>
                  ) : null}

                  {['pending', 'received'].includes(transfer.status)
                  && (transfer.mine || status.registrar) ? (
                    <div className="mt-2 flex flex-row flex-wrap gap-2">
                      {transfer.mine && transfer.status === 'pending' ? (
                        <Button
                          disabled={busy}
                          icon={CheckCircle2}
                          onClick={() => actOnTransfer('receive', transfer)}
                          className="!px-3 !py-1 text-xs"
                        >
                          {transfer.purpose === 'info' ? 'اطلعت عليه' : 'تسلّم'}
                        </Button>
                      ) : null}
                      {transfer.mine && transfer.purpose === 'action' ? (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => actOnTransfer('close', transfer)}
                          className="!px-3 !py-1 text-xs"
                        >
                          إنجاز
                        </Button>
                      ) : null}
                      {status.registrar ? (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          icon={Undo2}
                          onClick={() => actOnTransfer('cancel', transfer)}
                          className="!px-3 !py-1 text-xs"
                        >
                          سحب الإحالة
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {status.registrar && letter.status !== 'annulled' ? (
            <TransferRows
              // Remounted when a newer instruction arrives, so the field starts
              // from it instead of from what the clerk saw before.
              key={latestInstruction(data.trail) ?? ''}
              units={status.units}
              busy={busy}
              onSubmit={addTransfers}
              submitLabel="إحالة"
              suggestion={latestInstruction(data.trail)}
            />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Which area this tab belongs to, and the way back into it.
 *
 * A document page is shared ground — its other tabs are ordinary archive work —
 * so the one tab that registers letters says, quietly, that it is «الوارد
 * والصادر». For the mail room it also offers the book, because registering a
 * letter and then looking it up in السجل is one errand, and the alternative was
 * the tile menu.
 *
 * Who may open السجل is asked of the registry (`visibleTabs`) rather than
 * re-tested here: a link to a screen the area's own page would bounce the reader
 * out of is worse than no link.
 */
function AreaLine({ status }) {
  const mayOpenRegister = visibleTabs(CORRESPONDENCE, status ?? {})
    .some((tab) => tab.key === 'register');

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span className="flex items-center gap-1.5">
        <Mailbox size={13} />
        الوارد والصادر
      </span>
      {mayOpenRegister ? (
        // A real link: the register in a second tab beside the letter is how the
        // mail room checks a number without losing this page.
        <Link to="/correspondence?tab=register" className="text-primary hover:underline">
          فتح السجل
        </Link>
      ) : null}
    </div>
  );
}

/**
 * «رد على الوارد 12/2026» / «أُجيب بالصادر 42/2026».
 *
 * One fact, stored once by the register itself and read from either end, so the
 * two can never disagree. Both ends are links, because the next thing anybody
 * does after reading the number is open it; `?tab=correspondence` lands on the
 * other letter's register entry rather than its file.
 *
 * An annulled end is struck through, not dropped. A قيد that was cancelled is
 * still what happened — the book keeps the struck entry — so hiding the reply
 * would leave a وارد looking as though nobody had ever answered it. The «مُجاب»
 * badge, by contrast, counts only live replies, which is why a struck line here
 * with no badge there is the correct reading of one letter.
 */
function ReplyLinks({ replyTo, answeredBy }) {
  const answers = answeredBy ?? [];
  if (!replyTo && answers.length === 0) return null;

  return (
    <div className="mt-3 flex flex-row flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs">
      {replyTo ? (
        <Link
          to={`/documents/${replyTo.documentId}?tab=correspondence`}
          className={`flex items-center gap-1 text-primary hover:underline ${annulledClass(replyTo)}`}
        >
          <CornerDownLeft size={12} />
          رد على الوارد <span className="num">{replyTo.number}/{replyTo.year}</span>
          {replyTo.status === 'annulled' ? <span>(ملغى)</span> : null}
        </Link>
      ) : null}

      {answers.map((answer) => (
        <Link
          key={answer.letterId}
          to={`/documents/${answer.documentId}?tab=correspondence`}
          className={`flex items-center gap-1 text-primary hover:underline ${annulledClass(answer)}`}
        >
          <Reply size={12} />
          أُجيب بالصادر <span className="num">{answer.number}/{answer.year}</span>
          {answer.status === 'annulled' ? <span>(ملغى)</span> : null}
        </Link>
      ))}
    </div>
  );
}

/** Struck through when the قيد at the other end was cancelled, and nothing otherwise. */
function annulledClass(end) {
  return end?.status === 'annulled' ? 'line-through opacity-70' : '';
}

function Row({ label, value, numeric = false }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-text-muted">{label}:</dt>
      <dd className={`min-w-0 break-words text-text ${numeric ? 'num' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * The registration form the mail room fills right after scanning: which book,
 * what the letter says about itself, and — for a وارد — where it goes.
 */
function RegisterForm({ documentId, documentTitle, units, onDone }) {
  const [direction, setDirection] = useState('in');
  const [subject, setSubject] = useState(documentTitle ?? '');
  const [externalParty, setExternalParty] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [externalDate, setExternalDate] = useState('');
  const [unitId, setUnitId] = useState('');
  const [rows, setRows] = useState([]);
  // One instruction for every department row, not one per row: the director
  // writes «الموارد البشرية والمالية للإجراء» once across the top of the sheet,
  // and asking the clerk to retype it per department is the discipline the owner
  // was worried about.
  const [instruction, setInstruction] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [error, setError] = useState(null);
  /*
   * The reply link's own refusal, shown beside the field at fault.
   *
   * The Alert at the top of the form says the same thing, but this form is long
   * enough that «اختر غيره أو أزل الربط» can be read with the picker off screen,
   * and then it names no field at all.
   */
  const [replyProblem, setReplyProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setReplyProblem(null);
    try {
      const note = instruction.trim() || null;
      const transfers = direction === 'in'
        ? rows
            .filter((row) => row.unitId)
            .map((row) => ({
              unitId: row.unitId,
              purpose: row.purpose,
              dueDate: row.dueDate || null,
              note,
            }))
        : [];
      await api.correspondence.register({
        documentId,
        direction,
        subject,
        externalParty: externalParty || null,
        externalRef: externalRef || null,
        externalDate: externalDate || null,
        unitId: direction === 'out' && unitId ? unitId : null,
        replyToLetterId: direction === 'out' && replyTo ? replyTo.letterId : null,
        transfers,
      });
      onDone();
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      setError(REGISTER_ERROR[code] ?? 'تعذر التسجيل. تأكد من الحقول وحاول مجدداً.');
      // Both reply refusals point at one field, and they are different facts:
      // «that كتاب is not a valid target» versus «that كتاب is not yours to
      // read». Telling them apart is the difference between picking another
      // letter and asking the administrator for access.
      if (code === 'invalid_reply_to' || code === 'reply_to_forbidden') {
        setReplyProblem(REGISTER_ERROR[code]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <Mailbox size={15} className="text-primary" />
        تسجيل في الوارد والصادر
      </h3>

      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex flex-row flex-wrap gap-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">الدفتر</span>
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              className="rounded-lg border border-border bg-control px-3 py-2 text-sm text-text"
            >
              <option value="in">وارد</option>
              <option value="out">صادر</option>
            </select>
          </label>
          {direction === 'out' ? (
            <label className="block min-w-48">
              <span className="mb-1.5 block text-sm font-medium text-text">القسم المصدِر</span>
              <select
                value={unitId}
                onChange={(event) => setUnitId(event.target.value)}
                className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text"
              >
                <option value="">—</option>
                {units.map((unit) => (
                  <option key={unit.unitId} value={unit.unitId}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <TextField
          label="الموضوع"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          required
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField
            label={direction === 'in' ? 'الجهة المرسِلة' : 'الجهة المرسَل إليها'}
            value={externalParty}
            onChange={(event) => setExternalParty(event.target.value)}
          />
          <TextField
            label="رقم كتاب الجهة"
            value={externalRef}
            onChange={(event) => setExternalRef(event.target.value)}
          />
          <TextField
            label="تاريخ كتاب الجهة"
            type="date"
            dir="ltr"
            value={externalDate}
            onChange={(event) => setExternalDate(event.target.value)}
          />
        </div>

        {direction === 'out' ? (
          <div className="border-t border-border/60 pt-3">
            <ReplyToPicker
              value={replyTo}
              onChange={(picked) => {
                setReplyProblem(null);
                setReplyTo(picked);
              }}
              problem={replyProblem}
            />
          </div>
        ) : null}

        {direction === 'in' ? (
          <div className="border-t border-border/60 pt-3">
            <span className="mb-1.5 block text-sm font-medium text-text">الإحالة إلى الأقسام</span>
            {/* Above the rows, because that is where it is on the paper and
                because it applies to all of them. */}
            <InstructionField value={instruction} onChange={setInstruction} />
            <TransferRowsEditor units={units} rows={rows} onChange={setRows} />
            <p className="mt-1 text-xs text-text-muted">
              يمكن التسجيل دون إحالة وإحالته لاحقاً من هذا التبويب نفسه.
            </p>
          </div>
        ) : null}

        <Button type="submit" disabled={busy || !subject.trim()}>
          تسجيل {direction === 'in' ? 'الوارد' : 'الصادر'}
        </Button>
      </form>
    </Card>
  );
}

/** Editable (unit, purpose, due date) rows shared by registration and later forwarding. */
function TransferRowsEditor({ units, rows, onChange }) {
  function update(index, patch) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        // Index keys are safe here: rows are only appended and removed, never reordered.
        <div key={index} className="flex flex-row flex-wrap items-center gap-2">
          <select
            value={row.unitId}
            onChange={(event) => update(index, { unitId: event.target.value })}
            className="min-w-40 rounded-lg border border-border bg-control px-2 py-1.5 text-sm text-text"
          >
            <option value="">اختر القسم…</option>
            {units.map((unit) => (
              <option key={unit.unitId} value={unit.unitId}>
                {unit.name}
              </option>
            ))}
          </select>
          <select
            value={row.purpose}
            onChange={(event) => update(index, { purpose: event.target.value })}
            className="rounded-lg border border-border bg-control px-2 py-1.5 text-sm text-text"
          >
            <option value="action">للإجراء</option>
            <option value="info">للاطلاع</option>
          </select>
          <input
            type="date"
            dir="ltr"
            value={row.dueDate}
            onChange={(event) => update(index, { dueDate: event.target.value })}
            className="rounded-lg border border-border bg-control px-2 py-1.5 text-sm text-text"
            title="تاريخ الاستحقاق (اختياري)"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="text-text-muted hover:text-red-600"
            title="إزالة"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { ...BLANK_ROW }])}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Plus size={13} />
        إضافة قسم
      </button>
    </div>
  );
}

/**
 * The words of the newest «تهميش» in the paper trail, if it has any.
 *
 * The head has already written them — on paper and filed, or on the screen —
 * so the clerk forwarding the letter starts from them instead of retyping.
 */
function latestInstruction(trail) {
  const found = [...(trail ?? [])]
    .reverse()
    .find((entry) => entry.action === 'instruction' && entry.note?.trim());
  return found ? found.note.trim() : null;
}

/** The standalone forward control shown under an already-registered letter. */
function TransferRows({ units, busy, onSubmit, submitLabel, suggestion = null }) {
  const [rows, setRows] = useState([]);
  const [instruction, setInstruction] = useState(suggestion ?? '');

  const ready = rows.filter((row) => row.unitId);

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <span className="mb-1.5 block text-sm font-medium text-text">إحالة إلى أقسام أخرى</span>
      {/* The same one-instruction-for-all-rows rule as at registration: a letter
          that comes back with a changed «تهميش» is forwarded again with the new
          words, written once. */}
      <InstructionField value={instruction} onChange={setInstruction} />
      {suggestion && instruction === suggestion ? (
        <p className="-mt-1 mb-2 text-xs text-text-muted">مأخوذ من آخر تهميش في مسار الورقة — عدّله إن لزم.</p>
      ) : null}
      <TransferRowsEditor units={units} rows={rows} onChange={setRows} />
      {ready.length > 0 ? (
        <Button
          disabled={busy}
          onClick={async () => {
            const note = instruction.trim() || null;
            await onSubmit(
              ready.map((row) => ({
                unitId: row.unitId,
                purpose: row.purpose,
                dueDate: row.dueDate || null,
                note,
              })),
            );
            setRows([]);
            setInstruction(suggestion ?? '');
          }}
          className="mt-2 !px-3 !py-1 text-xs"
        >
          {submitLabel}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * «نص التهميش» — the director's instruction, typed where departments read it.
 *
 * The column it is stored in has existed since the register was built and the
 * queue has always displayed it; nothing ever wrote it, so every department read
 * the letter and guessed at what was wanted. This field is the whole fix.
 */
function InstructionField({ value, onChange }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1.5 block text-sm font-medium text-text">نص التهميش (اختياري)</span>
      <textarea
        dir="rtl"
        rows={2}
        maxLength={1000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="مثال: الموارد البشرية للإجراء والمالية للاطلاع"
        className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
          placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      <span className="mt-1 block text-xs text-text-muted">
        يُكتب مرة واحدة ويُرفق بكل قسم تُحال إليه هذه المرة، ويظهر في «الوارد إليّ» عند القسم.
      </span>
    </label>
  );
}

/**
 * «رد على» — which وارد this صادر answers.
 *
 * Searched rather than listed: the book runs to hundreds of letters a year and
 * the clerk already knows the number or a word of the subject. The search is the
 * register's own query with `direction: 'in'`, so what is offered here is exactly
 * what the book would show — no second definition of "an incoming letter".
 */
function ReplyToPicker({ value, onChange, problem = null }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults(null);
      return undefined;
    }
    // One request per thought rather than one per keystroke, as the queue does.
    const timer = setTimeout(async () => {
      try {
        const found = await api.correspondence.letters({ direction: 'in', q: text });
        setResults((found.letters ?? []).filter((letter) => letter.status !== 'annulled'));
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  if (value) {
    return (
      <div>
        <span className="mb-1.5 block text-sm font-medium text-text">رد على</span>
        <div className="flex flex-row flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-sm">
          <span className="num font-semibold text-primary">وارد {value.reference}</span>
          <span className="min-w-0 flex-1 truncate text-text">{value.subject}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            title="إزالة الربط"
            className="shrink-0 text-text-muted hover:text-red-600"
          >
            <X size={14} />
          </button>
        </div>
        {problem ? <p className="mt-1 text-xs text-red-600">{problem}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <TextField
        label="رد على كتاب وارد (اختياري)"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="رقم الكتاب الوارد أو كلمة من موضوعه"
        hint="اتركه فارغاً إذا لم يكن هذا الصادر رداً على كتاب مسجّل."
      />

      {problem ? <p className="mt-1 text-xs text-red-600">{problem}</p> : null}

      {results === null ? null : results.length === 0 ? (
        <p className="mt-1 text-xs text-text-muted">لا كتب واردة مطابقة.</p>
      ) : (
        <ul className="mt-1 max-h-40 divide-y divide-border/50 overflow-y-auto rounded-lg border border-border">
          {results.slice(0, 20).map((letter) => (
            <li key={letter.letterId}>
              <button
                type="button"
                onClick={() => onChange(letter)}
                className="flex w-full flex-row items-center gap-2 px-3 py-1.5 text-right text-xs hover:bg-surface-muted/40"
              >
                <Search size={12} className="shrink-0 text-text-muted" />
                <span className="num shrink-0 font-semibold text-primary">{letter.reference}</span>
                <span className="min-w-0 flex-1 truncate text-text">{letter.subject}</span>
                {letter.externalParty ? (
                  <span className="shrink-0 truncate text-text-muted">{letter.externalParty}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
