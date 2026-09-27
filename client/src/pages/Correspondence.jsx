import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Mailbox,
  Inbox,
  FileText,
  FilePlus,
  CheckCircle2,
  Upload,
  XCircle,
  Send,
} from 'lucide-react';

import {
  CORRESPONDENCE_TABS as TABS,
  MODULES,
  visibleTabs,
} from '../navigation.js';
import { api } from '../api.js';
import { formatDate, formatDateTime } from '../format.js';
import { Card, Spinner, EmptyState, Alert, Button, TextField } from '../components/ui.jsx';
import ScanPanel from '../components/ScanPanel.jsx';
import { useDialogs } from '../components/DialogProvider.jsx';
import { useHelpTopic } from '../help/HelpContext.jsx';
import { useAuth } from '../auth.jsx';

/** The registry entry whose tabs this page draws. */
const CORRESPONDENCE = MODULES.find((module) => module.key === 'correspondence');

/**
 * The correspondence module (الوارد والصادر).
 *
 * Three views behind one tile: the personal queue (transfers addressed to any
 * unit whose group you belong to), the register (mail room only), and المتابعة
 * (mail room only — every open transfer, oldest first).
 *
 * Registration itself happens on the document page's «المراسلة» tab, because a
 * letter is registered over a document that was just scanned there. This page
 * is for working what is already in the book.
 */

const LETTER_STATUS = {
  registered: { label: 'مسجل', tone: 'bg-blue-50 text-blue-600 border-blue-200' },
  routed: { label: 'محال', tone: 'bg-amber-50 text-amber-600 border-amber-200' },
  done: { label: 'منجز', tone: 'bg-green-50 text-green-600 border-green-200' },
  sent: { label: 'أُرسل', tone: 'bg-green-50 text-green-600 border-green-200' },
  annulled: { label: 'ملغى', tone: 'bg-red-50 text-red-600 border-red-200' },
};

const TRANSFER_STATUS = {
  pending: 'بانتظار التسلّم',
  received: 'قيد الإجراء',
  done: 'منجز',
  cancelled: 'ملغاة',
};

const TRANSFER_TONE = {
  pending: 'border-amber-200 bg-amber-50 text-amber-600',
  received: 'border-blue-200 bg-blue-50 text-blue-600',
  done: 'border-green-200 bg-green-50 text-green-600',
  cancelled: 'border-border bg-surface-muted text-text-muted line-through',
};

/**
 * One department's slice of a letter, for the register: «المالية · قيد
 * الإجراء». The letter-level status compresses these on purpose, so this is
 * where "which department is it sitting with?" gets its answer.
 */
function UnitStatusChip({ transfer }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
        TRANSFER_TONE[transfer.status] ?? TRANSFER_TONE.pending
      }`}
    >
      {transfer.unitName}
      <span aria-hidden="true">·</span>
      {transfer.purpose === 'info' && transfer.status === 'pending'
        ? 'للاطلاع'
        : TRANSFER_STATUS[transfer.status]}
      {transfer.overdue ? <span className="font-semibold">· متأخّر</span> : null}
    </span>
  );
}

export function StatusChip({ status }) {
  const entry = LETTER_STATUS[status] ?? LETTER_STATUS.registered;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${entry.tone}`}>{entry.label}</span>
  );
}

function OverdueBadge() {
  return (
    <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">
      متأخّر
    </span>
  );
}

