/**
 * The «التوقيع» tab of a document: sign a page by hand, save it as a version.
 *
 * ─── What this screen is, and what it is not ────────────────────────────────
 *
 * A page of the document is rendered on the server and shown here as a picture;
 * the person draws over it with a pen, a finger or a mouse; on «حفظ التوقيع»
 * the drawing is sent up as one transparent PNG per drawn page and burnt into a
 * NEW version of the PDF or image. Nothing is overwritten — the version that was signed
 * stays exactly as it was, byte for byte, which is why the panel says so before
 * it saves and why the ledger underneath records which version each signature
 * landed on. The screen also says, once, in plain Arabic, that this produces a
 * facsimile of a handwritten signature with an audit trail and not a certified
 * electronic signature: the institute's legal question about Law No. 78 of 2012
 * is open, and a screen that stays quiet about it is the screen that answers it
 * wrongly.
 *
 * `onEnabled(false)` hides the tab entirely while the module's switch is off or
 * the caller cannot read the document — the same contract the recognition and
 * correspondence panels use, so the document page needs no knowledge of any of
 * the three.
 *
 * ─── Why the page arrives as a blob and not as an <img src> ─────────────────
 *
 * The page route answers 503 when Ghostscript is missing, 504 when a render
 * times out, 423 under a legal hold and 404 for a page that is not there. A
 * bare `<img src>` turns every one of those into the browser's broken-picture
 * glyph — under a live drawing surface, which would then be a canvas the person
 * can sign over nothing at all. So the image is fetched with `credentials:
 * 'include'` and its status inspected first, exactly as `api.previewRendition`
 * does, and the canvas is only mounted once real pixels exist.
 *
 * ─── Measuring late, on purpose ─────────────────────────────────────────────
 *
 * The document page keeps every tab mounted and hides the inactive ones with
 * `display:none`, where every measurement is zero. So nothing here measures at
 * mount: the geometry and the first page image are loaded when the person
 * presses «ابدأ التوقيع» (which they can only do with the tab open), the frame
 * width comes from a ResizeObserver that fires again when the tab is shown, and
 * the canvas takes its scale from `getBoundingClientRect()` at pointerdown.
 *
 * ─── The strokes live here ──────────────────────────────────────────────────
 *
 * `strokesByPage` is this component's state, not the canvas's: flipping pages
 * must not lose ink, the page strip marks which pages carry it, «تراجع» pops
 * the last stroke, and the export loops over the same lists the canvas drew
 * from. On a refusal the ink is KEPT — a save that fails because someone else
 * added a version is not a reason to make a person sign twice — and the only
 * thing that discards it is the person explicitly refreshing the document,
 * which says so first.
 *
 * Lifecycle state (`lifecycle_state`) is advisory everywhere in this system and
 * is deliberately not consulted here either; legal hold and check-out are the
 * rules that actually stop a write, and the server enforces both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Eraser,
  ExternalLink,
  Hand,
  Info,
  Maximize2,
  PenLine,
  RefreshCw,
  Save,
  Undo2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDateTime } from '../format.js';
import { Alert, Button, Card, Spinner } from './ui.jsx';
import { useDialogs } from './DialogProvider.jsx';
import InkCanvas, { drawStrokes } from './InkCanvas.jsx';

/*
 * Zoom steps, mirroring DocumentPreview's viewer so the two surfaces answer to
 * the same gestures. The one difference is the floor: the preview may shrink a
 * page to 5 % to show its shape, while a page nobody can aim a pen at is not a
 * zoom level for this screen.
 */
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;

/** Blue first: the ink Iraqi offices sign in. Both are opaque, so strokes never mix. */
const COLOURS = [
  { id: 'blue', label: 'أزرق', value: '#1d4ed8' },
  { id: 'black', label: 'أسود', value: '#111827' },
];

/** Nib widths in DISPLAYED pixels; the canvas scales them to the page's resolution. */
const WIDTHS = [
  { id: 'thin', label: 'رقيق', value: 1.5 },
  { id: 'medium', label: 'متوسط', value: 2.5 },
  { id: 'thick', label: 'عريض', value: 4 },
];

/*
 * Client-side ceilings, mirroring `config.signing.maxPagesPerRequest` (20) and
 * a margin under `config.signing.bodyLimitBytes` (25 MB). Neither is published
 * by any route today, so they are stated here rather than guessed at the moment
 * of the refusal: telling someone their twenty-third page is too many before
 * they draw on it is worth a duplicated constant. See the report — the status
 * route should carry both.
 */
const FALLBACK_MAX_PAGES = 20;
const FALLBACK_MAX_BODY_BYTES = 24 * 1024 * 1024;

/** The note column is nvarchar(500). */
const NOTE_LIMIT = 500;

/** Why a document cannot be signed, in the words the reader needs. */
const CANNOT_SIGN = {
  multi_file_document:
    'هذه الوثيقة متعددة الملفات، والتوقيع متاح للوثائق ذات الملف الواحد فقط (PDF أو صورة).',
  not_pdf: 'التوقيع متاح لملفات PDF والصور (JPEG وPNG وWebP وTIFF بصفحة واحدة). هذه الوثيقة بصيغة أخرى.',
  unsupported_format: 'التوقيع متاح لملفات PDF والصور (JPEG وPNG وWebP وTIFF بصفحة واحدة). هذه الوثيقة بصيغة أخرى.',
  pdf_not_allowed:
    'صيغة PDF غير مسموح بها في قائمة الامتدادات المسموحة، فلا يمكن حفظ إصدار موقّع. المراجعة من «الإدارة ← الإعدادات».',
  legal_hold: 'الوثيقة تحت حجز قانوني: لا يُضاف إليها إصدار جديد، والتوقيع إصدار جديد.',
  locked: 'الوثيقة محجوزة لدى شخص آخر. التوقيع ممكن بعد إعادتها.',
  forbidden: 'يلزم للتوقيع صلاحية القراءة وصلاحية الرفع على مجلد الوثيقة.',
  renderer_missing:
    'عرض صفحات الوثيقة يحتاج Ghostscript على الخادم وهو غير مُثبَّت. راجع مسؤول النظام.',
  not_found: 'لم تُعد الوثيقة موجودة.',
};

