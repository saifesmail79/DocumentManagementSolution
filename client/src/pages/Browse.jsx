import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Folder,
  FileText,
  Upload,
  FolderPlus,
  Trash2,
  Download,
  ChevronLeft,
  Home,
  Move,
  Package,
  CheckSquare,
  Square,
  Eye,
  PanelRightClose,
  PanelRightOpen,
  Layers,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { describeUploadFailure, describeUploadReason } from '../uploadErrors.js';
import { formatDate, formatDateTime } from '../format.js';
import { Button, Card, Spinner, EmptyState, Alert, ReadOnlyBadge } from '../components/ui.jsx';
import ExpandableActions from '../components/ExpandableActions.jsx';
import DocumentPreview from '../components/DocumentPreview.jsx';
import ScanPanel from '../components/ScanPanel.jsx';
import { useTree } from '../TreeContext.jsx';
import DropZone from '../components/DropZone.jsx';
import BatchFilePrompt from '../components/BatchFilePrompt.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { useDialogs } from '../components/DialogProvider.jsx';

/** Remembered per browser: a pane you have to re-open every visit is not an option, it is a chore. */
const PREVIEW_PANE_KEY = 'dms.browse.previewPane';

function readPreviewPreference() {
  try {
    return window.localStorage.getItem(PREVIEW_PANE_KEY) === 'on';
  } catch {
    // Private mode, or storage disabled by policy. The pane simply starts closed.
    return false;
  }
}

/**
 * Folder browser: subfolders and documents for one folder.
 *
 * Everything shown here was already permission-filtered by the API, so this file
 * contains no access checks — a folder the user cannot browse never arrives. The
 * one thing the UI acts on is `canRead`, which decides whether the open control
 * is offered. That is a rendering decision only; the server refuses the content
 * regardless of what this component draws.
 */
