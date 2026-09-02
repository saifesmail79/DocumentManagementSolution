/**
 * Reads one document in place, beside the list it was picked from.
 *
 * The point is to answer "is this the right one?" without leaving the folder.
 * Opening the document page to find out costs a navigation, a metadata load and
 * a navigation back, and after three wrong guesses people stop checking and
 * download everything instead — which is the habit the whole system exists to
 * end.
 *
 * ─── Four ways to show a file, chosen by type ───────────────────────────────
 *
 *   image  PNG/JPEG/GIF/WebP — the stored file, drawn directly. No rendition
 *          exists for these because none is needed.
 *   pdf    an iframe onto the content route, which serves byte ranges, so the
 *          browser's own viewer fetches page 1 and not the whole file.
 *   text   fetched as text and printed. Deliberately NOT an iframe: the content
 *          route is same-origin, so an uploaded .html rendered in one would run
 *          its script against the viewer's own session. Only text/plain-shaped
 *          types come here; anything else falls through to a rendition, and a
 *          rendition of an HTML file is a download button.
 *   other  Office and TIFF, via the preview rendition the worker produces. This
 *          is the branch that has to handle "not ready yet" honestly.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Download,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  Layers,
  Lock,
  Maximize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { api } from '../api.js';
import { formatBytes, formatDateTime } from '../format.js';

/**
 * Where a descriptor's bytes live.
 *
 * A constituent of a multi-file document has its own content route; the content
 * route for the document itself refuses those by design, so every branch that
 * fetches bytes has to ask through here rather than assume.
 */
function contentHref(doc) {
  return doc.fileId ? api.fileContentUrl(doc.documentId, doc.fileId) : api.contentUrl(doc.documentId);
}

/** Types every browser draws unaided. */
const BROWSER_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

/**
 * Types safe to print as text. Narrow on purpose — `text/html`, `image/svg+xml`
 * and friends are text too, and are exactly the ones that must not be rendered.
 */
const PLAIN_TEXT = /^text\/(plain|csv|markdown|tab-separated-values)$/;

/** How much of a text file to pull. Enough to judge it, not enough to hang the tab. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

/**
 * How a given type should be shown: `image`, `pdf`, `text`, `rendition`, or
 * `unknown` when there is no type to go on.
 *
 * Exported because the document page has to make the same judgement, and two
 * copies of a list whose whole purpose is to exclude `text/html` is exactly the
 * list that drifts.
 */
