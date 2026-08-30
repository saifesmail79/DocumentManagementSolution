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
  Shield,
  Move,
  Package,
  CheckSquare,
  Square,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { describeUploadFailure } from '../uploadErrors.js';
import { formatDate } from '../format.js';
import { Button, IconButton, Card, Spinner, EmptyState, Alert, ReadOnlyBadge } from '../components/ui.jsx';
import ScanPanel from '../components/ScanPanel.jsx';
import { useTree } from '../TreeContext.jsx';
import PermissionsPanel from '../components/PermissionsPanel.jsx';
import DropZone from '../components/DropZone.jsx';

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
  const [showPermissions, setShowPermissions] = useState(false);
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const fileInput = useRef(null);
  const folderInput = useRef(null);

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
        setData(await api.folder(folderId));
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
  }, [folderId]);

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
  }, [load]);

  const permissions = data?.folder?.permissions ?? {};

  /** Uploads a list of files one at a time, reporting what happened to each. */
  async function uploadFiles(files) {
    if (!files?.length || !folderId) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    const failed = [];
    const duplicates = [];

    for (const file of files) {
      try {
        const result = await api.upload(folderId, file);
        if (result.duplicateOf?.length) duplicates.push(file.name);
      } catch (caught) {
        failed.push(describeUploadFailure(caught, file.name));
      }
    }

    // Reported per file rather than as one pass/fail: dropping ten files and
    // being told only that "something failed" is not actionable.
    if (failed.length) setError(failed.join('\n'));
    if (duplicates.length) {
      setNotice(`رُفع الملف، مع وجود نسخة مطابقة في المجلد نفسه من: ${duplicates.join('، ')}`);
    } else if (files.length > failed.length) {
      // Indexing happens on a queue after the response, so a document is
      // searchable by title immediately and by content a little later. Saying so
      // once here prevents the far more alarming conclusion that search is
      // broken.
      setNotice('تم الرفع. تجري فهرسة المحتوى في الخلفية — قد لا يظهر في البحث النصي فوراً.');
    }

    await refresh();
    setBusy(false);
  }

  /**
   * Uploads a dropped folder, recreating its structure.
   *
   * Folders are created depth-first and cached by path, so a tree of two
   * hundred files in twenty folders makes twenty folder calls rather than two
   * hundred. A folder that already exists comes back as an error the cache
   * absorbs — creating and looking up are the same operation here.
   */
  async function uploadTree(entries) {
    if (!folderId || entries.length === 0) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    const created = new Map([['', folderId]]);
    const failed = [];

    /** Ensures every folder on a path exists, returning the deepest id. */
    async function ensurePath(segments) {
      let parentId = folderId;
      let key = '';

      for (const segment of segments) {
        key = key ? `${key}/${segment}` : segment;
        if (created.has(key)) {
          parentId = created.get(key);
          continue;
        }

        try {
          const result = await api.createFolder(parentId, segment);
          parentId = result.folderId;
        } catch {
          // Most likely it already exists from an earlier run. Find it rather
          // than failing the whole tree.
          const listing = await api.folder(parentId).catch(() => null);
          const match = listing?.folders?.find((f) => f.name === segment);
          if (!match) throw new Error(`could not create ${segment}`);
          parentId = match.folderId;
        }

        created.set(key, parentId);
      }

      return parentId;
    }

    for (const entry of entries) {
      try {
        const targetId = await ensurePath(entry.path);
        await api.upload(targetId, entry.file);
      } catch (caught) {
        failed.push(describeUploadFailure(caught, [...entry.path, entry.file.name].join('/')));
      }
    }

    if (failed.length) {
      const shown = failed.slice(0, 5).join('\n');
      const rest = failed.length > 5 ? `\n(و${failed.length - 5} ملفاً آخر)` : '';
      setError(shown + rest);
    }

    // Only when something actually landed. Announcing "0 of 1 uploaded" as a
    // notice alongside an error reads as success to anyone skimming.
    const succeeded = entries.length - failed.length;
    if (succeeded > 0) {
      setNotice(
        `تم رفع ${succeeded} من ${entries.length} ملفاً مع الحفاظ على هيكل المجلدات.`
          + ' تجري فهرسة المحتوى في الخلفية.',
      );
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

  async function createFolder() {
    const name = window.prompt('اسم المجلد الجديد');
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
    if (!window.confirm(`حذف ${title}؟`)) return;
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
  const documentCount = data?.documents?.length ?? 0;

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
          {!folderId || permissions.upload ? (
            <Button variant="secondary" icon={FolderPlus} onClick={createFolder} disabled={busy}>
              مجلد جديد
            </Button>
          ) : null}
          {folderId && permissions.managePerms ? (
            <Button
              variant="secondary"
              icon={Shield}
              onClick={() => setShowPermissions((v) => !v)}
              disabled={busy}
            >
              الصلاحيات
            </Button>
          ) : null}
          {folderId && permissions.upload ? (
            <>
              <Button icon={Upload} onClick={() => fileInput.current?.click()} disabled={busy}>
                {busy ? 'جارٍ الرفع…' : 'رفع وثيقة'}
              </Button>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={upload} />
              <Button
                variant="secondary"
                icon={FolderPlus}
                onClick={() => folderInput.current?.click()}
                disabled={busy}
              >
                رفع مجلد
              </Button>
              {/* webkitdirectory is the only way to pick a directory. React does
                  not know the attribute, so it is set through a ref callback. */}
              <input
                ref={(node) => {
                  folderInput.current = node;
                  if (node) {
                    node.setAttribute('webkitdirectory', '');
                    node.setAttribute('directory', '');
                  }
                }}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const picked = [...(event.target.files ?? [])].map((file) => ({
                    file,
                    // webkitRelativePath is "root/sub/file.pdf"; the file's own
                    // name is dropped, and so is the outermost folder, which the
                    // user chose and is already the destination.
                    path: String(file.webkitRelativePath || '').split('/').slice(1, -1),
                  }));
                  event.target.value = '';
                  if (picked.length) uploadTree(picked);
                }}
              />
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

      {showPermissions && folderId ? (
        <PermissionsPanel
          folderId={folderId}
          folderName={data?.folder?.name ?? ''}
          onClose={() => setShowPermissions(false)}
          onChanged={() => refresh()}
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
          {data.folders.map((folder) => (
            <button
              key={folder.folderId}
              onClick={() => navigate(`/folders/${folder.folderId}`)}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 text-right
                transition-colors hover:border-border-strong hover:bg-surface-muted/40"
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
          ))}
        </div>
      ) : null}

      {folderId ? (
        <DropZone
          onFiles={uploadFiles}
          onTree={uploadTree}
          disabled={busy || !permissions.upload}
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
                            selected.size === data.documents.length
                              ? new Set()
                              : new Set(data.documents.map((d) => d.documentId)),
                          )
                        }
                        aria-label="تحديد الكل"
                        className="text-text-muted hover:text-primary"
                      >
                        {selected.size === data.documents.length && data.documents.length > 0 ? (
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
                    <th className="border-b border-border px-4 py-3 text-center font-semibold">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.documents.map((doc, index) => (
                    <tr key={doc.documentId} className="transition-colors hover:bg-surface-muted/30">
                      <td className="px-3 py-3 text-center">
                        <button
                          onClick={() => {
                            const next = new Set(selected);
                            if (next.has(doc.documentId)) next.delete(doc.documentId);
                            else next.add(doc.documentId);
                            setSelected(next);
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
                          {!doc.canRead ? <ReadOnlyBadge /> : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-text-muted">{doc.typeName ?? '—'}</td>
                      <td className="num px-4 py-3 text-left text-text-muted">{doc.currentVersion}</td>
                      <td className="num px-4 py-3 text-left text-text-muted">{formatDate(doc.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          {doc.canRead ? (
                            <a
                              href={api.contentUrl(doc.documentId)}
                              target="_blank"
                              rel="noreferrer"
                              title="فتح"
                              className="rounded-lg border border-border bg-surface p-2 text-text-muted
                                transition-colors hover:bg-primary/10 hover:text-primary"
                            >
                              <Download size={16} />
                            </a>
                          ) : null}
                          {permissions.delete ? (
                            <IconButton
                              icon={Trash2}
                              label="حذف"
                              onClick={() => remove(doc.documentId, doc.title)}
                              className="hover:!bg-red-50 hover:!text-red-600"
                            />
                          ) : null}
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
            onClick={() => {
              if (window.confirm(`حذف ${selected.size} وثيقة؟`)) run(() => api.bulkDelete(ids), 'حذف');
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