export default function Correspondence() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);

  useHelpTopic('correspondence');

  useEffect(() => {
    api.correspondence
      .status()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
  }, []);

  const requested = searchParams.get('tab');
  const known = TABS.some((entry) => entry.key === requested) ? requested : 'queue';
  /*
   * Permitted, by the same rule the tile menu applies.
   *
   * The register and المتابعة belong to the mail room; anyone else who follows a
   * stale link or a bookmark lands on their own queue rather than a refusal.
   * Read from `visibleTabs` rather than re-tested here, so the launcher and this
   * page cannot disagree about who may open what.
   */
  const permitted = status ? visibleTabs(CORRESPONDENCE, status).map((entry) => entry.key) : [];
  const tab = status && !permitted.includes(known) ? 'queue' : known;
  // Replaced, not pushed, so the back button leaves the page rather than
  // retracing every tab that was clicked (see MyDocuments).
  const setTab = (key) => setSearchParams(key === 'queue' ? {} : { tab: key }, { replace: true });

  if (!status) return <Spinner />;

  if (!status.enabled) {
    return (
      <EmptyState
        icon={Mailbox}
        title="وحدة المراسلات غير مفعّلة"
        hint={
          user.isSuperAdmin
            ? 'فعّلها من الإدارة ← الإعدادات (correspondence.enabled)، ثم عرّف الأقسام من الإدارة ← المراسلات.'
            : 'راجع مدير النظام إذا كانت مؤسستكم تعتمد سجل الوارد والصادر.'
        }
      />
    );
  }

  const shownTabs = visibleTabs(CORRESPONDENCE, status);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-text">المراسلات</h2>

      <div className="flex flex-row flex-wrap gap-1 border-b border-border">
        {shownTabs.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === item.key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            <item.icon size={15} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'queue' ? <Queue /> : null}
      {tab === 'intake' ? <Intake intakeFolderId={status.intakeFolderId} /> : null}
      {tab === 'register' ? <Register units={status.units} /> : null}
      {tab === 'followup' ? <FollowUp /> : null}
    </div>
  );
}

// ── تسجيل كتاب: scan or upload, then straight into the book ─────────────

/**
 * The mail room's entry point. A letter arrives here — scanned through the
 * bridge or picked as a file — lands in the intake folder, and goes straight
 * to its registration form, where the book (وارد/صادر) is a required choice.
 * Anything scanned but not yet registered is listed below, so no letter can
 * sit outside the book unnoticed.
 */