export function previewMode(mimeType) {
  const mime = String(mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (!mime) return 'unknown';
  if (BROWSER_IMAGE.test(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (PLAIN_TEXT.test(mime)) return 'text';
  return 'rendition';
}

/**
 * @param {object}   props
 * @param {object}   [props.document] The row being previewed; null shows the resting state.
 * @param {Function} [props.onStep]   Called with -1 / +1 to move to the neighbouring row.
 * @param {Function} [props.onOpen]   Opens the full document page.
 * @param {Function} [props.onClose]  Closes the pane.
 * @param {number}   [props.position] 1-based index of the row, for the counter.
 * @param {number}   [props.total]    How many rows there are.
 */
export default function DocumentPreview({
  document: doc,
  onStep,
  onOpen,
  onClose,
  position,
  total,
}) {
  const documentId = doc?.documentId ?? null;
  const readable = Boolean(doc?.canRead);
  // A multi-file document has no single blob to preview, and its mimeType comes
  // back null for exactly that reason — which `previewMode` would otherwise read
  // as an unrecognised file type and report as if something were wrong with it.
  const mode = useMemo(
    () => (!readable ? 'denied' : doc?.multiFile ? 'multifile' : previewMode(doc?.mimeType)),
    [readable, doc?.multiFile, doc?.mimeType],
  );

  return (
    <aside
      aria-label="معاينة الوثيقة"
      /*
        A definite height, not a max-height: the body is a flex child and the
        iframe inside it asks for `h-full`, which resolves to nothing unless
        something above it has a real height to divide up.

        `sticky` works here because the grid sets `items-start`, so this box is
        shorter than its grid area and has somewhere to travel. Stretched to fill
        the area — the default — it would have nowhere to stick to.
      */
      className="sticky top-4 flex h-[calc(100vh-7rem)] min-h-[26rem] flex-col
        overflow-hidden rounded-xl border border-border bg-surface"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileText size={15} className="shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text" title={doc?.title ?? ''}>
            {doc?.title ?? 'المعاينة'}
          </p>
          {doc ? (
            <p className="truncate text-[11px] text-text-muted">
              {[
                doc.originalFilename,
                doc.bytes ? formatBytes(doc.bytes) : null,
                doc.createdAt ? formatDateTime(doc.createdAt) : null,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
          ) : null}
        </div>

        {/* RTL: ChevronRight points backwards on screen, ChevronLeft forwards. */}
        {onStep && total > 1 ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <PaneButton label="السابق" icon={ChevronRight} onClick={() => onStep(-1)} />
            <span className="num px-1 text-[11px] text-text-muted">
              {position ?? '—'}/{total}
            </span>
            <PaneButton label="التالي" icon={ChevronLeft} onClick={() => onStep(1)} />
          </div>
        ) : null}

        {onClose ? <PaneButton label="إغلاق المعاينة" icon={X} onClick={onClose} /> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-surface-muted">
        {!doc ? (
          <Resting
            icon={FileText}
            title="لم تُحدَّد وثيقة"
            hint="مرِّر المؤشر فوق صف أو اخترْه لعرضه هنا."
          />
        ) : (
          <PreviewBody key={documentId} document={doc} mode={mode} />
        )}
      </div>

      {doc ? (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
          {readable ? (
            // The content route refuses a multi-file document by design, so
            // both links point at the archive instead of at a 409.
            doc.multiFile ? (
              <FooterLink
                href={api.filesZipUrl(documentId)}
                icon={Download}
                label="تنزيل الكل"
                download={`${doc.title}.zip`}
              />
            ) : (
              <>
                <FooterLink
                  href={api.contentUrl(documentId)}
                  icon={ExternalLink}
                  label="فتح في تبويب"
                />
                <FooterLink
                  href={api.contentUrl(documentId)}
                  icon={Download}
                  label="تنزيل"
                  download={doc.originalFilename || doc.title}
                />
              </>
            )
          ) : null}
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(doc)}
              className="ms-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs
                text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <Maximize2 size={13} />
              التفاصيل
            </button>
          ) : null}
        </footer>
      ) : null}
    </aside>
  );
}

/** The body, one branch per mode. Remounted per document by the caller's key. */
/**
 * The preview itself, without the pane's chrome.
 *
 * Exported because the document page needs exactly this and had grown its own,
 * narrower version: an iframe for the handful of types a browser opens unaided,
 * and "cannot be displayed" for everything else. That answer was wrong for
 * Office files — the worker converts them to PDF and the rendition was sitting
 * in the database, unrequested, because that page never asked for one.
 *
 * @param {object} props
 * @param {object} props.document `{ documentId, title, canRead, mimeType, multiFile, fileCount }`
 * @param {string} props.mode     From `previewMode`, or 'denied' / 'multifile'.
 */
export function PreviewBody({ document: doc, mode }) {
  const documentId = doc.documentId;

  if (mode === 'denied') {
    return (
      <Resting
        icon={Lock}
        title="عرض الاسم فقط"
        hint="ليست لديك صلاحية قراءة هذه الوثيقة، لذا لا يمكن عرض محتواها."
      />
    );
  }

  if (mode === 'multifile') {
    return (
      <Resting
        icon={Layers}
        title={`وثيقة من ${doc.fileCount} ملفات`}
        hint="افتح التفاصيل لتصفّح ملفاتها، أو نزّلها جميعاً في ملف مضغوط."
      />
    );
  }

  if (mode === 'image') return <ImagePreview document={doc} />;

  if (mode === 'pdf') {
    return (
      <iframe
        title={doc.title}
        src={contentHref(doc)}
        className="h-full min-h-[24rem] w-full border-0 bg-surface-muted"
      />
    );
  }

  if (mode === 'text') return <TextPreview document={doc} />;

  if (mode === 'unknown') {
    return (
      <Resting
        icon={Info}
        title="لا تتوفر معلومات النوع"
        hint="افتح الوثيقة لعرض محتواها."
      />
    );
  }

  return <RenditionPreview document={doc} />;
}

/** Zoom steps, and the range a page stays useful within. */
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

/**
 * The viewer for anything that is a picture: stored images and scan renditions.
 *
 * ─── Why this exists rather than an <img> ───────────────────────────────
 *
 * A PDF gets a real viewer for free — every browser ships one, with zoom, rotate,
 * page navigation and print already in it. An image gets nothing: the tag draws
 * the pixels and that is the end of it. So the two halves of the preview were
 * never comparable, and putting a scan through the plain tag quietly took away
 * every control the same document would have had as a PDF.
 *
 * That gap matters most for exactly the documents this system holds. A page
 * scanned at 300dpi is 2550×4200; fitted into an 800px pane it is a grey smudge,
 * and unfitted it is a corner. And scans arrive sideways — the extractor already
 * corrects upside-down pages because that is how often it happens — so a reader
 * needs to turn one without going back to the scanner.
 *
 * ─── Fitting, with rotation accounted for ─────────────────────────────
 *
 * The scale is computed rather than left to `max-height`, because a percentage
 * maximum resolves against the parent's height and silently becomes `none` when
 * that height is `auto` — which is how a 4200px scan came to be drawn at full
 * size inside a 700px box, clipped, with no scrollbar to admit it.
 *
 * Rotating swaps which dimension is constrained, so the fit is recomputed from
 * the turned bounds; fitting a 90°-rotated page against its unrotated width is
 * how a viewer ends up with the page half off the screen.
 *
 * The image is positioned absolutely inside a box sized to its rotated bounds.
 * In flow it would contribute its *unrotated* box to the scroll area, so a
 * turned page would produce scrollbars for space that is not there.
 */
function ImageViewer({ src, alt, onLoad, onError, faded }) {
  const frameRef = useRef(null);
  const [box, setBox] = useState(null);
  const [natural, setNatural] = useState(null);
  const [rotation, setRotation] = useState(0);
  // null means "fit" — a mode, not a number, so the fit survives a resize.
  const [zoom, setZoom] = useState(null);

  // Watched, not measured once: the pane changes size with the window, with the
  // preview being opened, and with the browser's own zoom.
  useEffect(() => {
    const element = frameRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      setBox({ w: Math.round(rect.width), h: Math.round(rect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const turned = rotation % 180 !== 0;
  const shown = natural
    ? { w: turned ? natural.h : natural.w, h: turned ? natural.w : natural.h }
    : null;

  // Fitting never enlarges. Blowing a 200px logo up to fill a 900px pane makes a
  // perfectly good file look like a ruined scan.
  const fitScale =
    shown && box && shown.w > 0 && shown.h > 0
      ? Math.min(box.w / shown.w, box.h / shown.h, 1)
      : 1;

  const atFit = zoom === null;
  const scale = atFit ? fitScale : zoom;

  const step = (factor) =>
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (atFit ? fitScale : zoom) * factor)));

  const turn = (degrees) => setRotation((current) => (current + degrees + 360) % 360);

  return (
    <div className="relative h-full min-h-[24rem]">
      <div ref={frameRef} className="h-full w-full overflow-auto">
        <div
          className="relative min-h-full min-w-full"
          style={shown ? { width: shown.w * scale, height: shown.h * scale } : undefined}
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(event) => {
              setNatural({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              });
              onLoad?.(event);
            }}
            onError={onError}
            onClick={() => setZoom(atFit ? 1 : null)}
            style={
              natural
                ? {
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: natural.w * scale,
                    height: natural.h * scale,
                    // Centred first, then turned about that centre, so rotation
                    // never moves the page off the middle of the frame.
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  }
                : undefined
            }
            className={`max-w-none select-none rounded border border-border bg-surface
              transition-opacity duration-200 ${faded ? 'opacity-0' : 'opacity-100'}
              ${atFit ? 'cursor-zoom-in' : 'cursor-zoom-out'}`}
          />
        </div>
      </div>

      {/*
        The same controls the browser's PDF viewer offers, so the two preview
        surfaces answer to the same expectations. Floating over the page rather
        than stealing a row from it: the frame is already the scarce thing.
      */}
      {natural ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <div
            dir="ltr"
            className="pointer-events-auto flex items-center gap-0.5 rounded-lg border
              border-border bg-surface/95 p-1 shadow-md backdrop-blur"
          >
            <ViewerButton
              icon={ZoomOut}
              label="تصغير"
              onClick={() => step(1 / ZOOM_STEP)}
              disabled={scale <= ZOOM_MIN}
            />
            <button
              type="button"
              onClick={() => setZoom(null)}
              title="ملاءمة الإطار"
              className="num min-w-[3.25rem] rounded px-1 py-0.5 text-[11px] text-text-muted
                transition-colors hover:bg-primary/10 hover:text-primary"
            >
              {Math.round(scale * 100)}%
            </button>
            <ViewerButton
              icon={ZoomIn}
              label="تكبير"
              onClick={() => step(ZOOM_STEP)}
              disabled={scale >= ZOOM_MAX}
            />

            <span className="mx-1 h-4 w-px bg-border" />

            <ViewerButton icon={RotateCcw} label="تدوير لليسار" onClick={() => turn(-90)} />
            <ViewerButton icon={RotateCw} label="تدوير لليمين" onClick={() => turn(90)} />

            <span className="mx-1 h-4 w-px bg-border" />

            <ViewerButton
              icon={Maximize2}
              label="ملاءمة الإطار"
              onClick={() => {
                setZoom(null);
                setRotation(0);
              }}
              active={atFit && rotation === 0}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ViewerButton({ icon: Icon, label, onClick, disabled, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${active ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-primary/10 hover:text-primary'}`}
    >
      <Icon size={14} />
    </button>
  );
}

/**
 * The stored image, with the thumbnail standing in until it arrives.
 *
 * A full-page scan is megabytes; showing nothing while it loads makes a working
 * preview look broken, and the thumbnail is already cached from the row.
 */
function ImagePreview({ document: doc }) {
  /*
   * ─── Failure is a state to leave, not a place to stay ─────────────────────
   *
   * The error state used to be terminal: one failed image request and the pane
   * said "تعذّر عرض الصورة" until something happened to remount it. For a
   * folder with several rows that is hidden by accident — hovering another row
   * and coming back remounts the pane. For a folder with one row there is
   * nothing to hover, and the only way out was leaving the folder entirely.
   * Which is exactly what a person did, seconds after uploading a photo, when
   * the image request happened to race a server restart.
   *
   * A failed image request is usually that shape — a blip, not a verdict: the
   * app was open across a redeploy, the network hiccuped, the proxy came up a
   * beat late. So the first failure retries itself after a moment, quietly.
   * Only a second failure is shown, and it is shown with the retry button,
   * because by then the person knows something the code does not — whether the
   * server is back — and the pane must not pretend the question is settled.
   *
   * Each attempt carries a counter in the URL: without it, the retried <img>
   * can be served the browser's memory of the failure instead of a request.
   */
  const [state, setState] = useState({ status: 'loading', attempt: 0 });

  useEffect(() => {
    if (state.status !== 'retrying') return undefined;
    const timer = setTimeout(
      () => setState((current) => ({ status: 'loading', attempt: current.attempt + 1 })),
      1500,
    );
    return () => clearTimeout(timer);
  }, [state.status]);

  const base = contentHref(doc);
  const src = state.attempt > 0 ? `${base}${base.includes('?') ? '&' : '?'}retry=${state.attempt}` : base;

  if (state.status === 'error') {
    return (
      <Resting
        icon={Info}
        title="تعذّر عرض الصورة"
        hint="قد يكون الخادم أعيد تشغيله للتو. أعد المحاولة، أو نزِّل الملف لفتحه في تطبيق خارجي."
        action={{
          label: 'إعادة المحاولة',
          onClick: () => setState((current) => ({ status: 'loading', attempt: current.attempt + 1 })),
        }}
      />
    );
  }

  return (
    <div className="relative h-full min-h-[24rem]">
      {state.status !== 'ready' ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-xs">جارٍ التحميل…</span>
        </div>
      ) : null}

      <ImageViewer
        key={src}
        src={src}
        alt={doc.title}
        faded={state.status !== 'ready'}
        onLoad={() => setState((current) => ({ status: 'ready', attempt: current.attempt }))}
        onError={() =>
          setState((current) =>
            current.attempt === 0
              ? { status: 'retrying', attempt: current.attempt }
              : { status: 'error', attempt: current.attempt },
          )}
      />
    </div>
  );
}

/**
 * The first quarter-megabyte, printed.
 *
 * Requested as a byte range so a 200MB log costs 256KB to peek at, and the
 * response says whether there was more.
 */
function TextPreview({ document: doc }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(contentHref(doc), {
          credentials: 'include',
          headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` },
          signal: controller.signal,
        });

        if (!response.ok && response.status !== 206) throw new Error(`status ${response.status}`);

        // "bytes 0-262143/1048576" — the tail is the full size, which is the
        // only reliable way to know the peek was partial.
        const range = response.headers.get('Content-Range');
        const totalBytes = Number(range?.split('/')[1]);
        const body = await response.text();

        setState({
          status: 'ready',
          body,
          truncated: Number.isFinite(totalBytes) && totalBytes > TEXT_PREVIEW_BYTES,
        });
      } catch (error) {
        if (error.name !== 'AbortError') setState({ status: 'error' });
      }
    })();

    return () => controller.abort();
  }, [doc.documentId]);

  if (state.status === 'loading') return <Waiting label="جارٍ التحميل…" />;
  if (state.status === 'error') {
    return <Resting icon={Info} title="تعذّر قراءة الملف" hint="نزِّل الملف لفتحه." />;
  }

  return (
    <div className="p-3">
      <pre
        dir="auto"
        className="whitespace-pre-wrap break-words rounded border border-border bg-surface
          p-3 text-xs leading-relaxed text-text"
      >
        {state.body}
      </pre>
      {state.truncated ? (
        <p className="mt-2 text-[11px] text-text-muted">
          عُرض أول {formatBytes(TEXT_PREVIEW_BYTES)} من الملف فقط.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Office files and scanner formats, through the rendition the worker produces.
 *
 * Renditions are made on a queue, so the honest first answer is often "not yet".
 * That is polled with a widening delay and then given up on out loud, because a
 * spinner that never resolves is the same as a lie.
 */
function RenditionPreview({ document: doc }) {
  const [state, setState] = useState({ status: 'preparing' });
  // Bumped by the retry buttons below; a dependency of the effect, so retrying
  // is re-running the whole attempt rather than poking at its remains.
  const [attempt, setAttempt] = useState(0);
  const objectUrl = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer = null;

    async function attempt(round) {
      let result;
      try {
        result = await api.previewRendition(doc.documentId, {
          signal: controller.signal,
          // Set for one constituent of a multi-file document, null otherwise.
          fileId: doc.fileId ?? null,
        });
      } catch {
        if (!cancelled) setState({ status: 'failed' });
        return;
      }

      if (cancelled) {
        if (result.blobUrl) URL.revokeObjectURL(result.blobUrl);
        return;
      }

      if (result.status === 'queued') {
        // ~1.5s, 3s, 6s, 12s, 20s, 20s — an Office conversion is seconds, a
        // busy queue is longer, and past a minute the pane should stop pretending.
        if (round >= 5) {
          setState({ status: 'slow' });
          return;
        }
        setState({ status: 'preparing' });
        timer = setTimeout(() => attempt(round + 1), Math.min(1500 * 2 ** round, 20_000));
        return;
      }

      if (result.status === 'ready') {
        objectUrl.current = result.blobUrl;
        setState({ status: 'ready', url: result.blobUrl, mimeType: result.mimeType });
        return;
      }

      setState({ status: result.status, reason: result.reason });
    }

    attempt(0);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (objectUrl.current) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = null;
      }
    };
    // Keyed on the file too: switching between two constituents of one document
    // keeps the same documentId, and without this the first file's rendition
    // would stay on screen for the second.
  }, [doc.documentId, doc.fileId, attempt]);

  if (state.status === 'preparing') return <Waiting label="جارٍ تحضير المعاينة…" />;

  if (state.status === 'slow') {
    return (
      <Resting
        icon={Loader2}
        title="المعاينة قيد التحضير"
        hint="التحويل يجري في الخلفية وقد يستغرق وقتاً. نزِّل الملف أو أعِد المحاولة."
        action={{ label: 'التحقق من جديد', onClick: () => setAttempt((n) => n + 1) }}
      />
    );
  }

  if (state.status === 'unsupported') {
    return (
      <Resting
        icon={FileText}
        title="لا تتوفر معاينة لهذا النوع"
        hint="نزِّل الملف لفتحه في التطبيق المناسب."
      />
    );
  }

  if (state.status === 'failed') {
    return (
      <Resting
        icon={Info}
        title="تعذّر إنشاء المعاينة"
        hint={state.reason ? `السبب: ${state.reason}` : 'نزِّل الملف لفتحه في التطبيق المناسب.'}
        action={{ label: 'إعادة المحاولة', onClick: () => setAttempt((n) => n + 1) }}
      />
    );
  }

  // A rendition is a PDF (from Office) or a WebP (from a scan). The scan branch
  // had the same uncapped-height defect as the stored-image branch, and for the
  // same reason it matters more here: a rendition of a scan is the only way that
  // document is ever read on screen.
  if (state.mimeType?.startsWith('image/')) {
    return <ImageViewer src={state.url} alt={doc.title} />;
  }

  return (
    <iframe
      title={doc.title}
      src={state.url}
      className="h-full min-h-[24rem] w-full border-0 bg-surface-muted"
    />
  );
}

function Waiting({ label }) {
  return (
    <div className="flex h-full min-h-[24rem] items-center justify-center gap-2 text-text-muted">
      <Loader2 size={16} className="animate-spin" />
      <span className="text-xs">{label}</span>
    </div>
  );
}

function Resting({ icon: Icon, title, hint, action }) {
  return (
    <div className="flex h-full min-h-[24rem] flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon size={28} className="text-text-muted/60" />
      <p className="text-sm font-medium text-text">{title}</p>
      {hint ? <p className="max-w-xs text-xs text-text-muted">{hint}</p> : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-surface
            px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-primary/10
            hover:text-primary"
        >
          <RefreshCw size={13} />
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function PaneButton({ label, icon: Icon, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-primary/10
        hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      <Icon size={15} />
    </button>
  );
}

function FooterLink({ href, icon: Icon, label, download }) {
  return (
    <a
      href={href}
      target={download ? undefined : '_blank'}
      rel="noreferrer"
      download={download}
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-muted
        transition-colors hover:bg-primary/10 hover:text-primary"
    >
      <Icon size={13} />
      {label}
    </a>
  );
}
