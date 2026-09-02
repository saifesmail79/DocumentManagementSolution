/**
 * Where the documents live, and the guided move to somewhere else.
 *
 * ─── Why this is not just another row in the settings table ─────────────────
 *
 * Every other setting can be typed and saved. This one points the running system
 * at a directory: get it wrong and every document is unreachable at once, with
 * nothing on screen to say why. So it is a four-step flow instead of a text box.
 *
 *   1. type the destination and check it — existence, readability and a real
 *      write, because a share can advertise write access and refuse the write
 *   2. read a plain summary of what will happen before agreeing to it
 *   3. apply, which repoints the system and immediately counts what is there
 *   4. copy the outstanding files at leisure and re-check until nothing is left
 *
 * Nothing here copies a byte. Moving an archive is a job for a tool with resume
 * and retry; this points the system at the new place and tells the truth about
 * what has arrived.
 */

import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, RefreshCw, Search, ShieldAlert } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatBytes, formatDateTime } from '../format.js';
import { Button, Card, Alert, TextField } from './ui.jsx';
import { Modal } from './Modal.jsx';

/** The refusals `validateRoot` can return, in the words an operator needs. */
const REFUSALS = {
  empty_path: 'أدخل مساراً.',
  not_absolute: 'المسار يجب أن يكون مطلقاً (مثل D:\\dms\\storage) أو مسار شبكة (\\\\nas\\dms).',
  not_found: 'المسار غير موجود على الخادم.',
  not_a_directory: 'المسار يشير إلى ملف لا إلى مجلد.',
  not_readable: 'لا يمكن القراءة من هذا المسار.',
  not_writable: 'المسار موجود لكن لا يمكن الكتابة فيه — تحقّق من صلاحيات حساب الخدمة.',
  unusable_root: 'تعذّر استخدام المسار: فشل اختبار الكتابة والقراءة.',
  not_saved: 'تعذّر حفظ الإعداد، وأُعيد المسار السابق.',
};

const KIND_LABELS = { version: 'إصدار', file: 'ملف ضمن وثيقة', rendition: 'معاينة (يُعاد إنشاؤها)' };

