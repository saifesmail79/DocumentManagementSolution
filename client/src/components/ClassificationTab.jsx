import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Play, BarChart3 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api.js';
import { Button, Card, Spinner, Alert } from './ui.jsx';
import TabIntro from './TabIntro.jsx';
import { useDialogs } from './DialogProvider.jsx';
import { DecisionBadge, ConfidenceBar, FIELD_LABELS } from './ClassificationPanel.jsx';

/**
 * The recognition pilot's administration screen.
 *
 * Three things, top to bottom: whether the pilot can run at all (the switch,
 * the tools), how much it has learned from (the fingerprints by type, the
 * queue), and what the measurements say (accuracy, the automation curve, the
 * header fields against what people typed). The last is the deliverable —
 * the table that replaces the word "100%" in the conversation with the
 * customer.
 */

const percent = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);

function Tile({ label, value, tone }) {
  const tones = { warn: 'text-amber-600', bad: 'text-red-600', good: 'text-green-700' };
  return (
    <Card className="p-4 text-center">
      <p className={`num text-2xl font-semibold ${tones[tone] ?? 'text-text'}`}>{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </Card>
  );
}

const TH = 'px-3 py-2 text-right font-semibold';
const TD = 'px-3 py-2';

export default function ClassificationTab() {
  const navigate = useNavigate();
  const { confirm } = useDialogs();
  const [status, setStatus] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.classification.status());
    } catch {
      setError('تعذر تحميل حالة التعرّف التلقائي.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const moving = Math.max(0, (status?.queue?.pending ?? 0) + (status?.queue?.running ?? 0) - (status?.worker?.stuckJobs ?? 0));

  // Follows the queue while work is in flight, the way the diagnostics screen
  // does, so "is it done" is answered by the screen and not by reloading it.
  useEffect(() => {
    if (moving === 0) return undefined;
    const timer = setTimeout(load, 4000);
    return () => clearTimeout(timer);
  }, [moving, load, status]);

  async function rebuild(all) {
    if (all) {
      const confirmed = await confirm({
        title: 'إعادة بناء كل البصمات',
        message: 'ستُعاد قراءة الصفحة الأولى من كل وثيقة بالتعرّف الضوئي.',
        detail: 'عملية طويلة على أرشيف كبير — استخدمها بعد تغيير في طريقة حساب البصمات، لا للوثائق الجديدة.',
        confirmLabel: 'إعادة البناء',
      });
      if (!confirmed) return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.classification.rebuild(all);
      setNotice(
        result.queued === 0
          ? 'لا توجد وثائق تحتاج إلى حساب.'
          : `أُضيفت ${result.queued} وثيقة إلى قائمة الانتظار — جارٍ الحساب في الخلفية.`,
      );
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'classification_disabled'
          ? 'التعرّف التلقائي معطّل. فعّله من تبويب الإعدادات، قسم «المعالجة».'
          : 'تعذر بدء الحساب.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function compute() {
    setComputing(true);
    setError(null);
    try {
      setMetrics(await api.classification.metrics());
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'classification_disabled'
          ? 'التعرّف التلقائي معطّل.'
          : 'تعذر حساب النتائج.',
      );
    } finally {
      setComputing(false);
    }
  }

  if (!status) return <Spinner />;

  const tools = status.tools ?? {};
  const toolsReady = tools.tesseract?.available && tools.arabic && tools.ghostscript?.available;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.classification" />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {!status.enabled ? (
        <Alert tone="warning">
          التعرّف التلقائي معطّل: لا تُحسب بصمات، ولا يعمل شيء في الخلفية. لتشغيل التجربة على هذا الخادم
          فعّل «التعرّف التلقائي على الوثائق» من تبويب الإعدادات، قسم «المعالجة». يبقى معطّلاً على أي
          خادم آخر ما لم يُفعَّل هناك.
        </Alert>
      ) : !tools.tesseract?.available ? (
        <Alert tone="error">مفعّل لكن محرّك Tesseract غير مثبّت على الخادم — ستفشل كل المهام.</Alert>
      ) : !tools.arabic ? (
        <Alert tone="error">Tesseract مثبّت لكن بيانات اللغة العربية غير مثبّتة — ستكون القراءة فارغة.</Alert>
      ) : !tools.ghostscript?.available ? (
        <Alert tone="error">Ghostscript غير مثبّت — لا يمكن قراءة ملفات PDF، وتُقرأ الصور فقط.</Alert>
      ) : (
        <Alert tone="success">
          مفعّل ({status.source === 'database' ? 'من الإعدادات' : 'من ملف البيئة'}) والأدوات جاهزة.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="بصمات محسوبة" value={status.samples.total} />
        <Tile label="منها ذات نوع محدد (عينات التدريب)" value={status.samples.labelled} tone="good" />
        <Tile label="وثائق بلا بصمة بعد" value={Math.max(0, status.samples.documents - status.samples.total)} tone={status.samples.documents - status.samples.total > 0 ? 'warn' : undefined} />
        <Tile
          label="في قائمة الانتظار"
          value={(status.queue?.pending ?? 0) + (status.queue?.running ?? 0)}
          tone={moving > 0 ? 'warn' : undefined}
        />
      </div>

      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">حساب البصمات</h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={RefreshCw} onClick={load} disabled={busy} className="!px-2 !py-1 text-xs">
              تحديث
            </Button>
            <Button icon={Play} onClick={() => rebuild(false)} disabled={busy || !status.enabled || !toolsReady} className="!px-2 !py-1 text-xs">
              احسب للوثائق الناقصة
            </Button>
            <Button variant="secondary" onClick={() => rebuild(true)} disabled={busy || !status.enabled || !toolsReady} className="!px-2 !py-1 text-xs">
              إعادة بناء الكل
            </Button>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-text-muted">
          تُقرأ الصفحة الأولى من كل وثيقة بالتعرّف الضوئي وتُحفظ بصمتها. الوثائق الجديدة تُضاف تلقائياً
          ما دام التعرّف مفعّلاً؛ هذا الزر يلحق بما رُفع قبل التفعيل. النوع الذي اختاره الرافع هو
          «الإجابة الصحيحة» التي يُقاس عليها.
        </p>
        {moving > 0 ? (
          <Alert tone="warning">
            جارٍ حساب {moving} وثيقة الآن — تتحدّث هذه الصفحة تلقائياً.
          </Alert>
        ) : null}
        {status.worker?.stuckJobs > 0 ? (
          <Alert tone="error">
            {status.worker.stuckJobs} مهمة عالقة — بدأت ولم تنتهِ. يعيد العامل أخذها تلقائياً.
          </Alert>
        ) : null}

        {status.samples.byType.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                  <th className={TH}>النوع</th>
                  <th className={`${TH} text-left`}>عينات</th>
                  <th className={`${TH} text-left`}>الحكم</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {status.samples.byType.map((row) => (
                  <tr key={row.typeId}>
                    <td className={`${TD} text-text`}>{row.name}</td>
                    <td className={`${TD} num text-left`}>{row.count}</td>
                    <td className={`${TD} text-left text-xs`}>
                      {row.count >= 30 ? (
                        <span className="text-green-700">كافٍ للتجربة</span>
                      ) : row.count >= 10 ? (
                        <span className="text-amber-700">قليل — يُفضَّل 30 فأكثر</span>
                      ) : (
                        <span className="text-red-600">غير كافٍ</span>
                      )}
                    </td>
                  </tr>
                ))}
                {status.samples.unlabelled > 0 ? (
                  <tr>
                    <td className={`${TD} text-text-muted`}>بلا نوع محدد</td>
                    <td className={`${TD} num text-left text-text-muted`}>{status.samples.unlabelled}</td>
                    <td className={`${TD} text-left text-xs text-text-muted`}>تُتنبَّأ ولا تُدرَّب عليها</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-xs text-text-muted">لا توجد بصمات محسوبة بعد.</p>
        )}

        {status.failures?.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1 text-xs font-medium text-text">مهام لم تكتمل</p>
            <ul className="divide-y divide-border/50 rounded-lg border border-border text-xs">
              {status.failures.map((failure) => (
                <li key={failure.documentId} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <button
                    type="button"
                    onClick={() => navigate(`/documents/${failure.documentId}`)}
                    className="min-w-0 truncate text-start text-primary hover:underline"
                  >
                    {failure.title}
                  </button>
                  <span className="shrink-0 text-text-muted" dir="auto">{failure.reason ?? failure.status}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">النتائج</h3>
          <Button icon={BarChart3} onClick={compute} disabled={computing || !status.enabled || status.samples.labelled < 2} className="!px-2 !py-1 text-xs">
            {computing ? 'جارٍ الحساب…' : metrics ? 'إعادة الحساب' : 'احسب النتائج'}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-text-muted">
          تُتنبَّأ كل وثيقة ذات نوع محدد من بقية الوثائق (باستثناء نفسها) ويُقارَن التنبؤ بالنوع
          الذي اختاره الرافع. القاعدة الحالية: يُعدّ التصنيف مؤكداً عند ثقة{' '}
          <span className="num">{percent(status.thresholds?.autoConfidence)}</span> فأكثر وتشابه{' '}
          <span className="num">{percent(status.thresholds?.autoSimilarity)}</span> فأكثر، ويُعدّ الشكل مجهولاً تحت{' '}
          <span className="num">{percent(status.thresholds?.unknownSimilarity)}</span>.
        </p>

        {status.samples.labelled < 2 ? (
          <Alert tone="info">تحتاج النتائج إلى وثيقتين على الأقل ذواتَي نوع محدد وبصمة محسوبة.</Alert>
        ) : null}

        {metrics ? <MetricsView metrics={metrics} onOpen={(id) => navigate(`/documents/${id}`)} /> : null}
      </Card>
    </div>
  );
}

function MetricsView({ metrics, onOpen }) {
  const offDiagonal = metrics.confusion.filter((cell) => cell.predictedId !== cell.truthId);

  return (
    <div className="mt-3 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="وثائق مقيَّمة" value={metrics.samples.evaluated} />
        <Tile label="دقة التصنيف الكلية" value={percent(metrics.accuracy)} tone={metrics.accuracy >= 0.95 ? 'good' : metrics.accuracy >= 0.8 ? 'warn' : 'bad'} />
        <Tile label="أخطاء" value={metrics.samples.evaluated - Math.round((metrics.accuracy ?? 0) * metrics.samples.evaluated)} tone="bad" />
        <Tile label="شكل مجهول" value={metrics.unknown} tone={metrics.unknown > 0 ? 'warn' : undefined} />
      </div>
      {metrics.samples.sampled ? (
        <p className="text-[11px] text-text-muted">حُسبت على عيّنة عشوائية لأن عدد الوثائق كبير.</p>
      ) : null}

      <section>
        <h4 className="mb-1 text-xs font-semibold text-text">حسب النوع</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <th className={TH}>النوع</th>
                <th className={`${TH} text-left`}>عينات</th>
                <th className={`${TH} text-left`}>استدعاء</th>
                <th className={`${TH} text-left`}>دقة</th>
                <th className={`${TH} text-left`}>مجهول</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {metrics.perType.map((row) => (
                <tr key={row.typeId}>
                  <td className={`${TD} text-text`}>{row.name}</td>
                  <td className={`${TD} num text-left`}>{row.support}</td>
                  <td className={`${TD} num text-left`}>{percent(row.recall)}</td>
                  <td className={`${TD} num text-left`}>{percent(row.precision)}</td>
                  <td className={`${TD} num text-left`}>{row.unknown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-text-muted">
          الاستدعاء: نسبة وثائق النوع التي تعرّف عليها النظام. الدقة: نسبة ما نسبه النظام إلى هذا النوع وكان صحيحاً.
        </p>
      </section>

      {offDiagonal.length > 0 ? (
        <section>
          <h4 className="mb-1 text-xs font-semibold text-text">الخلط بين الأنواع</h4>
          <ul className="divide-y divide-border/50 rounded-lg border border-border text-xs">
            {offDiagonal.map((cell) => (
              <li key={`${cell.truthId}-${cell.predictedId}`} className="flex items-center justify-between px-3 py-1.5">
                <span className="text-text">
                  {cell.truth} ← عُدّت <span className="font-medium">{cell.predicted ?? 'شكلاً مجهولاً'}</span>
                </span>
                <span className="num text-text-muted">{cell.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4 className="mb-1 text-xs font-semibold text-text">منحنى الأتمتة</h4>
        <p className="mb-1 text-[11px] text-text-muted">
          عند كل عتبة ثقة: كم وثيقة كانت ستُصنَّف بلا تدخّل، وكم منها كان سيصيب. هذا الجدول هو ما يحلّ
          محلّ عبارة «ثقة 100%».
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <th className={TH}>العتبة</th>
                <th className={`${TH} text-left`}>مؤتمتة</th>
                <th className={`${TH} text-left`}>نسبة الأتمتة</th>
                <th className={`${TH} text-left`}>دقة المؤتمت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {metrics.curve.map((row) => (
                <tr key={row.policy ? 'policy' : row.threshold} className={row.policy ? 'bg-primary/5 font-medium' : ''}>
                  <td className={`${TD} text-text`}>{row.policy ? 'القاعدة الحالية' : <span className="num">{percent(row.threshold)}</span>}</td>
                  <td className={`${TD} num text-left`}>{row.automated}</td>
                  <td className={`${TD} num text-left`}>{percent(row.rate)}</td>
                  <td className={`${TD} num text-left ${row.precision !== null && row.precision < 0.99 ? 'text-amber-700' : 'text-green-700'}`}>
                    {percent(row.precision)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h4 className="mb-1 text-xs font-semibold text-text">حقول الترويسة مقابل ما كُتب يدوياً</h4>
        <p className="mb-1 text-[11px] text-text-muted">
          يُقارَن ما قرأه النظام بقيمة الحقل المخصّص الذي يحمل الاسم نفسه (رقم، تاريخ، موضوع، جهة). حقل بلا
          مقابل يعني أن لا حقلاً مخصّصاً بهذا الاسم.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <th className={TH}>الحقل</th>
                <th className={TH}>الحقل المقابل</th>
                <th className={`${TH} text-left`}>قُرئ</th>
                <th className={`${TH} text-left`}>قورن</th>
                <th className={`${TH} text-left`}>مطابق</th>
                <th className={`${TH} text-left`}>قريب</th>
                <th className={`${TH} text-left`}>خطأ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {Object.entries(FIELD_LABELS).map(([role, label]) => {
                const row = metrics.fields?.[role];
                if (!row) return null;
                return (
                  <tr key={role}>
                    <td className={`${TD} text-text`}>{label}</td>
                    <td className={`${TD} text-xs text-text-muted`}>{row.fields.length ? row.fields.join('، ') : '—'}</td>
                    <td className={`${TD} num text-left`}>{row.extracted}</td>
                    <td className={`${TD} num text-left`}>{row.compared}</td>
                    <td className={`${TD} num text-left text-green-700`}>{row.match}</td>
                    <td className={`${TD} num text-left text-amber-700`}>{row.close}</td>
                    <td className={`${TD} num text-left text-red-600`}>{row.miss}{row.unverifiable ? ` (+${row.unverifiable} هجري)` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {Object.entries(metrics.fields ?? {}).some(([, row]) => row.examples?.length > 0) ? (
          <ul className="mt-2 space-y-1 text-xs">
            {Object.entries(metrics.fields).flatMap(([role, row]) =>
              (row.examples ?? []).slice(0, 5).map((example) => (
                <li key={`${role}-${example.documentId}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-muted/40 px-3 py-1.5">
                  <span className="text-text-muted">{FIELD_LABELS[role]}:</span>
                  <button type="button" onClick={() => onOpen(example.documentId)} className="text-primary hover:underline">
                    {example.title}
                  </button>
                  <span dir="auto">قُرئ «{example.read}»</span>
                  <span dir="auto" className="text-text-muted">والمكتوب «{example.typed ?? '—'}»</span>
                </li>
              )),
            )}
          </ul>
        ) : null}
      </section>

      {metrics.mismatches.length > 0 ? (
        <section>
          <h4 className="mb-1 text-xs font-semibold text-text">وثائق أخطأ النظام في نوعها</h4>
          <ul className="divide-y divide-border/50 rounded-lg border border-border text-xs">
            {metrics.mismatches.map((row) => (
              <li key={row.documentId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                <button type="button" onClick={() => onOpen(row.documentId)} className="min-w-0 truncate text-start text-primary hover:underline">
                  {row.title ?? `وثيقة ${row.documentId}`}
                </button>
                <span className="text-text-muted">
                  النوع {row.truth} — توقّع {row.predicted ?? 'شكلاً مجهولاً'}
                </span>
                <span className="flex items-center gap-2">
                  <DecisionBadge decision={row.decision} />
                  <ConfidenceBar value={row.confidence} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