/** A refusal from the page-image route. */
const PAGE_ERROR = {
  renderer_missing: 'عرض الصفحات يحتاج Ghostscript على الخادم وهو غير مُثبَّت. راجع مسؤول النظام.',
  render_timeout: 'استغرق تجهيز الصفحة وقتاً أطول من المسموح. حاول مرة أخرى.',
  legal_hold: 'الوثيقة تحت حجز قانوني.',
  locked: 'الوثيقة محجوزة لدى شخص آخر.',
  forbidden: 'لا تملك صلاحية قراءة هذه الوثيقة.',
  not_found: 'الصفحة غير موجودة.',
  invalid_page: 'رقم الصفحة غير صحيح.',
  unreadable_pdf: 'تعذر قراءة ملف هذه الوثيقة.',
  unreadable_image: 'تعذر فتح ملف الصورة؛ قد يكون الملف تالفاً.',
  signing_disabled: 'أُوقف التوقيع من الإعدادات.',
  too_large:
    'هذه الصفحة أكبر من أن تُوقَّع بدقة العرض الحالية (قياس كبير مثل A0). راجع مسؤول النظام لتقليل '
    + 'دقة العرض، أو وقّع على نسخة بقياس أصغر.',
  busy: 'الخادم مشغول بتجهيز صفحات أخرى. حاول بعد لحظات.',
  render_failed: 'تعذر إنتاج صورة الصفحة على الخادم.',
  network: 'تعذر الوصول إلى الخادم. تحقق من الاتصال وحاول مجدداً.',
  undecodable: 'تعذر عرض صورة الصفحة.',
};

/** A refusal from the save. Every one of these keeps the ink on screen. */
const SAVE_ERROR = {
  signing_disabled: 'أُوقف التوقيع من الإعدادات أثناء العمل، فلم يُحفظ شيء.',
  conflict:
    'أُضيف إصدار جديد للوثيقة بعد فتح هذا التبويب، فلم يُحفظ التوقيع على إصدار قديم. حدّث الوثيقة ثم أعد التوقيع.',
  legal_hold: 'الوثيقة تحت حجز قانوني: لا يُضاف إليها إصدار جديد.',
  locked: 'الوثيقة محجوزة لدى شخص آخر، فلا يمكن إضافة إصدار.',
  forbidden: 'يلزم لحفظ التوقيع صلاحية الرفع على مجلد الوثيقة.',
  not_found: 'لم تُعد الوثيقة موجودة.',
  multi_file_document: 'التوقيع متاح للوثائق ذات الملف الواحد فقط.',
  not_pdf: 'التوقيع متاح لملفات PDF والصور فقط.',
  unsupported_format: 'التوقيع متاح لملفات PDF والصور فقط.',
  pdf_not_allowed: 'صيغة PDF غير مسموح بها في الإعدادات، فلا يمكن حفظ إصدار موقّع.',
  unreadable_pdf: 'تعذر قراءة ملف هذه الوثيقة، فلم يُحفظ التوقيع.',
  unreadable_image: 'تعذر فتح ملف الصورة، فلم يُحفظ التوقيع؛ قد يكون الملف تالفاً.',
  no_strokes: 'لا يوجد رسم ليُحفظ.',
  invalid_image: 'صورة التوقيع لا تطابق قياس الصفحة. حدّث الوثيقة وأعد الرسم.',
  invalid_page: 'رقم صفحة غير صحيح في طلب الحفظ.',
  too_large: 'حجم الرسم أكبر من المسموح. احفظ الصفحات على دفعات أقل.',
  too_many_pages: 'لا يمكن حفظ أكثر من العدد المسموح به من الصفحات في مرة واحدة.',
  renderer_missing: 'عرض الصفحات يحتاج Ghostscript على الخادم وهو غير مُثبَّت.',
  render_timeout: 'استغرق التجهيز وقتاً أطول من المسموح. حاول مرة أخرى.',
  storage_failed: 'تعذر تخزين الإصدار الموقّع. راجع مسؤول النظام.',
  blocked_extension: 'صيغة الملف غير مسموح بها في الإعدادات.',
};

function messageFor(map, code, fallback) {
  return (code && map[code]) || fallback;
}

/** Arabic for a thrown ApiError, with the server's own vocabulary as the key. */
function saveMessage(caught) {
  if (caught instanceof ApiError) {
    /*
     * A body cut off by the route's own limit never reaches the signing module,
     * so it carries Fastify's «Payload Too Large» and no `error` code of ours.
     * Without this the person would read the generic «حاول مجدداً» and try the
     * same too-large save again; the size sentence is the one that helps.
     */
    if (caught.status === 413) return SAVE_ERROR.too_large;

    const base = messageFor(SAVE_ERROR, caught.code, 'تعذر حفظ التوقيع. حاول مجدداً.');
    // The holder is an object — { name, since }, the same shape every other
    // client screen reads — so the name has to be taken off it rather than
    // interpolated whole, which prints «[object Object]».
    if (caught.code === 'locked' && caught.body?.lockedBy) {
      return `${base} الحاجز: ${caught.body.lockedBy.name ?? 'مستخدم آخر'}.`;
    }
    return base;
  }
  return 'تعذر حفظ التوقيع. تحقق من الاتصال وحاول مجدداً.';
}

