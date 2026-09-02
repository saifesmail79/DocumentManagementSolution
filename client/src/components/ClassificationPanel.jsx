import { useCallback, useEffect, useState } from 'react';
import { ScanSearch, RefreshCw, CheckCircle2, AlertTriangle, HelpCircle } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDateTime } from '../format.js';
import { Button, Card, Alert, Spinner } from './ui.jsx';

/**
 * What the recognition pilot thinks one document is, and what it read from
 * the header.
 *
 * ─── Suggestions, visibly ───────────────────────────────────────────────────
 *
 * Nothing here writes a field or sets the type. The values are shown beside
 * the type a person chose and the fields a person typed, so the reader can
 * see where the machine agreed and where it did not — that comparison is the
 * pilot. The recognised header text is the one place OCR output reaches a
 * screen, and it is labelled as machine-read with its confidence for exactly
 * that reason.
 *
 * `onEnabled(false)` tells the page the pilot is off, so the tab disappears
 * rather than opening onto a note that says nothing is here.
 */

const DECISIONS = {
  auto: { label: 'مطابقة مؤكدة', tone: 'bg-green-100 text-green-800' },
  review: { label: 'يحتاج مراجعة', tone: 'bg-amber-100 text-amber-800' },
  unknown: { label: 'شكل غير معروف', tone: 'bg-gray-100 text-gray-700' },
};

export const FIELD_LABELS = {
  number: 'رقم الكتاب',
  date: 'التاريخ',
  subject: 'الموضوع',
  addressee: 'الجهة الموجّه إليها',
};

const SOURCE_LABELS = {
  line: 'بعد التسمية في السطر نفسه',
  row: 'في الخانة المجاورة',
  below: 'في السطر التالي',
};

const percent = (value) => `${Math.round((value ?? 0) * 100)}%`;

