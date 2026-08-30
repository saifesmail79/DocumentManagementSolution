import { useCallback, useEffect, useState } from 'react';
import { ScanLine, StopCircle, RefreshCw, Upload } from 'lucide-react';

import { scanBridge, ScanBridgeError } from '../scanBridge.js';
import { pagesToPdfFile } from '../scanToPdf.js';
import { api } from '../api.js';
import { Button, TextField, Alert, Spinner } from './ui.jsx';

/**
 * Scanning panel.
 *
 * Graceful degradation is required by the integration guide, not optional: when
 * the bridge is absent this renders a short note and nothing else, so the
 * ordinary file upload beside it keeps working. That is what makes the helper
 * safe to roll out one machine at a time.
 */

/** Bridge error codes mapped to something a user can act on. */
const ERROR_MESSAGES = {
  no_scanner: 'لم يُعثر على ماسح ضوئي. تأكد من توصيله وتشغيله.',
  scanner_not_found: 'الماسح المحدد لم يعد متاحاً. حدّث القائمة وحاول مجدداً.',
  scanner_busy: 'هناك عملية مسح جارية. انتظر قليلاً ثم أعد المحاولة.',
  scanner_offline: 'الماسح غير متصل. تحقق من الجهاز.',
  paper_empty: 'ضع الأوراق في وحدة التغذية.',
  paper_jam: 'يوجد انحشار ورق. أزل الورق ثم حاول مجدداً.',
  paper_problem: 'مشكلة في الورق. تحقق منه ثم حاول مجدداً.',
  cover_open: 'أغلق غطاء الماسح.',
  warming_up: 'الجهاز قيد التهيئة. سيعاد المحاولة بعد لحظات.',
  user_intervention: 'الجهاز يحتاج تدخلاً يدوياً. تحقق من الماسح.',
  device_locked: 'برنامج آخر يستخدم الماسح. أغلقه ثم حاول مجدداً.',
  driver_error: 'فشل تعريف الجهاز. حاول مرة أخرى.',
  unsupported_setting: 'الإعدادات غير مدعومة. أعيدت القيم الافتراضية.',
  timeout: 'استغرق المسح وقتاً طويلاً.',
  cancelled: null, // deliberate; not an error the user needs told about
  origin_rejected: 'لم يُسمح لهذا الموقع باستخدام الماسح. راجع إعدادات Scan Bridge على هذا الجهاز.',
};

/** Warnings ride on a SUCCESSFUL scan — shown quietly, never as failures. */
const WARNING_MESSAGES = {
  duplex_unsupported_ignored: 'الجهاز لا يدعم المسح على الوجهين — تم المسح بوجه واحد.',
  max_pages_reached: 'تم بلوغ الحد الأقصى للصفحات — قد تبقى أوراق في وحدة التغذية.',
  cancelled_partial: 'تم الإيقاف — الصفحات الظاهرة هي ما تم مسحه.',
  dpi_adjusted: 'تم ضبط الدقة إلى أقرب قيمة يدعمها الجهاز.',
  dpi_not_configurable: 'الجهاز لا يسمح بضبط الدقة.',
  color_mode_not_configurable: 'الجهاز لا يسمح بضبط نمط الألوان.',
  feeder_unavailable_using_flatbed: 'لا توجد وحدة تغذية — تم استخدام السطح الزجاجي.',
  flatbed_unavailable_using_feeder: 'لا يوجد سطح زجاجي — تم استخدام وحدة التغذية.',
};