export default function StorageRootCard() {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // The move dialog: the typed path, and the check result it is waiting on.
  const [moving, setMoving] = useState(false);
  const [candidate, setCandidate] = useState('');
  const [checked, setChecked] = useState(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.admin.storageReport());
    } catch {
      setError('تعذر قراءة حالة التخزين.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function recheck() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.reconcileStorage();
      setNotice(
        result.missing === 0
          ? `اكتملت المطابقة: كل الملفات (${result.total}) موجودة في المسار الحالي.`
          : `بقي ${result.missing} ملفاً غير موجود من أصل ${result.total}.`
          + (result.resolvedThisRun ? ` وصل ${result.resolvedThisRun} ملفاً منذ آخر فحص.` : ''),
      );
      await load();
    } catch {
      setError('تعذّرت المطابقة.');
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const result = await api.admin.validateStorageRoot(candidate);
      setChecked(result);
      if (!result.ok) setError(REFUSALS[result.reason] ?? 'المسار غير صالح.');
    } catch {
      setError('تعذّر فحص المسار.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.admin.setStorageRoot(candidate);
      setMoving(false);
      setCandidate('');
      setChecked(null);
      setNotice(
        `تم تغيير مسار التخزين إلى ${result.to}. `
        + (result.report?.missing === 0
          ? 'كل الملفات موجودة في المسار الجديد.'
          : `${result.report?.missing ?? 0} ملفاً لم يصل بعد — انسخها ثم أعد الفحص.`),
      );
      await load();
    } catch (caught) {
      const reason = caught instanceof ApiError ? caught.body?.reason : null;
      setError(REFUSALS[reason] ?? 'تعذّر تغيير المسار.');
    } finally {
      setBusy(false);
    }
  }

  const pending = report?.pending ?? 0;

  return (
    <Card className="p-4">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text">
        <HardDrive size={15} className="text-primary" />
        مكان تخزين الملفات
      </h3>
      <p className="mb-3 text-xs text-text-muted">
        كل المسارات المحفوظة في قاعدة البيانات نسبية إلى هذا المجلد، لذا تغييره لا يستدعي
        تعديل أي سجل — يكفي نسخ الملفات إلى المكان الجديد.
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="mb-3 rounded-lg border border-border bg-surface-muted/40 p-3">
        <span className="block text-[11px] text-text-muted">المسار الحالي</span>
        <code dir="ltr" className="mt-0.5 block select-all break-all text-sm text-text">
          {report?.currentRoot ?? '…'}
        </code>
      </div>

      <div className="mb-3 flex flex-row flex-wrap gap-2">
        <Button icon={HardDrive} onClick={() => setMoving(true)} disabled={busy}>
          تغيير المسار
        </Button>
        <Button variant="secondary" icon={RefreshCw} onClick={recheck} disabled={busy}>
          {busy ? 'جارٍ الفحص…' : 'إعادة فحص الملفات'}
        </Button>
      </div>

      {/* The outstanding list is the whole point of the feature: it survives a
          restart, so a large copy can be finished over days. */}
      {report ? (
        pending === 0 ? (
          <Alert tone="success">
            لا توجد ملفات ناقصة.
            {report.lastCheckedAt ? ` آخر فحص: ${formatDateTime(report.lastCheckedAt)}.` : ''}
          </Alert>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium text-amber-600">
                <ShieldAlert size={15} />
                <span className="num">{pending}</span> ملفاً غير موجود في المسار الحالي
              </span>
              {report.resolved > 0 ? (
                <span className="num text-[11px] text-text-muted">وصل {report.resolved} حتى الآن</span>
              ) : null}
            </div>

            <p className="mb-2 text-[11px] text-text-muted">
              انسخ هذه الملفات من المسار القديم إلى الجديد بالمسارات نفسها، ثم اضغط «إعادة فحص
              الملفات». تختفي من القائمة حالما تصل.
            </p>

            <div className="max-h-64 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-muted text-[11px] uppercase tracking-wider text-text-muted">
                    <th className="px-3 py-2 text-right font-semibold">المسار داخل المجلد</th>
                    <th className="px-3 py-2 text-right font-semibold">الوثيقة</th>
                    <th className="px-3 py-2 text-right font-semibold">النوع</th>
                    <th className="px-3 py-2 text-left font-semibold">الحجم</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {report.items.map((item) => (
                    <tr key={item.storagePath}>
                      <td className="px-3 py-1.5 text-right">
                        <code dir="ltr" className="select-all break-all text-[11px]">
                          {item.storagePath}
                        </code>
                      </td>
                      <td className="max-w-[14rem] truncate px-3 py-1.5 text-right text-text-muted">
                        {item.title ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right text-text-muted">
                        {KIND_LABELS[item.kind] ?? item.kind}
                      </td>
                      <td className="num px-3 py-1.5 text-left text-text-muted">
                        {item.expectedBytes ? formatBytes(item.expectedBytes) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}

      <Modal
        open={moving}
        onClose={() => {
          setMoving(false);
          setChecked(null);
        }}
        title="تغيير مسار التخزين"
        subtitle="يُفحص المسار قبل تطبيقه، ولا يُنسخ أي ملف تلقائياً."
        icon={HardDrive}
        size="md"
        footer={
          <>
            <Button
              icon={busy ? Loader2 : HardDrive}
              onClick={apply}
              // Deliberately gated on a successful check: applying an unverified
              // path is the one mistake this whole screen exists to prevent.
              disabled={busy || !checked?.ok}
            >
              تطبيق المسار
            </Button>
            <Button
              variant="secondary"
              icon={Search}
              onClick={check}
              disabled={busy || !candidate.trim()}
            >
              فحص المسار
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField
            label="المسار الجديد"
            dir="ltr"
            placeholder="D:\\dms\\storage  أو  \\\\nas\\dms\\storage"
            hint="مسار مطلق على الخادم، أو مسار شبكة UNC. لا تستخدم حرف محرك مُعيَّن — خدمة ويندوز لا تراه."
            value={candidate}
            onChange={(event) => {
              setCandidate(event.target.value);
              setChecked(null);
            }}
          />

          {checked?.ok ? (
            <div className="space-y-2">
              <Alert tone="success">المسار صالح: موجود، ويمكن القراءة منه والكتابة فيه.</Alert>

              {checked.sameAsCurrent ? (
                <Alert tone="info">هذا هو المسار الحالي نفسه — لن يتغيّر شيء.</Alert>
              ) : null}

              {checked.isEmpty ? (
                <Alert tone="warning">
                  المجلد فارغ. إن لم تكن قد نسخت الملفات بعد، فستصبح كل الوثائق غير متاحة حتى
                  تنسخها — وسيعرض النظام قائمة بما ينقص فور التطبيق.
                </Alert>
              ) : null}

              <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-xs leading-relaxed text-text">
                <p className="mb-1 font-medium">ما سيحدث عند التطبيق:</p>
                <ul className="space-y-1 text-text-muted">
                  <li>• يبدأ النظام بقراءة الملفات وكتابتها في المسار الجديد فوراً.</li>
                  <li>• لا تتغيّر أي سجلات في قاعدة البيانات — المسارات المحفوظة نسبية.</li>
                  <li>• لا يُنسخ ولا يُحذف أي ملف من المسار القديم.</li>
                  <li>• يُفحص كل ملف، وتُعرض قائمة بما لم يصل بعد لتُكملها لاحقاً.</li>
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}
