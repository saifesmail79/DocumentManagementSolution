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
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate } from '../format.js';
import { Button, IconButton, Card, Spinner, EmptyState, Alert, ReadOnlyBadge } from '../components/ui.jsx';
import ScanPanel from '../components/ScanPanel.jsx';
import { useTree } from '../TreeContext.jsx';
import PermissionsPanel from '../components/PermissionsPanel.jsx';

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
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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

  useEffect(() => {
    load();
  }, [load]);

  const permissions = data?.folder?.permissions ?? {};

  async function upload(event) {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice still fires onChange.
    event.target.value = '';
    if (!file || !folderId) return;

    setBusy(true);
    setError(null);
    try {
      await api.upload(folderId, file);
      await Promise.all([load(), reloadTree()]);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'too_large'
          ? 'حجم الملف يتجاوز الحد المسموح.'
          : 'تعذر رفع الملف.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    const name = window.prompt('اسم المجلد الجديد');
    if (!name || !name.trim()) return;

    setBusy(true);
    try {
      await api.createFolder(folderId ?? null, name.trim());
      // The panel shows folders and their document counts, so both a new folder
      // and a new document put it out of date.
      await Promise.all([load(), reloadTree()]);
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
      await Promise.all([load(), reloadTree()]);
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
              <input ref={fileInput} type="file" className="hidden" onChange={upload} />
            </>
          ) : null}
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {showPermissions && folderId ? (
        <PermissionsPanel
          folderId={folderId}
          folderName={data?.folder?.name ?? ''}
          onClose={() => setShowPermissions(false)}
          onChanged={() => Promise.all([load(), reloadTree()])}
        />
      ) : null}

      {/* Scanning sits beside the ordinary upload, never replacing it: without
          the bridge installed this renders a short note and the file picker
          above keeps working unchanged. */}
      {folderId && permissions.upload ? (
        <ScanPanel
          folderId={folderId}
          onUploaded={() => Promise.all([load(), reloadTree()])}
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
        <Card className="overflow-hidden">
          {documentCount > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
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
                      <td className="num px-4 py-3 text-center text-xs text-text-muted">{index + 1}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center gap-2">
                          <FileText size={15} className="shrink-0 text-text-muted" />
                          <span className="font-medium text-text">{doc.title}</span>
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