export default function Browse() {
  const { folderId } = useParams();
  const navigate = useNavigate();
  const { reload: reloadTree } = useTree();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [previewPane, setPreviewPane] = useState(readPreviewPreference);
  // Which row the pane is showing. Separate from `selected`, which drives bulk
  // actions — previewing one document is not the same as choosing it for a
  // twenty-document move, and merging the two makes both surprising.
  const [activeId, setActiveId] = useState(null);
  // The selection waiting on the separate-or-one-entry question. Held here
  // rather than inside the prompt so the files survive a failed answer and the
  // user can choose again without picking them a second time.
  const [pendingBatch, setPendingBatch] = useState(null);
  // Parameter filters narrowing this folder's listing. Null means unfiltered,
  // which is a different state from "every filter cleared" only in that it
  // keeps the bar collapsed.
  const [filters, setFilters] = useState({});
  const { confirm, prompt } = useDialogs();
  const fileInput = useRef(null);
  const hoverTimer = useRef(null);

  /*
   * `preserveMessages` exists because of a bug that made every upload failure
   * invisible.
   *
   * Each action set its message and then refreshed the listing — and the refresh
   * cleared the error on its way in, destroying the message before React ever
   * painted it. A blocked duplicate, a rejected file type, a full disk: the
   * server answered correctly every time and the user saw an unchanged screen.
   *
   * Clearing is right when the load is the point (arriving, or changing folder)
   * and wrong when the load is a consequence of something the user just did.
   */
  const load = useCallback(async ({ preserveMessages = false } = {}) => {
    setLoading(true);
    if (!preserveMessages) {
      setError(null);
      setNotice(null);
    }
    try {
      if (folderId) {
        setData(await api.folder(folderId, { filters }));
      } else {
        const roots = await api.roots();
        setData({ folder: null, folders: roots.folders, documents: [] });
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'المجلد غير موجود أو ليس لديك صلاحية لعرضه.'
          : 'تعذر تحميل المجلد.',
      );
    } finally {
      setLoading(false);
    }
    // `filters` is a dependency: changing a filter re-runs the listing query,
    // which is the whole point of the bar. It is kept out of `refresh` below so
    // an upload does not reset what the user has narrowed to.
  }, [folderId, filters]);

  /** Reloads after an action, keeping whatever the action just reported. */
  const refresh = useCallback(
    () => Promise.all([load({ preserveMessages: true }), reloadTree()]),
    [load, reloadTree],
  );

  useEffect(() => {
    load();
    // Cleared on navigation: ids from the previous folder would otherwise stay
    // selected and a bulk action would act on documents no longer on screen.
    setSelected(new Set());
    setActiveId(null);
  }, [load]);

  // Filters are per folder. Carrying "filed by Sara" into the next folder would
  // silently hide most of what is in it, and the emptiness would read as the
  // folder being empty rather than as a filter still being on.
  useEffect(() => {
    setFilters({});
  }, [folderId]);

  const permissions = data?.folder?.permissions ?? {};
  const documents = data?.documents ?? [];

  const activeIndex = documents.findIndex((document) => document.documentId === activeId);
  const activeDocument = activeIndex >= 0 ? documents[activeIndex] : null;

  useEffect(() => {
    try {
      window.localStorage.setItem(PREVIEW_PANE_KEY, previewPane ? 'on' : 'off');
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  }, [previewPane]);

  /** Opens the pane on a row, cancelling any hover that was about to fire. */
  const activate = useCallback((documentId) => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setActiveId(documentId);
  }, []);

  /**
   * Hovering previews, but only after a pause.
   *
   * Without the delay, dragging the pointer down the list to reach the action
   * menu fires a preview — and a network request — for every row it crosses.
   */
  const previewOnHover = useCallback(
    (documentId) => {
      if (!previewPane) return;
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => setActiveId(documentId), 250);
    },
    [previewPane],
  );

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const step = useCallback(
    (delta) => {
      if (documents.length === 0) return;
      const from = activeIndex >= 0 ? activeIndex : -1;
      const next = Math.min(Math.max(from + delta, 0), documents.length - 1);
      activate(documents[next].documentId);
    },
    [documents, activeIndex, activate],
  );

  /**
   * Arrow keys walk the list while the pane is open.
   *
   * Bound to the window rather than to the rows, because the rows are not
   * focusable and making a whole table row a tab stop would put a stop between
   * every pair of real controls. Ignored whenever a field has focus, so typing a
   * folder name never moves the preview.
   */
  useEffect(() => {
    if (!previewPane || documents.length === 0) return undefined;

    function onKeyDown(event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const focused = window.document.activeElement;
      const tag = focused?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || focused?.isContentEditable) return;

      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewPane, documents.length, step]);
  /**
   * The entry point for every set of files a user hands over.
   *
   * One file is unambiguous and goes straight up. More than one is not — five
   * files can be five documents or one document of five pages, and only the
   * person who chose them knows which. So the count, and nothing else, decides
   * whether to ask: `pendingBatch` holds the selection while the question is on
   * screen, and `fileBatch` below does the work once it is answered.
   */
  async function uploadFiles(files) {
    const list = [...(files ?? [])];
    if (list.length === 0 || !folderId) return;

    if (list.length === 1) {
      await fileBatch(list, { mode: 'separate' });
      return;
    }

    setError(null);
    setNotice(null);
    setPendingBatch(list);
  }

  /**
   * Sends a batch and reports what happened to each file.
   *
   * One request rather than a request per file: the server needs the whole set
   * at once to file it as a single document, and for separate documents it
   * still reports per-file outcomes — so nothing is lost by using one path for
   * both, and the two modes cannot drift apart.
   */
  async function fileBatch(files, { mode, title }) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await api.uploadBatch(folderId, files, { mode, title });
      const created = result.created ?? [];
      const failed = result.failed ?? [];

      // Reported per file rather than as one pass/fail: dropping ten files and
      // being told only that "something failed" is not actionable.
      if (failed.length) {
        setError(
          failed
            .map((entry) => describeUploadReason(entry, entry.filename))
            .join('\n'),
        );
      }

      const duplicates = created.filter((entry) => entry.duplicateOf?.length);

      if (duplicates.length) {
        setNotice(
          `رُفع الملف، مع وجود نسخة مطابقة في المجلد نفسه من: ${duplicates
            .map((entry) => entry.filename ?? entry.title)
            .join('، ')}`,
        );
      } else if (created.length) {
        // Indexing happens on a queue after the response, so a document is
        // searchable by title immediately and by content a little later. Saying
        // so once here prevents the far more alarming conclusion that search is
        // broken.
        setNotice(
          mode === 'single' && created[0]?.multiFile
            ? `تم رفع ${created[0].fileCount} ملفات كوثيقة واحدة. تجري فهرسة المحتوى في الخلفية.`
            : 'تم الرفع. تجري فهرسة المحتوى في الخلفية — قد لا يظهر في البحث النصي فوراً.',
        );
      }

      setPendingBatch(null);
    } catch (caught) {
      // A whole-batch failure — refused before anything was filed. The
      // selection stays on screen so the user can answer differently rather
      // than having to find the files again.
      setError(describeUploadFailure(caught, `${files.length} ملفات`));
    }

    await refresh();
    setBusy(false);
  }

  async function upload(event) {
    const files = [...(event.target.files ?? [])];
    // Cleared immediately so choosing the same file twice still fires onChange.
    event.target.value = '';
    await uploadFiles(files);
  }

  /**
   * Removes an empty folder.
   *
   * The server is the authority on emptiness — the card only knows the document
   * count and cannot see subfolders — so a refusal is expected here and is
   * reported with the counts it sends back rather than as a generic failure.
   */
  async function removeFolder(folder) {
    const confirmed = await confirm({
      title: 'حذف المجلد',
      message: `سيُحذف المجلد "${folder.name}".`,
      detail: 'لا يُحذف إلا مجلد فارغ تماماً — بلا وثائق ولا مجلدات فرعية، وبما في ذلك ما في سلة المحذوفات.',
      confirmLabel: 'حذف',
      variant: 'danger',
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteFolder(folder.folderId);
      setNotice(`حُذف المجلد "${folder.name}".`);
      await refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'not_empty') {
        /*
         * Binned documents are named separately, and deliberately.
         *
         * The card counts live documents only, so a folder showing "0 وثيقة"
         * refused for holding one is a contradiction the reader cannot resolve —
         * and the fix is in a different screen: the recycle bin, not this one.
         */
        const parts = [
          caught.body?.documents > 0 ? `${caught.body.documents} وثيقة` : null,
          caught.body?.binned > 0 ? `${caught.body.binned} وثيقة في سلة المحذوفات` : null,
          caught.body?.subfolders > 0 ? `${caught.body.subfolders} مجلداً فرعياً` : null,
        ].filter(Boolean);

        // The binned case needs the whole route out, not just the name of the
        // blocker: "delete permanently" queues the erase rather than performing
        // it, so someone who does only that comes straight back to this refusal.
        const route = caught.body?.binned > 0
          ? ' احذف ما في سلة المحذوفات نهائياً، ثم انتظر التنظيف التلقائي (كل ساعة)'
            + ' أو شغّله فوراً من «الإدارة ← التشخيص ← التخزين».'
          : ' أفرغه أولاً.';

        setError(`المجلد ليس فارغاً — يحتوي ${parts.join('، و')}.${route}`);
      } else if (caught instanceof ApiError && caught.code === 'forbidden') {
        setError('لا تملك صلاحية حذف هذا المجلد.');
      } else {
        setError('تعذر حذف المجلد.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    const name = await prompt({
      title: 'مجلد جديد',
      label: 'اسم المجلد',
      placeholder: 'مثال: عقود ٢٠٢٦',
      confirmLabel: 'إنشاء',
      required: true,
    });
    if (!name || !name.trim()) return;

    setBusy(true);
    try {
      await api.createFolder(folderId ?? null, name.trim());
      // The panel shows folders and their document counts, so both a new folder
      // and a new document put it out of date.
      await refresh();
    } catch {
      setError('تعذر إنشاء المجلد.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(documentId, title) {
    const confirmed = await confirm({
      title: 'حذف الوثيقة',
      message: `سيُنقل "${title}" إلى سلة المحذوفات.`,
      detail: 'يبقى قابلاً للاستعادة طوال مهلة السماح، ثم يُمحى محتواه نهائياً.',
      confirmLabel: 'حذف',
      variant: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.deleteDocument(documentId);
      await refresh();
    } catch {
      setError('تعذر حذف الوثيقة.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="جارٍ التحميل…" />;

  const folderCount = data?.folders?.length ?? 0;
  const documentCount = documents.length;

  return (
    <div className="space-y-4">
      {data?.ancestors?.length ? (
        <nav aria-label="مسار المجلد" className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          <button onClick={() => navigate('/folders')} className="flex items-center gap-1 hover:text-primary">
            <Home size={13} />
            الجذر
          </button>
          {data.ancestors.map((ancestor) => (
            <span key={ancestor.folderId} className="flex items-center gap-1">
              <ChevronLeft size={12} className="text-text-muted/60" />
              {ancestor.visible ? (
                <button
                  onClick={() => navigate(`/folders/${ancestor.folderId}`)}
                  className="hover:text-primary"
                >
                  {ancestor.name}
                </button>
              ) : (
                // A folder in the path that this user cannot see. Shown as a gap
                // rather than skipped, so the breadcrumb does not imply the
                // document sits nearer the root than it really does.
                <span title="مجلد غير مصرّح لك بعرضه" className="cursor-default text-text-muted/60">
                  …
                </span>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-text">
            {data?.folder?.name ?? 'المجلدات الرئيسية'}
          </h2>
          <p className="num text-xs text-text-muted">
            {folderCount} مجلد · {documentCount} وثيقة
          </p>
        </div>

        {/* RTL flex-row: buttons render right-to-left on screen in source order. */}
        <div className="flex flex-row items-center gap-2">
          {documentCount > 0 ? (
            <Button
              variant="secondary"
              icon={previewPane ? PanelRightClose : PanelRightOpen}
              onClick={() => {
                const next = !previewPane;
                setPreviewPane(next);
                // Opening onto an empty pane looks broken, so it lands on
                // something — whatever is already active, else the first row.
                if (next && !activeDocument && documents.length) activate(documents[0].documentId);
              }}
              aria-pressed={previewPane}
              title="عرض الوثيقة المحددة بجانب القائمة دون فتحها"
              className={previewPane ? '!border-primary !text-primary' : undefined}
            >
              لوحة المعاينة
            </Button>
          ) : null}
          {!folderId || permissions.upload ? (
            <Button variant="secondary" icon={FolderPlus} onClick={createFolder} disabled={busy}>
              مجلد جديد
            </Button>
          ) : null}
          {folderId && permissions.upload ? (
            <>
              <Button icon={Upload} onClick={() => fileInput.current?.click()} disabled={busy}>
                {busy ? 'جارٍ الرفع…' : 'رفع وثيقة'}
              </Button>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={upload} />
            </>
          ) : null}
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="warning">{notice}</Alert> : null}

      {selected.size > 0 ? (
        <BulkBar
          selected={selected}
          permissions={permissions}
          onClear={() => setSelected(new Set())}
          onDone={async (message) => {
            setSelected(new Set());
            if (message) setNotice(message);
            await refresh();
          }}
          onError={setError}
        />
      ) : null}

      {/* Scanning sits beside the ordinary upload, never replacing it: without
          the bridge installed this renders a short note and the file picker
          above keeps working unchanged. */}
      {folderId && permissions.upload ? (
        <ScanPanel
          folderId={folderId}
          onUploaded={() => refresh()}
        />
      ) : null}

      {folderCount > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.folders.map((folder) => {
            /*
             * The folder's OWN permissions, not the parent's.
             *
             * `permissions` here is the folder being viewed, and at the root
             * there is no such folder — so reading delete from it meant the
             * button never appeared on a root folder at all. Every row of the
             * listing already carries its own effective bits; that is the only
             * correct source, and it works at every level.
             */
            const removable = folder.permissions?.delete && folder.documentCount === 0;

            return (
              <div
                key={folder.folderId}
                className="flex items-center gap-2 rounded-xl border border-border bg-surface p-3
                  transition-colors hover:border-border-strong hover:bg-surface-muted/40"
              >
                <button
                  onClick={() => navigate(`/folders/${folder.folderId}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-right"
                >
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Folder size={18} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{folder.name}</p>
                    <p className="num text-xs text-text-muted">{folder.documentCount} وثيقة</p>
                  </div>
                  {/* RTL: ChevronLeft points forward on screen. */}
                  <ChevronLeft size={16} className="shrink-0 text-text-muted" />
                </button>

                {removable ? (
                  <button
                    onClick={() => removeFolder(folder)}
                    disabled={busy}
                    title="حذف المجلد الفارغ"
                    aria-label={`حذف المجلد ${folder.name}`}
                    className="shrink-0 rounded-lg border border-border p-1.5 text-red-400
                      transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Asked purely on count: one file is unambiguous and never raises this. */}
      {pendingBatch ? (
        <BatchFilePrompt
          files={pendingBatch}
          busy={busy}
          onCancel={() => setPendingBatch(null)}
          onConfirm={({ mode, title }) => fileBatch(pendingBatch, { mode, title })}
        />
      ) : null}

      {folderId ? (
        <FilterBar value={filters} onChange={setFilters} folderId={folderId} />
      ) : null}

      {folderId ? (
        <DropZone
          onFiles={uploadFiles}
          disabled={busy || !permissions.upload}
        >
        {/*
          RTL grid: the first column in source order is the rightmost on screen,
          so the table keeps the reading position and the pane sits beside it.
          One column below xl — a preview squeezed next to a table on a laptop
          leaves neither readable.
        */}
        <div
          className={
            previewPane && documentCount > 0
              ? 'grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_26rem]'
              : undefined
          }
        >
        <Card className="overflow-hidden">
          {documentCount > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                    <th className="border-b border-border px-3 py-3 text-center font-semibold">
                      <button
                        onClick={() =>
                          setSelected(
                            selected.size === documents.length
                              ? new Set()
                              : new Set(documents.map((d) => d.documentId)),
                          )
                        }
                        aria-label="تحديد الكل"
                        className="text-text-muted hover:text-primary"
                      >
                        {selected.size === documents.length && documents.length > 0 ? (
                          <CheckSquare size={15} />
                        ) : (
                          <Square size={15} />
                        )}
                      </button>
                    </th>
                    <th className="border-b border-border px-4 py-3 text-center font-semibold">#</th>
                    <th className="border-b border-border px-4 py-3 text-right font-semibold">العنوان</th>
                    <th className="border-b border-border px-4 py-3 text-right font-semibold">النوع</th>
                    <th className="border-b border-border px-4 py-3 text-left font-semibold">الإصدار</th>
                    <th className="border-b border-border px-4 py-3 text-left font-semibold">التاريخ</th>
                    {/* Fixed width: the action menu opens over the row, not into
                        the layout, and a column that resizes on hover is worse
                        than the icon row it replaced. Wide enough, too, that the
                        ring stays inside the card — this is the last column in
                        source order, so in RTL it sits against the left edge and
                        a narrower one would leave the ring hanging off it. */}
                    <th className="w-32 border-b border-border px-4 py-3 text-center font-semibold">
                      إجراءات
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {documents.map((doc, index) => (
                    <tr
                      key={doc.documentId}
                      onMouseEnter={() => previewOnHover(doc.documentId)}
                      // Clicking the row previews it; clicking the title still
                      // opens it. The two intents stay separate controls.
                      onClick={() => {
                        if (previewPane) activate(doc.documentId);
                      }}
                      // aria-current, not aria-selected: the checkbox is what
                      // "selected" means on this row, and it drives bulk actions.
                      // This only marks which row the pane is showing.
                      aria-current={previewPane && doc.documentId === activeId ? 'true' : undefined}
                      // A background rather than a ring: Tailwind's preflight
                      // sets border-collapse on tables, and Chrome does not paint
                      // a box-shadow on a row of a collapsed table.
                      className={`transition-colors ${
                        previewPane && doc.documentId === activeId
                          ? 'bg-primary/10'
                          : 'hover:bg-surface-muted/30'
                      }`}
                    >
                      <td className="px-3 py-3 text-center">
                        <button
                          onClick={() => {
                            const next = new Set(selected);
                            if (next.has(doc.documentId)) next.delete(doc.documentId);
                            else next.add(doc.documentId);
                            setSelected(next);
                            // Ticking a box is a statement about which document
                            // you mean, so the pane follows it.
                            if (next.has(doc.documentId)) activate(doc.documentId);
                          }}
                          aria-label={`تحديد ${doc.title}`}
                          className="text-text-muted hover:text-primary"
                        >
                          {selected.has(doc.documentId) ? (
                            <CheckSquare size={15} className="text-primary" />
                          ) : (
                            <Square size={15} />
                          )}
                        </button>
                      </td>
                      <td className="num px-4 py-3 text-center text-xs text-text-muted">{index + 1}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center gap-2">
                          {/* The rendition endpoint answers 202 while the worker
                              catches up, so a broken image is the normal early
                              state — hidden rather than shown as a broken icon. */}
                          {doc.canRead ? (
                            <img
                              src={api.thumbnailUrl(doc.documentId)}
                              alt=""
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                              className="h-8 w-8 shrink-0 rounded border border-border object-cover"
                            />
                          ) : null}
                          <FileText size={15} className="shrink-0 text-text-muted" />
                          <button
                            onClick={() => navigate(`/documents/${doc.documentId}`)}
                            className="font-medium text-text hover:text-primary hover:underline"
                          >
                            {doc.title}
                          </button>
                          {/* Said on the row, because a multi-file document
                              behaves differently on the pages this one links
                              to: it has no version history and downloads as an
                              archive. Finding that out only after opening it is
                              a surprise the listing can cheaply prevent. */}
                          {doc.multiFile ? (
                            <span
                              title={`وثيقة مكوّنة من ${doc.fileCount} ملفات`}
                              className="num flex shrink-0 items-center gap-1 rounded border border-border
                                bg-surface-muted px-1.5 py-0.5 text-xs text-text-muted"
                            >
                              <Layers size={11} />
                              {doc.fileCount}
                            </span>
                          ) : null}
                          {!doc.canRead ? <ReadOnlyBadge /> : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-text-muted">{doc.typeName ?? '—'}</td>
                      {/* A multi-file document has no version number — an em
                          dash is honest where "0" would read as a fault. */}
                      <td className="num px-4 py-3 text-left text-text-muted">
                        {doc.multiFile ? '—' : doc.currentVersion}
                      </td>
                      {/* The column has room for the date only; the tooltip
                          carries the time, which is what tells two same-day
                          uploads apart. */}
                      <td
                        className="num px-4 py-3 text-left text-text-muted"
                        title={formatDateTime(doc.createdAt)}
                      >
                        {formatDate(doc.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center">
                          <ExpandableActions
                            onView={doc.canRead ? () => navigate(`/documents/${doc.documentId}`) : undefined}
                            onDelete={permissions.delete ? () => remove(doc.documentId, doc.title) : undefined}
                            customActions={[
                              {
                                key: 'preview',
                                icon: Eye,
                                show: doc.canRead,
                                title: 'معاينة',
                                onClick: () => {
                                  setPreviewPane(true);
                                  activate(doc.documentId);
                                },
                                bgClass: 'bg-indigo-500/10',
                                textClass: 'text-indigo-600',
                                hoverClass: 'hover:bg-indigo-500/20',
                              },
                              {
                                key: 'download',
                                icon: Download,
                                show: doc.canRead,
                                title: 'تنزيل',
                                href: api.contentUrl(doc.documentId),
                                bgClass: 'bg-primary/10',
                                textClass: 'text-primary',
                                hoverClass: 'hover:bg-primary/20',
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={FileText}
              title="لا توجد وثائق في هذا المجلد"
              hint={permissions.upload ? 'استخدم زر الرفع لإضافة أول وثيقة.' : undefined}
            />
          )}
        </Card>

        {previewPane && documentCount > 0 ? (
          <DocumentPreview
            document={activeDocument}
            position={activeIndex >= 0 ? activeIndex + 1 : null}
            total={documentCount}
            onStep={step}
            onOpen={(picked) => navigate(`/documents/${picked.documentId}`)}
            onClose={() => setPreviewPane(false)}
          />
        ) : null}
        </div>
        </DropZone>
      ) : null}

      {!folderId && folderCount === 0 ? (
        <EmptyState
          icon={Folder}
          title="لا توجد مجلدات متاحة"
          hint="لم تُمنح صلاحية على أي مجلد بعد. راجع مدير النظام."
        />
      ) : null}
    </div>
  );
}

/**
 * The action bar that appears once documents are selected.
 *
 * Every action reports per document rather than as one pass or fail — a
 * selection can span folders with different grants, and "done" while nine were
 * skipped misleads the user about where their documents are.
 */
function BulkBar({ selected, permissions, onClear, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const { folders } = useTree();
  const { confirm } = useDialogs();
  const ids = [...selected];

  async function run(fn, describe) {
    setBusy(true);
    onError(null);
    try {
      const result = await fn();
      const failed = result.failed ?? 0;
      onDone(
        failed > 0
          ? `${describe}: نجح ${result.succeeded} وتعذّر ${failed}.`
          : `${describe}: ${result.succeeded} وثيقة.`,
      );
    } catch {
      onError('تعذر تنفيذ الإجراء الجماعي.');
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    try {
      // Posted through fetch rather than a link because the id list is a body,
      // then handed to the browser as a blob so the ZIP still saves normally.
      const response = await fetch(api.bulkDownloadUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: ids }),
      });
      if (!response.ok) throw new Error('download failed');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'documents.zip';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      onError('تعذر تنزيل الملف المضغوط.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <span className="num text-sm font-medium text-primary">{selected.size} محددة</span>

      <Button variant="secondary" icon={Package} onClick={download} disabled={busy} className="!px-3 !py-1 text-xs">
        تنزيل مضغوط
      </Button>

      {permissions.delete ? (
        <>
          <select
            disabled={busy}
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) {
                run(() => api.bulkMove(ids, event.target.value), 'نقل');
              }
            }}
            className="rounded-lg border border-border bg-control px-2 py-1 text-xs"
          >
            <option value="">نقل إلى…</option>
            {folders.map((folder) => (
              <option key={folder.folderId} value={folder.folderId}>
                {folder.name}
              </option>
            ))}
          </select>

          <Button
            variant="danger"
            icon={Trash2}
            disabled={busy}
            onClick={async () => {
              const confirmed = await confirm({
                title: 'حذف الوثائق المحددة',
                message: `سيُنقل ${selected.size} وثيقة إلى سلة المحذوفات.`,
                detail: 'يُبلَّغ عن كل وثيقة على حدة — قد يمتد التحديد على مجلدات صلاحياتك فيها مختلفة.',
                confirmLabel: 'حذف',
                variant: 'danger',
              });
              if (confirmed) run(() => api.bulkDelete(ids), 'حذف');
            }}
            className="!px-3 !py-1 text-xs"
          >
            حذف
          </Button>
        </>
      ) : null}

      <button onClick={onClear} className="ms-auto text-xs text-text-muted hover:text-text">
        إلغاء التحديد
      </button>
    </div>
  );
}