export function DecisionBadge({ decision }) {
  const entry = DECISIONS[decision] ?? DECISIONS.unknown;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${entry.tone}`}>{entry.label}</span>
  );
}

export function ConfidenceBar({ value }) {
  const width = Math.max(2, Math.round((value ?? 0) * 100));
  const tone = value >= 0.9 ? 'bg-green-500' : value >= 0.6 ? 'bg-amber-500' : 'bg-red-400';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted">
        <span className={`block h-full ${tone}`} style={{ width: `${width}%` }} />
      </span>
      <span className="num text-[11px] text-text-muted">{percent(value)}</span>
    </span>
  );
}

export default function ClassificationPanel({ documentId, canRead, onOpen, onCount, onEnabled }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      const result = await api.classification.document(documentId);
      setData(result);
      onEnabled?.(result.enabled !== false);
    } catch (caught) {
      // A missing route means an older server: behave as if the pilot is off.
      if (caught instanceof ApiError && caught.status === 404) onEnabled?.(false);
      else setError('تعذر تحميل نتيجة التعرّف.');
    }
  }, [documentId, canRead, onEnabled]);

  useEffect(() => {
    load();
  }, [load]);

  const inFlight = data?.status === 'pending' || data?.status === 'running' || data?.status === 'retryable';

  // Fingerprinting is an OCR pass away; the panel follows the queue rather than
  // leaving the reader to reload and guess.
  useEffect(() => {
    if (!inFlight) return undefined;
    const timer = setTimeout(load, 4000);
    return () => clearTimeout(timer);
  }, [inFlight, load, data]);

  useEffect(() => {
    onCount?.(data?.prediction ? 1 : 0);
  }, [data, onCount]);

  if (!canRead) return null;
  if (data && data.enabled === false) return null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api.classification.run(documentId);
      setData((current) => ({ ...(current ?? {}), enabled: true, status: 'pending', prediction: null }));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'classification_disabled'
          ? 'التعرّف التلقائي معطّل.'
          : 'تعذر طلب التعرّف.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Card className="p-4">
        {error ? <Alert tone="error">{error}</Alert> : <Spinner label="جارٍ التحميل…" />}
      </Card>
    );
  }

  const { prediction, fields, truth, queue } = data;
  const agrees = prediction && truth?.typeId !== null && prediction.typeId === truth?.typeId;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
          <ScanSearch size={15} className="text-primary" />
          التعرّف التلقائي
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">تجريبي</span>
        </h3>
        <Button variant="secondary" icon={RefreshCw} onClick={run} disabled={busy || inFlight} className="!px-2 !py-1 text-xs">
          {inFlight ? 'جارٍ الحساب…' : prediction ? 'إعادة الحساب' : 'احسب الآن'}
        </Button>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <p className="mb-3 text-[11px] leading-relaxed text-text-muted">
        قيم مقترحة قرأها النظام من الصفحة الأولى بالتعرّف الضوئي، تُعرض للمقارنة فقط ولا تُكتب في
        البيانات الوصفية ولا تغيّر نوع الوثيقة.
      </p>

      {data.status === 'none' ? (
        <Alert tone="info">لم تُحسب بصمة هذه الوثيقة بعد. اضغط «احسب الآن» أو انتظر الدورة التالية.</Alert>
      ) : null}
      {inFlight ? <Alert tone="info">الوثيقة في قائمة الانتظار — تتحدّث هذه اللوحة تلقائياً.</Alert> : null}
      {data.status === 'failed' || data.status === 'skipped' ? (
        <Alert tone="warning">
          تعذّر حساب البصمة{queue?.error ? `: ${queue.error}` : '.'}
        </Alert>
      ) : null}
      {data.stale ? (
        <Alert tone="warning">حُسبت البصمة من إصدار أقدم من الإصدار الحالي — أعد الحساب.</Alert>
      ) : null}

      {prediction ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[11px] text-text-muted">النوع المتوقّع</p>
                <p className="text-sm font-semibold text-text">
                  {prediction.typeName ?? (prediction.decision === 'unknown' ? 'لا يشبه أي نوع معروف' : 'غير محدد')}
                </p>
              </div>
              <DecisionBadge decision={prediction.decision} />
            </div>

            <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">ثقة التصويت</span>
                <ConfidenceBar value={prediction.confidence} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">أقرب تشابه</span>
                <ConfidenceBar value={prediction.nearest} />
              </div>
            </div>

            <div className="mt-2 flex items-center gap-1.5 text-xs">
              {truth?.typeId === null || truth?.typeId === undefined ? (
                <>
                  <HelpCircle size={13} className="text-text-muted" />
                  <span className="text-text-muted">لم يُحدَّد نوع لهذه الوثيقة بعد، فلا مقارنة.</span>
                </>
              ) : agrees ? (
                <>
                  <CheckCircle2 size={13} className="text-green-600" />
                  <span className="text-green-700">يطابق النوع المحدد ({truth.typeName}).</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={13} className="text-amber-600" />
                  <span className="text-amber-700">يخالف النوع المحدد ({truth.typeName}).</span>
                </>
              )}
            </div>

            {prediction.labelled === 0 ? (
              <p className="mt-2 text-[11px] text-text-muted">
                لا توجد وثائق أخرى ذات نوع محدد وبصمة محسوبة للمقارنة بها بعد.
              </p>
            ) : null}
          </div>

          {prediction.neighbours?.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text">أقرب الوثائق شبهاً</p>
              <ul className="divide-y divide-border/50 rounded-lg border border-border">
                {prediction.neighbours.map((neighbour) => (
                  <li key={neighbour.documentId} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => onOpen?.(neighbour.documentId)}
                      className="min-w-0 truncate text-start text-primary hover:underline"
                      title={neighbour.title ?? ''}
                    >
                      {neighbour.title ?? `وثيقة ${neighbour.documentId}`}
                    </button>
                    <span className="shrink-0 text-text-muted">{neighbour.typeName ?? '—'}</span>
                    <span className="shrink-0" title={`نص ${percent(neighbour.text)} · ترويسة ${percent(neighbour.header)} · صفحة ${percent(neighbour.page)}`}>
                      <ConfidenceBar value={neighbour.similarity} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="mb-1.5 text-xs font-medium text-text">ما قُرئ من الترويسة</p>
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border/50">
                {Object.entries(FIELD_LABELS).map(([role, label]) => {
                  const field = fields?.[role];
                  return (
                    <tr key={role}>
                      <td className="w-28 py-1.5 text-text-muted">{label}</td>
                      <td className="py-1.5 text-text">
                        {field ? (
                          <>
                            <span className={field.validated ? '' : 'text-amber-700'} dir="auto">
                              {field.value}
                            </span>
                            {field.calendar === 'hijri' ? (
                              <span className="ms-1 text-[10px] text-text-muted">(هجري)</span>
                            ) : null}
                            <p className="text-[10px] text-text-muted">
                              بجوار «{field.anchor}» {SOURCE_LABELS[field.source] ?? ''}
                              {field.validated ? '' : ' · لم يجتز التحقق'}
                            </p>
                          </>
                        ) : (
                          <span className="text-text-muted">لم يُعثر عليه</span>
                        )}
                      </td>
                      <td className="w-28 py-1.5 text-end">{field ? <ConfidenceBar value={field.confidence} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-text-muted">
            حُسبت في {formatDateTime(data.computedAt)} · قرأ التعرّف الضوئي{' '}
            <span className="num">{data.ocr?.words ?? 0}</span> كلمة (نمط التقسيم{' '}
            <span className="num">{data.ocr?.psm}</span>)
          </p>
        </div>
      ) : null}
    </Card>
  );
}