/** The page image, fetched as bytes so a refusal is a sentence and not a broken glyph. */
async function fetchPageImage(documentId, page, version, signal) {
  let response;
  try {
    response = await fetch(api.signing.pageUrl(documentId, page, version), {
      credentials: 'include',
      signal,
    });
  } catch (caught) {
    if (caught?.name === 'AbortError') return { status: 'aborted' };
    return { status: 'error', code: 'network' };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { status: 'error', code: body?.error, httpStatus: response.status, detail: body?.detail ?? null };
  }

  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    // The canvas's backing store must be the image's natural size, so the size
    // has to be known before anything is drawn — hence a decode, not an onLoad
    // handler on a tag that would already be under the pen.
    const natural = await naturalSize(blobUrl);
    if (!(natural.w > 0 && natural.h > 0)) throw new Error('empty raster');
    return { status: 'ready', blobUrl, natural };
  } catch {
    URL.revokeObjectURL(blobUrl);
    return { status: 'error', code: 'undecodable' };
  }
}

function naturalSize(src) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => reject(new Error('decode failed'));
    probe.src = src;
  });
}

/**
 * The ledger rows, normalised.
 *
 * The route is free to name the signer and the version either way round; a
 * missing `isCurrent` is read as "current" so a silent omission never paints a
 * warning badge on every row.
 */
function signatureRows(signatures) {
  return (signatures ?? []).map((row, index) => ({
    key: String(row.signatureId ?? row.id ?? index),
    name: row.signedByName ?? row.displayName ?? row.signedBy ?? null,
    at: row.signedAt ?? null,
    version: row.version ?? row.versionNumber ?? null,
    pages: Array.isArray(row.pages) ? row.pages : parsePages(row.pagesJson),
    note: row.note ?? null,
    isCurrent: row.isCurrent !== false,
  }));
}

/**
 * The cache key for a rendered page.
 *
 * The version is part of it deliberately: a new version — someone else's upload,
 * or this person's own signature a moment ago — is different bytes, so the page
 * image of the version before it is the wrong picture to put a pen on. Keying by
 * page number alone is how a signature lands on a page that has since changed.
 */
function cacheKey(version, page) {
  return `${version}:${page}`;
}