export default function ScanPanel({ folderId, onUploaded }) {
  const [status, setStatus] = useState('checking');
  const [scanners, setScanners] = useState([]);
  const [scannerId, setScannerId] = useState('');
  const [colorMode, setColorMode] = useState('gray');
  const [title, setTitle] = useState('');
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pages, setPages] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState(null);
  const [jobId, setJobId] = useState(null);

  const probe = useCallback(async () => {
    setStatus('checking');
    setError(null);
    try {
      const found = await scanBridge.discover({ force: true });
      if (!found) return setStatus('unavailable');
      if (found.incompatible) return setStatus('incompatible');

      const list = await scanBridge.scanners();
      setScanners(list.scanners ?? []);
      setScannerId(list.scanners?.find((s) => s.isDefault)?.id ?? list.scanners?.[0]?.id ?? '');
      setStatus('ready');
    } catch {
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  async function startScan() {
    setScanning(true);
    setError(null);
    setWarnings([]);
    try {
      // No timeout: a feeder run continues until the tray is empty.
      const result = await scanBridge.scan({
        scannerId: scannerId || undefined,
        colorMode,
        dpi: 300,
        source: 'auto',
      });

      setJobId(result.jobId);
      setPages(result.pages ?? []);
      setWarnings(result.warnings ?? []);
    } catch (caught) {
      if (caught instanceof ScanBridgeError) {
        const message = ERROR_MESSAGES[caught.code];
        // `cancelled` maps to null: the user asked for it, so no error toast.
        if (message !== null) setError(message ?? 'تعذر إتمام المسح.');
        if (caught.code === 'bridge_unavailable') setStatus('unavailable');
      } else {
        setError('تعذر الاتصال بالماسح.');
      }
    } finally {
      setScanning(false);
    }
  }

  async function stopScan() {
    try {
      await scanBridge.cancel(jobId);
    } catch {
      /* nothing running is not an error */
    }
  }

  async function uploadScan() {
    if (!pages.length || !folderId) return;
    setUploading(true);
    setError(null);
    try {
      const file = await pagesToPdfFile(pages, { title: title.trim() || undefined });
      // The same endpoint a picked file goes through — no separate scan path.
      await api.upload(folderId, file, { title: title.trim() || undefined });
      setPages([]);
      setWarnings([]);
      setTitle('');
      onUploaded?.();
    } catch {
      setError('تعذر رفع الوثيقة الممسوحة.');
    } finally {
      setUploading(false);
    }
  }

  if (status === 'checking') return <Spinner label="جارٍ البحث عن الماسح…" />;

  /*
   * Two different failures reach this branch and the browser cannot tell them
   * apart. When Scan Bridge refuses this site's origin, the refusal is blocked
   * by CORS before any response reaches us — fetch throws the same generic
   * network error it throws when nothing is listening at all. The
   * `origin_rejected` message above can therefore only appear for a request
   * that completes, which a rejected one never does.
   *
   * Claiming "not installed" for both sent someone hunting for an install they
   * already had. Naming both possibilities is the honest thing a browser can do.
   */
  if (status === 'unavailable') {
    return (
      <Alert tone="info">
        <p>
          تعذّر الوصول إلى أداة Scan Bridge على هذا الجهاز — إمّا أنّها غير مثبّتة أو غير
          مشغّلة، أو أنّ هذا الموقع غير مُصرّح له في إعداداتها. يمكنك رفع ملف من القرص
          كالمعتاد.
        </p>
        {/*
          The allowlist is matched against this exact origin, so naming it turns
          "it says not installed" into a report someone can act on. Without it,
          diagnosing means guessing which of localhost, a LAN address and the
          machine hostname the browser happened to use — they are different
          origins and only the ones on the list are served.
        */}
        <p className="mt-1 text-xs">
          العنوان الحالي:{' '}
          <span dir="ltr" className="font-mono">
            {window.location.origin}
          </span>
        </p>
      </Alert>
    );
  }

  if (status === 'incompatible') {
    return <Alert tone="warning">إصدار Scan Bridge غير متوافق. يرجى تحديث الأداة على هذا الجهاز.</Alert>;
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
          <ScanLine size={16} className="text-primary" />
          مسح ضوئي
        </h3>
        <button
          onClick={probe}
          title="تحديث قائمة الأجهزة"
          className="rounded-lg border border-border p-1.5 text-text-muted hover:bg-primary/10 hover:text-primary"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">الجهاز</span>
          <select
            value={scannerId}
            onChange={(event) => setScannerId(event.target.value)}
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
              focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {scanners.map((scanner) => (
              <option key={scanner.id} value={scanner.id}>
                {scanner.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">نمط الألوان</span>
          <select
            value={colorMode}
            onChange={(event) => setColorMode(event.target.value)}
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
              focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="gray">رمادي</option>
            <option value="color">ألوان</option>
            <option value="bw">أبيض وأسود</option>
          </select>
        </label>
      </div>

      <TextField
        label="عنوان الوثيقة"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="اتركه فارغاً لاستخدام اسم تلقائي"
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {warnings.length > 0 ? (
        <Alert tone="warning">
          <ul className="list-inside list-disc space-y-1">
            {warnings.map((warning) => (
              <li key={warning}>{WARNING_MESSAGES[warning] ?? warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {pages.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
          <p className="num mb-2 text-sm text-text">تم مسح {pages.length} صفحة</p>
          <div className="flex flex-wrap gap-2">
            {pages.slice(0, 8).map((page) => (
              <img
                key={page.index}
                src={`data:${page.mimeType};base64,${page.data}`}
                alt={`صفحة ${page.index + 1}`}
                className="h-24 rounded border border-border bg-surface object-contain"
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-row items-center gap-2">
        {pages.length > 0 ? (
          <Button icon={Upload} onClick={uploadScan} disabled={uploading}>
            {uploading ? 'جارٍ الرفع…' : 'حفظ كوثيقة'}
          </Button>
        ) : null}

        {scanning ? (
          // Labelled "stop after the current page", not "cancel": WIA cannot
          // abort a sheet already moving through the feeder.
          <Button variant="secondary" icon={StopCircle} onClick={stopScan}>
            إيقاف بعد الصفحة الحالية
          </Button>
        ) : (
          <Button variant="secondary" icon={ScanLine} onClick={startScan} disabled={!scannerId}>
            بدء المسح
          </Button>
        )}

        {scanning ? <span className="text-xs text-text-muted">جارٍ المسح…</span> : null}
      </div>
    </div>
  );
}
