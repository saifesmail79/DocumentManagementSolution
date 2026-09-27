import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Mailbox, Plus, Send, Trash2, Undo2, XCircle } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatDateTime } from '../format.js';
import { Button, Card, Alert, Spinner, TextField } from './ui.jsx';
import { useDialogs } from './DialogProvider.jsx';
import { StatusChip } from '../pages/Correspondence.jsx';

/**
 * The «المراسلة» tab of a document: its entry in the وارد/صادر register.
 *
 * Registration happens HERE, on the document, because that is where the mail
 * room is standing when the scan finishes: scan into the folder, open the
 * document, register and forward in one visit. The module page holds the
 * queues and the book; this panel holds the one letter.
 *
 * `onEnabled(false)` tells the page the module is off, so the tab disappears —
 * the same contract as the recognition pilot's panel.
 */

const TRANSFER_STATUS = {
  pending: 'بانتظار التسلّم',
  received: 'قيد الإجراء',
  done: 'منجزة',
  cancelled: 'ملغاة',
};

const BLANK_ROW = { unitId: '', purpose: 'action', dueDate: '' };

export default function CorrespondencePanel({ documentId, documentTitle, canRead, onCount, onEnabled }) {
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
      else setError('تعذر تحميل بيانات المراسلة.');
    }
  }, [documentId, canRead, onEnabled, onCount]);

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
        <Card className="p-4 text-sm text-text-muted">
          هذه الوثيقة غير مقيّدة في سجل الوارد والصادر. التسجيل من صلاحية قلم الوارد.
        </Card>
      );
    }
    return (
      <RegisterForm
        documentId={documentId}
        documentTitle={documentTitle}
        units={status.units}
        onDone={load}
      />
    );
  }

  const { letter, transfers } = data;

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
            <TransferRows units={status.units} busy={busy} onSubmit={addTransfers} submitLabel="إحالة" />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
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
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const transfers = direction === 'in'
        ? rows
            .filter((row) => row.unitId)
            .map((row) => ({
              unitId: row.unitId,
              purpose: row.purpose,
              dueDate: row.dueDate || null,
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
        transfers,
      });
      onDone();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'not_registrar'
          ? 'التسجيل من صلاحية قلم الوارد وحده.'
          : caught instanceof ApiError && caught.code === 'already_registered'
            ? 'هذه الوثيقة مقيّدة في السجل بالفعل.'
            : 'تعذر التسجيل. تأكد من الحقول وحاول مجدداً.',
      );
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

        {direction === 'in' ? (
          <div className="border-t border-border/60 pt-3">
            <span className="mb-1.5 block text-sm font-medium text-text">الإحالة إلى الأقسام</span>
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

/** The standalone forward control shown under an already-registered letter. */
function TransferRows({ units, busy, onSubmit, submitLabel }) {
  const [rows, setRows] = useState([]);

  const ready = rows.filter((row) => row.unitId);

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <span className="mb-1.5 block text-sm font-medium text-text">إحالة إلى أقسام أخرى</span>
      <TransferRowsEditor units={units} rows={rows} onChange={setRows} />
      {ready.length > 0 ? (
        <Button
          disabled={busy}
          onClick={async () => {
            await onSubmit(
              ready.map((row) => ({
                unitId: row.unitId,
                purpose: row.purpose,
                dueDate: row.dueDate || null,
              })),
            );
            setRows([]);
          }}
          className="mt-2 !px-3 !py-1 text-xs"
        >
          {submitLabel}
        </Button>
      ) : null}
    </div>
  );
}