function parsePages(pagesJson) {
  if (!pagesJson) return [];
  try {
    const parsed = JSON.parse(pagesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function SigningPanel({ documentId, canRead, onChanged, onCount, onEnabled }) {
  const { confirm } = useDialogs();

  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  // The signing surface, opened deliberately: loading a PDF's geometry costs a
  // parse on the server, and this panel is mounted on every document page.
  const [started, setStarted] = useState(false);
  const [geometry, setGeometry] = useState(null);
  const [geometryError, setGeometryError] = useState(null);
  const [page, setPage] = useState(1);
  const [pageState, setPageState] = useState({ status: 'idle' });
  // Bumped by «إعادة المحاولة» to re-enter the page-loading effect.
  const [reloads, setReloads] = useState(0);

  const [strokesByPage, setStrokesByPage] = useState(() => new Map());
  const [mode, setMode] = useState('draw');
  const [penOnly, setPenOnly] = useState(false);
  const [colour, setColour] = useState(COLOURS[0].value);
  const [lineWidth, setLineWidth] = useState(WIDTHS[1].value);
  const [zoom, setZoom] = useState(1);
  const [note, setNote] = useState('');

  /*
   * On a registered letter, writing on the page is a step in its paper trail,
   * and the trail must say which step: a head's instruction («تهميش») or a
   * signature or initials. An incoming letter is usually written on to give an
   * instruction; anything else, to sign. The signer can change it. On a
   * document that is not a letter the question is not asked.
   */
  const [letter, setLetter] = useState(null);
  const [letterAction, setLetterAction] = useState('endorsement');
  const instructing = letter !== null && letterAction === 'instruction';

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(null);

  // page → { blobUrl, natural }. A ref, not state: the blobs are identity, not
  // rendering input, and every one of them has to be revoked by hand.
  const images = useRef(new Map());
  const frameRef = useRef(null);
  const [frameWidth, setFrameWidth] = useState(0);

  const version = info?.version ?? null;

  const load = useCallback(async () => {
    if (!canRead) {
      onEnabled?.(false);
      return;
    }
    try {
      const [moduleStatus, described] = await Promise.all([
        api.signing.status(),
        api.signing.document(documentId).catch((caught) => {
          // While the switch is off this route answers 409; `status` still says
          // so cleanly, which is the whole reason it answers when disabled.
          if (caught instanceof ApiError && caught.code === 'signing_disabled') return null;
          throw caught;
        }),
      ]);
      setStatus(moduleStatus);
      setInfo(described);
      setError(null);
      onEnabled?.(moduleStatus.enabled === true && described?.canRead !== false);
      onCount?.(described?.signatures?.length ?? 0);
    } catch (caught) {
      // A missing route means an older server: behave as if the module is off.
      if (caught instanceof ApiError && caught.status === 404) onEnabled?.(false);
      else setError('تعذر تحميل حالة التوقيع.');
    }
  }, [documentId, canRead, onEnabled, onCount]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canRead || status?.enabled !== true) return undefined;
    let cancelled = false;
    api.correspondence
      .forDocument(documentId)
      .then((found) => {
        if (cancelled) return;
        const registered = found?.registered && found.letter?.status !== 'annulled' ? found.letter : null;
        setLetter(registered);
        setLetterAction(registered?.direction === 'in' ? 'instruction' : 'endorsement');
      })
      // Not a letter, or the register cannot be asked: sign as on any document.
      .catch(() => !cancelled && setLetter(null));
    return () => {
      cancelled = true;
    };
  }, [documentId, canRead, status?.enabled]);

  /** Drops every rendered page. Called whenever the bytes under the ink change. */
  const forgetPages = useCallback(() => {
    for (const entry of images.current.values()) URL.revokeObjectURL(entry.blobUrl);
    images.current.clear();
  }, []);

  // Blob URLs outlive the component unless revoked, and a signing session can
  // hold twenty full-page rasters.
  useEffect(() => forgetPages, [forgetPages]);

  /*
   * A different document means everything below belongs to the previous one.
   *
   * The document page does NOT remount this panel when the route's id changes —
   * it reloads in place — so without this the strip would still be marking
   * page 3 as drawn on, and the rasters of one document would be sitting under
   * another document's pen.
   */
  useEffect(() => {
    forgetPages();
    setStrokesByPage(new Map());
    setGeometry(null);
    setStarted(false);
    setPage(1);
    setPageState({ status: 'idle' });
    setNote('');
    setSaveError(null);
    setSaved(null);
  }, [documentId, forgetPages]);

  // Watched rather than measured once: this panel is hidden while another tab is
  // open, and becoming visible is itself a resize.
  useEffect(() => {
    const element = frameRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setFrameWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [started]);

  // The current page's image, from the cache or from the server.
  useEffect(() => {
    if (!started || !geometry || version === null) return undefined;
    // The geometry call already said this page's raster is over the ceiling:
    // nothing is fetched, and the person reads why instead of drawing on a
    // page that could never be saved.
    const described = geometry.pages?.find((entry) => entry.number === page);
    if (described && described.signable === false) {
      setPageState({ status: 'error', code: described.reason ?? 'too_large' });
      return undefined;
    }
    if (images.current.has(cacheKey(version, page))) {
      setPageState({ status: 'ready' });
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    setPageState({ status: 'loading' });

    (async () => {
      let result = await fetchPageImage(documentId, page, version, controller.signal);
      // A server-side failure or a dropped connection is tried once more, a
      // moment later, before it is shown: most such failures are momentary.
      if (result.status === 'error' && (result.code === 'network' || (result.httpStatus ?? 0) >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!cancelled) result = await fetchPageImage(documentId, page, version, controller.signal);
      }
      if (cancelled) {
        if (result.blobUrl) URL.revokeObjectURL(result.blobUrl);
        return;
      }
      if (result.status === 'ready') {
        images.current.set(cacheKey(version, page), {
          blobUrl: result.blobUrl,
          natural: result.natural,
        });
        setPageState({ status: 'ready' });
      } else if (result.status !== 'aborted') {
        setPageState(result);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [started, geometry, page, documentId, version, reloads]);

  const drawnPages = useMemo(
    () =>
      [...strokesByPage.entries()]
        .filter(([, strokes]) => strokes.length > 0)
        .map(([number]) => number)
        .sort((a, b) => a - b),
    [strokesByPage],
  );

  if (!canRead) return null;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!status) return <Spinner />;
  if (!status.enabled) return null;
  if (!info) return <Spinner />;

  const rows = signatureRows(info.signatures);
  const current = images.current.get(cacheKey(version, page)) ?? null;
  const strokes = strokesByPage.get(page) ?? [];

  function setPageStrokes(number, next) {
    setStrokesByPage((previous) => {
      const copy = new Map(previous);
      if (next.length === 0) copy.delete(number);
      else copy.set(number, next);
      return copy;
    });
  }

  async function start() {
    setGeometryError(null);
    setPageState({ status: 'loading' });
    try {
      const result = await api.signing.pages(documentId);
      setGeometry(result);
      setPage(1);
      setZoom(1);
      setStarted(true);
    } catch (caught) {
      setPageState({ status: 'idle' });
      setGeometryError(
        caught instanceof ApiError
          ? messageFor(PAGE_ERROR, caught.code, 'تعذر تجهيز صفحات الوثيقة.')
          : 'تعذر الوصول إلى الخادم. تحقق من الاتصال وحاول مجدداً.',
      );
    }
  }

  /*
   * A failed page render is usually a blip — a restarted server, a Ghostscript
   * that was busy — so it must be a state to leave rather than a place to stay.
   * The counter is what re-enters the loading effect: the page number has not
   * changed, and React would drop a set of the same value.
   */
  function retryPage() {
    images.current.delete(cacheKey(version, page));
    setPageState({ status: 'idle' });
    setReloads((value) => value + 1);
  }

  async function clearPage() {
    if (strokes.length === 0) return;
    const ok = await confirm({
      title: `مسح رسم الصفحة ${page}`,
      message: 'يُمسح كل ما رُسم على هذه الصفحة. رسم الصفحات الأخرى يبقى كما هو.',
      variant: 'warning',
      confirmLabel: 'مسح',
    });
    if (!ok) return;
    setPageStrokes(page, []);
  }

  /** One page's ink, drawn at the page image's own resolution — the server's contract. */
  function exportPage(number) {
    const entry = images.current.get(cacheKey(version, number));
    if (!entry) throw new Error(`page ${number} was never rendered`);
    const canvas = document.createElement('canvas');
    canvas.width = entry.natural.w;
    canvas.height = entry.natural.h;
    const ctx = canvas.getContext('2d');
    // The same routine the visible canvas uses, so what is stored is what was
    // seen. The canvas starts fully transparent, which is what the overlay is.
    drawStrokes(ctx, strokesByPage.get(number) ?? []);
    return canvas.toDataURL('image/png');
  }

  async function save() {
    setSaved(null);
    if (drawnPages.length === 0) {
      setSaveError('لا يوجد رسم ليُحفظ. ارسم التوقيع على صفحة واحدة على الأقل.');
      return;
    }
    // The server publishes its limits on the status route; the constants above
    // stand in only for an older server that does not.
    const maxPages = Number(status?.maxPagesPerRequest) || FALLBACK_MAX_PAGES;
    const maxBodyBytes = Number(status?.bodyLimitBytes)
      ? Math.floor(Number(status.bodyLimitBytes) * 0.95)
      : FALLBACK_MAX_BODY_BYTES;
    if (drawnPages.length > maxPages) {
      setSaveError(
        `لا يمكن حفظ أكثر من ${maxPages} صفحة في مرة واحدة، والرسم الآن على ${drawnPages.length} صفحة. `
          + 'احفظ بعض الصفحات أولاً ثم أكمل.',
      );
      return;
    }

    /*
     * A page can only carry ink if its image was rendered, so this is a
     * belt-and-braces check — but the export needs the raster's exact size, and
     * asking for a signature again is a far better outcome than sending an
     * overlay the server will refuse as `invalid_image`.
     */
    const missing = drawnPages.filter((number) => !images.current.has(cacheKey(version, number)));
    if (missing.length > 0) {
      setSaveError(
        `تعذر تجهيز صورة الصفحات ${missing.join('، ')}، فلا يمكن حفظ الرسم عليها. حدّث الوثيقة وأعد الرسم.`,
      );
      return;
    }

    const ok = await confirm({
      title: 'حفظ التوقيع',
      message: `سيُنشأ إصدار جديد يحمل التوقيع على الصفحات ${drawnPages.join('، ')}.`,
      detail:
        'لا يُحذف أي إصدار سابق، ويبقى الإصدار الحالي كما هو. لا يمكن إزالة التوقيع بعد حفظه إلا باستعادة '
        + 'إصدار سابق من تبويب «الإصدارات». ويُسجَّل مع التوقيع مَن وقّع ومتى وعلى أي إصدار.',
      confirmLabel: 'حفظ التوقيع',
    });
    if (!ok) return;

    setSaving(true);
    setSaveError(null);
    try {
      const payload = drawnPages.map((number) => ({ number, image: exportPage(number) }));
      /*
       * Measured the way the limit measures it: the body limit counts the JSON
       * that goes on the wire, where each overlay is its base64 data URL — about
       * a third larger than the PNG those characters decode to. Counting decoded
       * bytes let a ~23 MB drawing through the check and the route then cut the
       * ~31 MB request off with its own bare 413. The data URL is ASCII, so
       * `.length` is its octet count, and the +40 covers each page object's JSON
       * keys and quoting.
       */
      const bytes = payload.reduce((sum, item) => sum + item.image.length + 40, 0);
      if (bytes > maxBodyBytes) {
        setSaveError(
          'حجم الرسم أكبر من المسموح في طلب واحد. احفظ عدداً أقل من الصفحات في المرة، '
            + 'أو امسح الرسم الزائد وأعد المحاولة.',
        );
        setSaving(false);
        return;
      }

      const result = await api.signing.sign(documentId, {
        version: info.version,
        note: note.trim() || null,
        pages: payload,
        ...(letter ? { letterAction } : {}),
      });

      // The bytes under the ink have changed, so every rendered page and every
      // stroke belongs to a version that is no longer current.
      forgetPages();
      setStrokesByPage(new Map());
      setNote('');
      setGeometry(null);
      setStarted(false);
      setPageState({ status: 'idle' });
      // One sentence, whatever happened: the version, then the trail, then any
      // part that did not land.
      const trail = result?.letterTrail;
      setSaved(
        `حُفظ التوقيع${result?.version ? ` في الإصدار ${result.version}` : ''}`
          + (trail?.recorded
            ? ` وسُجّل في مسار الورقة «${trail.action === 'instruction' ? 'تهميش' : 'توقيع أو تأشير'}»${
              trail.action === 'instruction' && letter?.direction === 'in' ? ' وأُبلغ قلم الوارد' : ''
            }`
            : '')
          + (result?.ledger === false ? ' — تعذر تسجيل التوقيع في سجل التوقيعات، راجع مسؤول النظام' : '')
          + (letter && trail?.failed ? ' — تعذر تسجيله في مسار الورقة، فأبلغ قلم الوارد بما كتبت' : '')
          + '.',
      );
      await load();
      onChanged?.();
    } catch (caught) {
      // The ink stays: a refusal is not a reason to sign twice.
      setSaveError(saveMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function refreshDocument() {
    const ok = await confirm({
      title: 'تحديث الوثيقة',
      message: 'يُعاد تحميل حالة الوثيقة وصفحاتها من الخادم.',
      detail:
        'الرسم الحالي لا يُنقل إلى إصدار آخر: صور الصفحات تتغير مع تغيّر الإصدار، فيُمسح ما رُسم ويُبدأ من جديد.',
      variant: 'warning',
      confirmLabel: 'تحديث ومسح الرسم',
    });
    if (!ok) return;
    forgetPages();
    setStrokesByPage(new Map());
    setGeometry(null);
    setStarted(false);
    setPageState({ status: 'idle' });
    setSaveError(null);
    setSaved(null);
    await load();
  }

  const fit = current && frameWidth > 0 ? Math.min(frameWidth / current.natural.w, 1) : 1;
  const displayWidth = current ? Math.max(current.natural.w * fit * zoom, 40) : 0;

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
            <PenLine size={15} className="text-primary" />
            التوقيع بخط اليد
            {info.version ? (
              <span className="num text-xs font-normal text-text-muted">
                الإصدار الحالي {info.version}
              </span>
            ) : null}
          </h3>
          {info.filename ? (
            <span className="num truncate text-xs text-text-muted">{info.filename}</span>
          ) : null}
        </div>

        {/* The legal position, stated where the pen is and not in a manual. */}
        <div className="mt-3">
          <Alert tone="info">
            التوقيع هنا صورة خط اليد تُثبَّت على الصفحة، مع سجلٍّ بمن وقّع ومتى وعلى أي إصدار — وليس
            توقيعاً إلكترونياً مصدّقاً. حفظ التوقيع يُنشئ إصداراً جديداً ويبقي الإصدارات السابقة كما هي.
          </Alert>
        </div>

        {saved ? (
          <div className="mt-3">
            <Alert tone="success">{saved}</Alert>
          </div>
        ) : null}

        {info.canSign === false ? (
          <div className="mt-3">
            <Alert tone="warning">
              {messageFor(CANNOT_SIGN, info.reason, 'لا يمكن التوقيع على هذه الوثيقة.')}
              {/* `lockedBy` is { name, since }; naming the holder is the point of the line. */}
              {info.reason === 'locked' && info.lockedBy
                ? ` الحاجز: ${info.lockedBy.name ?? 'مستخدم آخر'}.`
                : ''}
            </Alert>
          </div>
        ) : null}

        {info.canSign !== false && !started ? (
          <div className="mt-3 flex flex-row flex-wrap items-center gap-2">
            <Button icon={PenLine} onClick={start} disabled={pageState.status === 'loading'}>
              ابدأ التوقيع
            </Button>
            <span className="text-xs text-text-muted">
              تُجهَّز صفحات الوثيقة للعرض عند الضغط، فلا تُحمَّل ما لم تكن بحاجة إليها.
            </span>
          </div>
        ) : null}

        {geometryError ? (
          <div className="mt-3 space-y-2">
            <Alert tone="error">{geometryError}</Alert>
            <Button variant="secondary" icon={RefreshCw} onClick={start} className="!px-3 !py-1 text-xs">
              إعادة المحاولة
            </Button>
          </div>
        ) : null}
      </Card>

      {started && geometry ? (
        <Card className="p-4">
          <PageStrip
            pageCount={geometry.pageCount ?? geometry.pages?.length ?? 1}
            page={page}
            drawn={drawnPages}
            unsignable={(geometry.pages ?? []).filter((entry) => entry.signable === false).map((entry) => entry.number)}
            onPick={setPage}
          />

          <InkToolbar
            mode={mode}
            onMode={setMode}
            penOnly={penOnly}
            onPenOnly={setPenOnly}
            colour={colour}
            onColour={setColour}
            lineWidth={lineWidth}
            onLineWidth={setLineWidth}
            zoom={zoom}
            onZoom={setZoom}
            canUndo={strokes.length > 0}
            onUndo={() => setPageStrokes(page, strokes.slice(0, -1))}
            onClear={clearPage}
            disabled={saving}
          />

          <div
            ref={frameRef}
            /*
              A scroll container, because a zoomed page is larger than the pane
              and «تحريك» is meant to move it. `touch-action` on the canvas
              decides whether a finger scrolls this box or draws.
            */
            className="mt-3 max-h-[70vh] overflow-auto rounded-lg border border-border bg-surface-muted p-2"
          >
            {pageState.status === 'loading' ? (
              <Spinner label="جارٍ تجهيز الصفحة…" />
            ) : pageState.status === 'error' ? (
              <div className="space-y-2 p-2">
                <Alert tone="error">
                  {messageFor(PAGE_ERROR, pageState.code, 'تعذر تجهيز صورة الصفحة.')}
                  {!PAGE_ERROR[pageState.code] && (pageState.code || pageState.httpStatus)
                    ? <span className="num"> ({pageState.code ?? 'HTTP ' + pageState.httpStatus})</span>
                    : null}
                  {pageState.detail ? <span className="block text-xs opacity-80" dir="ltr">{pageState.detail}</span> : null}
                </Alert>
                <Button
                  variant="secondary"
                  icon={RefreshCw}
                  onClick={retryPage}
                  className="!px-3 !py-1 text-xs"
                >
                  إعادة المحاولة
                </Button>
              </div>
            ) : current ? (
              <div
                className="relative mx-auto"
                style={{
                  width: Math.round(displayWidth),
                  height: Math.round(displayWidth * (current.natural.h / current.natural.w)),
                }}
              >
                <img
                  src={current.blobUrl}
                  alt={`الصفحة ${page}`}
                  draggable={false}
                  className="absolute left-0 top-0 h-full w-full select-none rounded border border-border bg-surface"
                />
                <InkCanvas
                  width={current.natural.w}
                  height={current.natural.h}
                  displayWidth={displayWidth}
                  strokes={strokes}
                  onStrokesChange={(next) => setPageStrokes(page, next)}
                  colour={colour}
                  lineWidth={lineWidth}
                  mode={mode}
                  penOnly={penOnly}
                  disabled={saving}
                />
              </div>
            ) : (
              <Spinner label="جارٍ تجهيز الصفحة…" />
            )}
          </div>

          <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
            {letter ? (
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-sm font-medium text-text">
                  ما الذي تكتبه على الكتاب {letter.reference}؟
                </legend>
                <div className="flex flex-row flex-wrap gap-2">
                  {[
                    ['instruction', 'تهميش (توجيه)'],
                    ['endorsement', 'توقيع أو تأشير'],
                  ].map(([value, label]) => (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                        letterAction === value
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-text-muted hover:text-text'
                      }`}
                    >
                      <input
                        type="radio"
                        name="letter-action"
                        value={value}
                        checked={letterAction === value}
                        onChange={() => setLetterAction(value)}
                        className="accent-primary"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-text-muted">
                  يُسجَّل في «مسار الورقة» باسمك{instructing ? '، ويُبلَّغ قلم الوارد ليُحيل الكتاب بحسبه' : ''}.
                </p>
              </fieldset>
            ) : null}
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                {instructing ? 'نص التهميش (يظهر لقلم الوارد وفي مسار الورقة)' : 'ملاحظة مع التوقيع (اختياري)'}
              </span>
              <textarea
                dir="rtl"
                rows={2}
                value={note}
                maxLength={NOTE_LIMIT}
                onChange={(event) => setNote(event.target.value)}
                placeholder={instructing ? 'مثال: الشؤون المالية والشؤون القانونية لإبداء الرأي خلال أسبوع' : 'مثال: موافق على الصرف'}
                className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                  placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
            {note.length >= NOTE_LIMIT * 0.8 ? (
              <p className="num text-xs text-text-muted">
                {note.length}/{NOTE_LIMIT}
              </p>
            ) : null}

            <p className="text-xs text-text-muted">
              {drawnPages.length === 0
                ? 'لم يُرسم شيء بعد. الرسم على أكثر من صفحة يُحفظ في إصدار واحد.'
                : `الصفحات التي تحمل رسماً: ${drawnPages.join('، ')}`}
            </p>

            {saveError ? <Alert tone="error">{saveError}</Alert> : null}

            <div className="flex flex-row flex-wrap items-center gap-2">
              <Button icon={Save} onClick={save} disabled={saving || drawnPages.length === 0}>
                {saving ? 'جارٍ حفظ التوقيع…' : 'حفظ التوقيع'}
              </Button>
              {saveError ? (
                <Button
                  variant="secondary"
                  icon={RefreshCw}
                  onClick={save}
                  disabled={saving}
                  className="!px-3 !py-1 text-xs"
                >
                  إعادة المحاولة
                </Button>
              ) : null}
              <Button
                variant="secondary"
                icon={RefreshCw}
                onClick={refreshDocument}
                disabled={saving}
                className="!px-3 !py-1 text-xs"
              >
                تحديث الوثيقة
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              «تحديث الوثيقة» يُعيد تحميل حالتها وصفحاتها ويمسح الرسم الحالي، لأن الرسم لا يُنقل بين
              الإصدارات.
            </p>
          </div>
        </Card>
      ) : null}

      <SignatureLedger rows={rows} documentId={documentId} />
    </div>
  );
}

/**
 * The page selector, marking pages that carry unsaved ink.
 *
 * A strip of numbers rather than a bare «next/previous» pair: a signature goes
 * on the last page, an initial on every page, and neither is reachable in one
 * gesture from a counter. The dot is the load-bearing part — it is the only
 * thing that says «you drew on page 3» once page 7 is on screen.
 */
function PageStrip({ pageCount, page, drawn, unsignable = [], onPick }) {
  const numbers = Array.from({ length: Math.max(pageCount, 1) }, (_, index) => index + 1);
  const marked = new Set(drawn);
  const blocked = new Set(unsignable);

  return (
    <div className="flex flex-row flex-wrap items-center gap-2">
      {/* RTL: ChevronRight points backwards on screen, ChevronLeft forwards. */}
      <ToolButton
        icon={ChevronRight}
        label="الصفحة السابقة"
        disabled={page <= 1}
        onClick={() => onPick(page - 1)}
      />
      <div className="flex min-w-0 flex-1 flex-row gap-1 overflow-x-auto py-1">
        {numbers.map((number) => {
          const active = number === page;
          return (
            <button
              key={number}
              type="button"
              onClick={() => onPick(number)}
              title={
                blocked.has(number)
                  ? `الصفحة ${number} — لا يمكن التوقيع عليها`
                  : marked.has(number)
                    ? `الصفحة ${number} — تحمل رسماً`
                    : `الصفحة ${number}`
              }
              className={`num relative shrink-0 rounded-lg border px-2.5 py-1 text-xs transition-colors
                ${
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : blocked.has(number)
                      ? 'border-dashed border-border bg-surface-muted text-text-muted line-through'
                      : 'border-border bg-surface text-text-muted hover:bg-primary/5 hover:text-primary'
                }`}
            >
              {number}
              {marked.has(number) ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 left-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <ToolButton
        icon={ChevronLeft}
        label="الصفحة التالية"
        disabled={page >= pageCount}
        onClick={() => onPick(page + 1)}
      />
      <span className="num shrink-0 text-xs text-text-muted">
        {page}/{pageCount}
      </span>
    </div>
  );
}

/** Ink, mode, zoom and the two undo gestures, in one row above the page. */
function InkToolbar({
  mode,
  onMode,
  penOnly,
  onPenOnly,
  colour,
  onColour,
  lineWidth,
  onLineWidth,
  zoom,
  onZoom,
  canUndo,
  onUndo,
  onClear,
  disabled,
}) {
  const step = (factor) =>
    onZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor)));

  return (
    <div className="mt-3 flex flex-row flex-wrap items-center gap-2 border-t border-border/60 pt-3">
      {/*
        Mode first, because it is the control that explains the others: while
        «رسم» is on, a finger draws instead of scrolling, and that is the single
        most surprising thing about a drawing surface on a tablet.
      */}
      <div className="flex flex-row gap-1">
        <ModeButton
          icon={PenLine}
          label="رسم"
          active={mode === 'draw'}
          disabled={disabled}
          onClick={() => onMode('draw')}
        />
        <ModeButton
          icon={Hand}
          label="تحريك"
          active={mode === 'pan'}
          disabled={disabled}
          onClick={() => onMode('pan')}
        />
      </div>

      <span className="h-5 w-px bg-border" />

      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <input
          type="checkbox"
          checked={penOnly}
          disabled={disabled}
          onChange={(event) => onPenOnly(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary/40"
        />
        القلم فقط
      </label>

      <span className="h-5 w-px bg-border" />

      <div className="flex flex-row items-center gap-1">
        {COLOURS.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => onColour(option.value)}
            title={`لون الحبر: ${option.label}`}
            aria-label={`لون الحبر: ${option.label}`}
            className={`h-6 w-6 rounded-full border-2 transition-colors disabled:opacity-40
              ${colour === option.value ? 'border-primary' : 'border-border'}`}
            style={{ backgroundColor: option.value }}
          />
        ))}
      </div>

      <div className="flex flex-row items-center gap-1">
        {WIDTHS.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => onLineWidth(option.value)}
            title={`سماكة القلم: ${option.label}`}
            className={`rounded-lg border px-2 py-1 text-xs transition-colors disabled:opacity-40
              ${
                lineWidth === option.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-surface text-text-muted hover:text-primary'
              }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <span className="h-5 w-px bg-border" />

      <div dir="ltr" className="flex flex-row items-center gap-0.5">
        <ToolButton
          icon={ZoomOut}
          label="تصغير"
          disabled={disabled || zoom <= ZOOM_MIN}
          onClick={() => step(1 / ZOOM_STEP)}
        />
        <button
          type="button"
          onClick={() => onZoom(1)}
          title="ملاءمة العرض"
          className="num min-w-[3.25rem] rounded px-1 py-0.5 text-[11px] text-text-muted
            transition-colors hover:bg-primary/10 hover:text-primary"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ToolButton
          icon={ZoomIn}
          label="تكبير"
          disabled={disabled || zoom >= ZOOM_MAX}
          onClick={() => step(ZOOM_STEP)}
        />
        <ToolButton icon={Maximize2} label="ملاءمة العرض" disabled={disabled} onClick={() => onZoom(1)} />
      </div>

      <span className="h-5 w-px bg-border" />

      <Button
        variant="secondary"
        icon={Undo2}
        disabled={disabled || !canUndo}
        onClick={onUndo}
        className="!px-3 !py-1 text-xs"
      >
        تراجع
      </Button>
      <Button
        variant="danger"
        icon={Eraser}
        disabled={disabled || !canUndo}
        onClick={onClear}
        className="!px-3 !py-1 text-xs"
      >
        مسح الصفحة
      </Button>
    </div>
  );
}

function ModeButton({ icon: Icon, label, active, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors
        disabled:cursor-not-allowed disabled:opacity-40
        ${
          active
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border bg-surface text-text-muted hover:text-primary'
        }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function ToolButton({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded p-1.5 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary
        disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon size={14} />
    </button>
  );
}

/**
 * The signatures already on this document.
 *
 * Every row names the version it landed on, because that is the only thing that
 * makes a facsimile signature auditable: a signature is a statement about a
 * particular set of bytes, and once a later version exists the statement is
 * about the older one. The link opens that exact version rather than the
 * current file, and the badge says so in words.
 */
function SignatureLedger({ rows, documentId }) {
  return (
    <Card className="p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text">
        <Info size={15} className="text-primary" />
        التوقيعات على هذه الوثيقة
        <span className="num text-xs font-normal text-text-muted">{rows.length}</span>
      </h3>

      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">لا توجد توقيعات محفوظة على هذه الوثيقة.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.map((row) => (
            <li key={row.key} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text">{row.name ?? '—'}</span>
                <span className="num text-xs text-text-muted">
                  {row.at ? formatDateTime(row.at) : '—'}
                </span>
                {row.version ? (
                  <span className="num text-xs text-text-muted">الإصدار {row.version}</span>
                ) : null}
                {row.pages.length > 0 ? (
                  <span className="num text-xs text-text-muted">
                    الصفحات {row.pages.join('، ')}
                  </span>
                ) : null}
              </div>

              {row.note ? <p className="mt-1 text-xs text-text">{row.note}</p> : null}

              {row.version ? (
                <a
                  href={api.contentUrl(documentId, row.version)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink size={12} />
                  عرض هذا الإصدار
                </a>
              ) : null}

              {!row.isCurrent ? (
                <div className="mt-2">
                  <Alert tone="warning">
                    <span className="inline-flex items-center gap-1.5">
                      <AlertTriangle size={13} />
                      هذا التوقيع على إصدار سابق؛ أُضيف للوثيقة إصدار أحدث بعده.
                    </span>
                  </Alert>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
