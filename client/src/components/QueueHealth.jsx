import { useNavigate } from 'react-router-dom';
import { AlertTriangle, PauseCircle, RefreshCw } from 'lucide-react';

import { Card, Alert } from './ui.jsx';

/**
 * What the background queues are actually doing, and what is stuck.
 *
 * ─── Why a tool probe was not enough ────────────────────────────────────────
 *
 * The diagnostics screen used to answer "is OCR installed" and "is LibreOffice
 * installed". Both can be yes while every job fails, and both were yes on a
 * deployment where nothing had been indexed for a day. The queue is the only
 * thing that knows what happened, so it is what gets shown.
 *
 * ─── The states worth a colour ──────────────────────────────────────────────
 *
 * A count that is merely non-zero is not a problem: work in flight is normal.
 * Only two conditions are, and both are called out by name rather than left for
 * the reader to infer from six numbers — a job that has been claimed for longer
 * than any job should take, and a worker that is switched off while documents
 * wait for it.
 */

/** One number with a label, tinted only when the number means something is wrong. */
function Tile({ label, value, tone, hint }) {
  const tones = {
    warn: 'border-amber-200 bg-amber-50 text-amber-700',
    bad: 'border-red-200 bg-red-50 text-red-700',
  };

  return (
    <div
      title={hint}
      className={`rounded-lg border px-3 py-2 ${tone ? tones[tone] : 'border-border bg-surface'}`}
    >
      <p className="num text-lg font-semibold">{value ?? 0}</p>
      <p className="text-[11px] opacity-80">{label}</p>
    </div>
  );
}

export default function QueueHealth({
  title,
  queue,
  stuckJobs,
  worker,
  failures,
  onOpenDocument,
  live = false,
}) {
  const navigate = useNavigate();
  const open = onOpenDocument ?? ((id) => navigate(`/documents/${id}`));

  const paused = worker && worker.running === false;
  const waiting = (queue?.pending ?? 0) + (queue?.retryable ?? 0);

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        {/*
          Numbers that change on their own are indistinguishable from numbers
          that are simply stale. Saying which one this is turns "reload and hope"
          into waiting for a count to reach zero.
        */}
        {live ? (
          <span className="flex items-center gap-1 text-[11px] text-text-muted">
            <RefreshCw size={11} className="animate-spin" />
            يتحدّث تلقائياً
          </span>
        ) : null}
      </div>

      {/* Named conditions come first. Six numbers do not tell an operator that
          the worker is off; one sentence does. */}
      {paused ? (
        <Alert tone="warning">
          <span className="flex items-center gap-1.5">
            <PauseCircle size={14} />
            {worker.enabledInEnvironment
              ? 'الاستخراج موقوف من الإعدادات — لن تُفهرس أي وثيقة حتى يُعاد تفعيله.'
              : 'الاستخراج موقوف في إعدادات الخادم (EXTRACTION_ENABLED) — يتطلب تعديل ملف الإعدادات وإعادة التشغيل.'}
            {waiting > 0 ? ` هناك ${waiting} وثيقة في الانتظار.` : ''}
          </span>
        </Alert>
      ) : null}

      {stuckJobs > 0 ? (
        <Alert tone="error">
          <span className="flex items-center gap-1.5">
            <AlertTriangle size={14} />
            {stuckJobs} مهمة معلّقة منذ فترة طويلة — غالباً بسبب إيقاف الخادم أثناء
            المعالجة. استخدم «إعادة فهرسة غير المفهرَس» لاستعادتها.
          </span>
        </Alert>
      ) : null}

      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Tile label="في الانتظار" value={queue?.pending} />
        <Tile
          label="قيد المعالجة"
          value={queue?.running}
          tone={stuckJobs > 0 ? 'warn' : undefined}
          hint="إذا بقي هذا الرقم ثابتاً لفترة طويلة فقد تكون هناك مهمة معلّقة."
        />
        <Tile label="مكتملة" value={queue?.done} />
        <Tile
          label="ستُعاد المحاولة"
          value={queue?.retryable}
          tone={queue?.retryable > 0 ? 'warn' : undefined}
        />
        <Tile label="فشل نهائي" value={queue?.failed} tone={queue?.failed > 0 ? 'bad' : undefined} />
        <Tile
          label="تُخُطِّيت"
          value={queue?.skipped}
          tone={queue?.skipped > 0 ? 'warn' : undefined}
          hint="ملفات لا تدعمها الأدوات المثبّتة حالياً — أعد الفهرسة بعد تثبيت الأداة المناسبة."
        />
      </div>

      {failures?.length ? (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-text-muted">
            الوثائق غير المفهرَسة والسبب:
          </p>
          <ul className="divide-y divide-border/50 rounded-lg border border-border">
            {failures.slice(0, 12).map((f) => (
              <li key={`${f.documentId}-${f.version}-${f.kind ?? 'text'}`} className="px-3 py-2">
                <button
                  onClick={() => open(f.documentId)}
                  className="w-full text-right text-xs text-primary hover:underline"
                >
                  {f.title || f.filename}
                  {f.folderName ? (
                    <span className="text-text-muted"> — {f.folderName}</span>
                  ) : null}
                </button>
                {/* The raw reason, left in its own script and direction. It is
                    what makes the difference between "install a tool" and "this
                    file is damaged", and paraphrasing loses exactly that. */}
                <p className="mt-0.5 text-[11px] text-text-muted" dir="ltr">
                  {f.reason || 'لا يوجد سبب مسجّل'}
                </p>
              </li>
            ))}
          </ul>
          {failures.length > 12 ? (
            <p className="mt-1 text-[11px] text-text-muted">
              و{failures.length - 12} وثيقة أخرى.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