function Intake({ intakeFolderId }) {
  const navigate = useNavigate();
  const fileInput = useRef(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPending(await api.correspondence.intake());
    } catch {
      setPending({ configured: false, documents: [] });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function uploadFile(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.upload(intakeFolderId, file);
      // Straight to the registration form — the whole point of this screen.
      navigate(`/documents/${result.documentId}?tab=correspondence`);
    } catch {
      setError('تعذر رفع الملف. تأكد من نوعه وحجمه وحاول مجدداً.');
      setBusy(false);
    }
  }

  if (!pending) return <Spinner />;

  if (!intakeFolderId || !pending.configured) {
    return (
      <EmptyState
        icon={FilePlus}
        title="مجلد الاستلام غير محدد"
        hint="يحدّد مدير النظام مجلد الاستلام من الإدارة ← المراسلات، ثم يُمسح ويُسجَّل كل كتاب من هنا."
      />
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-text">كتاب جديد</h3>
        <p className="mb-3 text-xs text-text-muted">
          امسح الكتاب أو اختر ملفه — يُرفع إلى مجلد الاستلام ثم يفتح نموذج التسجيل مباشرة،
          واختيار الدفتر (وارد/صادر) إلزامي قبل الحفظ.
        </p>
        <div className="flex flex-row flex-wrap gap-2">
          <Button icon={Upload} disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? 'جارٍ الرفع…' : 'اختيار ملف'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(event) => {
              uploadFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      </Card>

      <ScanPanel folderId={intakeFolderId} onUploaded={load} />

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-text">بانتظار التسجيل</h3>
        {pending.documents.length === 0 ? (
          <p className="text-sm text-text-muted">
            لا كتب ممسوحة بلا قيد — كل ما في مجلد الاستلام مسجَّل في الدفاتر.
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {pending.documents.map((document) => (
              <li key={document.documentId} className="flex items-center gap-3 py-2">
                <FileText size={15} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{document.title}</span>
                <span className="num shrink-0 text-xs text-text-muted">
                  {formatDateTime(document.createdAt)}
                </span>
                <Button
                  className="!px-3 !py-1 text-xs"
                  onClick={() => navigate(`/documents/${document.documentId}?tab=correspondence`)}
                >
                  سجّل
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── The personal queue ───────────────────────────────────────────────────

function Queue() {
  const navigate = useNavigate();
  const { prompt } = useDialogs();
  const [transfers, setTransfers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // 'open' is the working queue; 'all' is the department's own archive — how a
  // clerk reaches a letter closed three years ago, by search rather than by
  // scrolling a folder.
  const [scope, setScope] = useState('open');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setTransfers(
        (await api.correspondence.queue({ scope, q: query.trim() || undefined })).transfers,
      );
    } catch {
      setTransfers([]);
    }
  }, [scope, query]);

  useEffect(() => {
    // A short pause after typing, so the register is asked once per thought
    // rather than once per keystroke.
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(action, transfer) {
    let note = null;
    if (action === 'close') {
      note = await prompt({
        title: `إنجاز الكتاب ${transfer.reference}`,
        label: 'ما الذي أُنجز؟ (اختياري)',
        placeholder: 'يظهر في سجل الإحالة',
        confirmLabel: 'تسجيل الإنجاز',
      });
      if (note === null) return;
    }

    setBusy(true);
    setError(null);
    try {
      if (action === 'receive') await api.correspondence.receive(transfer.transferId);
      else await api.correspondence.close(transfer.transferId, note || null);
      await load();
    } catch {
      setError('تعذر تسجيل الإجراء. حدّث الصفحة وحاول مجدداً.');
    } finally {
      setBusy(false);
    }
  }

  const controls = (
    <Card className="flex flex-row flex-wrap items-end gap-3 p-4">
      <div className="min-w-52 flex-1">
        <TextField
          label="بحث"
          placeholder="الرقم أو الموضوع أو الجهة"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 pb-2 text-sm text-text">
        <input
          type="checkbox"
          checked={scope === 'all'}
          onChange={(event) => setScope(event.target.checked ? 'all' : 'open')}
          className="h-4 w-4 accent-primary"
        />
        عرض المنجزة أيضاً (أرشيف قسمي)
      </label>
    </Card>
  );

  if (!transfers) return <Spinner />;
  if (transfers.length === 0) {
    return (
      <div className="space-y-3">
        {controls}
        <EmptyState
          icon={Inbox}
          title={scope === 'all' || query ? 'لا نتائج مطابقة' : 'لا كتب محالة إليك'}
          hint={
            scope === 'all' || query
              ? 'جرّب كلمة أخرى، أو فعّل «عرض المنجزة أيضاً» للبحث في أرشيف قسمك كله.'
              : 'حين يحيل قلم الوارد كتاباً إلى قسمك يظهر هنا ويصلك إشعار.'
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {controls}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {transfers.map((transfer) => (
        <Card key={transfer.transferId} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-xs font-semibold text-primary">{transfer.reference}</span>
                {transfer.purpose === 'info' ? (
                  <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-600">
                    للاطلاع
                  </span>
                ) : null}
                {transfer.overdue ? <OverdueBadge /> : null}
                <span className="text-[11px] text-text-muted">{TRANSFER_STATUS[transfer.status]}</span>
              </div>

              {transfer.canRead ? (
                <button
                  onClick={() => navigate(`/documents/${transfer.documentId}`)}
                  className="mt-1 block max-w-full truncate text-right text-sm font-medium text-text hover:text-primary"
                >
                  {transfer.subject}
                </button>
              ) : (
                <p className="mt-1 truncate text-sm font-medium text-text">{transfer.subject}</p>
              )}

              <p className="num mt-0.5 text-xs text-text-muted">
                إلى {transfer.unitName}
                {transfer.externalParty ? ` · من ${transfer.externalParty}` : ''}
                {' · '}
                أُحيل {formatDate(transfer.routedAt)}
                {transfer.dueDate ? ` · الاستحقاق ${formatDate(transfer.dueDate)}` : ''}
              </p>
              {transfer.note ? <p className="mt-1 text-sm text-text">{transfer.note}</p> : null}
            </div>
          </div>

          {!transfer.canRead ? (
            <p className="mt-2 text-xs text-amber-600">
              لا تملك صلاحية قراءة هذه الوثيقة. اطلب من مدير النظام منح مجموعتك صلاحية «قراءة» على
              مجلد الوارد.
            </p>
          ) : null}

          <div className="mt-3 flex flex-row flex-wrap gap-2">
            {transfer.status === 'pending' ? (
              <Button
                disabled={busy}
                icon={CheckCircle2}
                onClick={() => act('receive', transfer)}
                className="!px-3 !py-1 text-xs"
              >
                {transfer.purpose === 'info' ? 'اطلعت عليه' : 'تسلّم'}
              </Button>
            ) : null}
            {transfer.purpose === 'action' && ['pending', 'received'].includes(transfer.status) ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => act('close', transfer)}
                className="!px-3 !py-1 text-xs"
              >
                إنجاز
              </Button>
            ) : null}
            {transfer.canRead ? (
              <Button
                variant="secondary"
                icon={FileText}
                onClick={() => navigate(`/documents/${transfer.documentId}`)}
                className="!px-3 !py-1 text-xs"
              >
                فتح الوثيقة
              </Button>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── The register (mail room) ─────────────────────────────────────────────

function Register() {
  const navigate = useNavigate();
  const { prompt, confirm } = useDialogs();
  const [letters, setLetters] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState('in');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api.correspondence.letters({
        direction,
        year: /^\d{4}$/.test(year) ? year : undefined,
        q: query || undefined,
      });
      setLetters(result.letters);
    } catch {
      setLetters([]);
    }
  }, [direction, year, query]);

  useEffect(() => {
    load();
  }, [load]);

  async function annul(letter) {
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
    setError(null);
    try {
      await api.correspondence.annul(letter.letterId, reason.trim());
      await load();
    } catch {
      setError('تعذر إلغاء القيد.');
    } finally {
      setBusy(false);
    }
  }

  async function markSent(letter) {
    const ok = await confirm({
      title: `تأشير الإرسال — ${letter.reference}`,
      message: 'يُسجَّل الكتاب الصادر مُرسلاً بعد تسليمه فعلاً للجهة الخارجية.',
      confirmLabel: 'أُرسل',
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
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
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="flex flex-row flex-wrap items-end gap-3 p-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">الدفتر</span>
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            className="rounded-lg border border-border bg-control px-3 py-2 text-sm text-text"
          >
            <option value="in">الوارد</option>
            <option value="out">الصادر</option>
          </select>
        </label>
        <div className="w-28">
          <TextField label="السنة" dir="ltr" value={year} onChange={(event) => setYear(event.target.value)} />
        </div>
        <div className="min-w-52 flex-1">
          <TextField
            label="بحث"
            placeholder="الموضوع أو الجهة أو رقمها"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </Card>

      {!letters ? (
        <Spinner />
      ) : letters.length === 0 ? (
        <EmptyState
          icon={Mailbox}
          title="لا قيود في هذا الدفتر"
          hint="يُسجَّل الكتاب من صفحة وثيقته: افتح الوثيقة الممسوحة ثم تبويب «المراسلة»."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-xs text-text-muted">
                <th className="px-3 py-2 font-medium">الرقم</th>
                <th className="px-3 py-2 font-medium">الموضوع</th>
                <th className="px-3 py-2 font-medium">الجهة</th>
                {/*
                  Two dates, each named.

                  The column said only "التاريخ" and showed the registration
                  timestamp, while the date written on the letter — captured at
                  registration and already returned by this query — appeared
                  nowhere in the register. A records officer reading دفتر الوارد
                  needs both, and an unlabelled one is the wrong one half the
                  time.
                */}
                <th className="px-3 py-2 font-medium">تاريخ الكتاب</th>
                <th className="px-3 py-2 font-medium">تاريخ التسجيل</th>
                <th className="px-3 py-2 font-medium">الحالة</th>
                {direction === 'in' ? <th className="px-3 py-2 font-medium">عند الأقسام</th> : null}
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {letters.map((letter) => (
                <tr key={letter.letterId} className="hover:bg-surface-muted/30">
                  <td className="num whitespace-nowrap px-3 py-2 text-right font-semibold text-primary">
                    {letter.reference}
                  </td>
                  <td className="max-w-64 px-3 py-2">
                    <button
                      onClick={() => navigate(`/documents/${letter.documentId}`)}
                      className={`block max-w-full truncate text-right hover:text-primary ${
                        letter.status === 'annulled' ? 'text-text-muted line-through' : 'text-text'
                      }`}
                      title={letter.annulReason ? `ملغى: ${letter.annulReason}` : undefined}
                    >
                      {letter.subject}
                    </button>
                  </td>
                  <td className="max-w-40 truncate px-3 py-2 text-text-muted">
                    {letter.externalParty ?? letter.unitName ?? '—'}
                    {letter.externalRef ? (
                      <span className="num block text-right text-[11px]">{letter.externalRef}</span>
                    ) : null}
                  </td>
                  <td className="num whitespace-nowrap px-3 py-2 text-right text-xs text-text-muted">
                    {letter.externalDate ? formatDate(letter.externalDate) : '—'}
                  </td>
                  <td className="num whitespace-nowrap px-3 py-2 text-right text-xs text-text-muted">
                    {formatDate(letter.registeredAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <StatusChip status={letter.status} />
                  </td>
                  {direction === 'in' ? (
                    <td className="px-3 py-2">
                      {letter.transfers?.length ? (
                        <span className="flex flex-wrap gap-1">
                          {letter.transfers.map((transfer, index) => (
                            // Appended-only list; the index is stable enough.
                            <UnitStatusChip key={index} transfer={transfer} />
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs text-text-muted">لم يُحَل بعد</span>
                      )}
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-3 py-2 text-left">
                    {letter.direction === 'out' && letter.status === 'registered' ? (
                      <button
                        disabled={busy}
                        onClick={() => markSent(letter)}
                        className="ms-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Send size={12} />
                        أُرسل
                      </button>
                    ) : null}
                    {letter.status !== 'annulled' ? (
                      <button
                        disabled={busy}
                        onClick={() => annul(letter)}
                        className="ms-2 inline-flex items-center gap-1 text-xs text-text-muted hover:text-red-600"
                      >
                        <XCircle size={12} />
                        إلغاء القيد
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ── المتابعة (mail room) ─────────────────────────────────────────────────

function FollowUp() {
  const navigate = useNavigate();
  const { prompt } = useDialogs();
  const [transfers, setTransfers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTransfers((await api.correspondence.followUp()).transfers);
    } catch {
      setTransfers([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function cancel(transfer) {
    const reason = await prompt({
      title: `سحب الإحالة — ${transfer.reference}`,
      message: `تُسحب الإحالة من ${transfer.unitName} ويمكن بعدها إحالة الكتاب إلى القسم الصحيح من صفحة وثيقته.`,
      label: 'سبب السحب (إلزامي)',
      placeholder: 'مثال: أُحيل إلى القسم الخطأ',
      confirmLabel: 'سحب الإحالة',
      variant: 'warning',
    });
    if (reason === null) return;
    if (reason.trim().length < 5) {
      setError('سبب السحب إلزامي — خمسة أحرف على الأقل، ليُفهم القيد عند مراجعته لاحقاً.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.correspondence.cancelTransfer(transfer.transferId, reason.trim());
      await load();
    } catch {
      setError('تعذر سحب الإحالة.');
    } finally {
      setBusy(false);
    }
  }

  if (!transfers) return <Spinner />;
  if (transfers.length === 0) {
    return <EmptyState icon={CheckCircle2} title="لا إحالات مفتوحة" hint="كل الكتب المحالة أُنجزت." />;
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-right text-xs text-text-muted">
              <th className="px-3 py-2 font-medium">الرقم</th>
              <th className="px-3 py-2 font-medium">الموضوع</th>
              <th className="px-3 py-2 font-medium">القسم</th>
              <th className="px-3 py-2 font-medium">أُحيل في</th>
              <th className="px-3 py-2 font-medium">الاستحقاق</th>
              <th className="px-3 py-2 font-medium">الحالة</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {transfers.map((transfer) => (
              <tr key={transfer.transferId} className="hover:bg-surface-muted/30">
                <td className="num whitespace-nowrap px-3 py-2 text-right font-semibold text-primary">
                  {transfer.reference}
                </td>
                <td className="max-w-64 px-3 py-2">
                  <button
                    onClick={() => navigate(`/documents/${transfer.documentId}`)}
                    className="block max-w-full truncate text-right text-text hover:text-primary"
                  >
                    {transfer.subject}
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text-muted">{transfer.unitName}</td>
                <td className="num whitespace-nowrap px-3 py-2 text-right text-xs text-text-muted">
                  {formatDate(transfer.routedAt)}
                </td>
                <td className="num whitespace-nowrap px-3 py-2 text-right text-xs text-text-muted">
                  {transfer.dueDate ? formatDate(transfer.dueDate) : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs">
                  <span className="text-text-muted">{TRANSFER_STATUS[transfer.status]}</span>
                  {transfer.overdue ? (
                    <span className="ms-1">
                      <OverdueBadge />
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-left">
                  <button
                    disabled={busy}
                    onClick={() => cancel(transfer)}
                    className="text-xs text-text-muted hover:text-red-600"
                  >
                    سحب
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
