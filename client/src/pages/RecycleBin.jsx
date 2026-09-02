import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, RotateCcw, FileText, ShieldAlert } from 'lucide-react';

import { api } from '../api.js';
import { formatDate } from '../format.js';
import { Button, Card, Spinner, EmptyState, Alert } from '../components/ui.jsx';
import { useTree } from '../TreeContext.jsx';
import { useDialogs } from '../components/DialogProvider.jsx';

/**
 * The recycle bin.
 *
 * Only shows what this user may restore — the list is gated on Delete for the
 * containing folder, not Read, so it is not a record of what colleagues have
 * been throwing away.
 */
export default function RecycleBin() {
  const navigate = useNavigate();
  const { reload: reloadTree } = useTree();

  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();

  const load = useCallback(async () => {
    setError(null);
    try {
      setDocuments((await api.recycleBin()).documents);
    } catch {
      setError('تعذر تحميل سلة المحذوفات.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function restore(document) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.restoreDocument(document.documentId);
      setNotice(`تمت استعادة "${document.title}".`);
      await Promise.all([load(), reloadTree()]);
    } catch (caught) {
      setError(
        caught?.code === 'content_purged'
          ? 'انتهت مهلة الاسترجاع وحُذف المحتوى نهائياً.'
          : 'تعذرت الاستعادة.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function purge(document) {
    // No undo at all past this point, so the confirmation names the document
    // and states the consequence separately from the question.
    const confirmed = await confirm({
      title: 'حذف نهائي',
      message: `سيُحذف "${document.title}" نهائياً.`,
      detail: 'لا يمكن التراجع عن هذا الإجراء، ويُمحى الملف من القرص.',
      confirmLabel: 'حذف نهائياً',
      variant: 'danger',
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      await api.purgeDocument(document.documentId);
      // Says when and where, because "the next cleanup" on its own is not
      // something anyone can act on or wait for with any confidence.
      setNotice(
        `سيُمحى "${document.title}" نهائياً عند التنظيف القادم — يجري تلقائياً كل ساعة، `
        + 'أو شغّله فوراً من «الإدارة ← التشخيص ← التخزين».',
      );
      await load();
    } catch {
      setError('تعذر الحذف النهائي.');
    } finally {
      setBusy(false);
    }
  }

  if (!documents) return <Spinner label="جارٍ التحميل…" />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-text">
          <Trash2 size={18} className="text-text-muted" />
          سلة المحذوفات
        </h2>
        <p className="text-xs text-text-muted">
          تبقى الوثائق المحذوفة قابلة للاستعادة خلال مهلة السماح، ثم يُمحى محتواها نهائياً.
        </p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {documents.length === 0 ? (
        <EmptyState icon={Trash2} title="لا توجد وثائق محذوفة" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                  <th className="px-4 py-3 text-right font-semibold">العنوان</th>
                  <th className="px-4 py-3 text-right font-semibold">المجلد</th>
                  <th className="px-4 py-3 text-right font-semibold">حُذفت بواسطة</th>
                  <th className="px-4 py-3 text-left font-semibold">تاريخ الحذف</th>
                  <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {documents.map((document) => (
                  <tr key={document.documentId} className="transition-colors hover:bg-surface-muted/30">
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center gap-2">
                        <FileText size={15} className="shrink-0 text-text-muted" />
                        <span className="font-medium text-text">{document.title}</span>
                        {!document.restorable ? (
                          <span
                            title="مُحي المحتوى نهائياً"
                            className="flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-600"
                          >
                            <ShieldAlert size={11} />
                            المحتوى مُحي
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => navigate(`/folders/${document.folderId}`)}
                        className="text-text-muted hover:text-primary"
                      >
                        {document.folderName}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right text-text-muted">
                      {document.deletedBy ?? '—'}
                    </td>
                    <td className="num px-4 py-3 text-left text-text-muted">
                      {formatDate(document.deletedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="secondary"
                          icon={RotateCcw}
                          onClick={() => restore(document)}
                          disabled={busy || !document.restorable}
                          className="!px-2 !py-1 text-xs"
                        >
                          استعادة
                        </Button>
                        {document.restorable ? (
                          <button
                            onClick={() => purge(document)}
                            disabled={busy}
                            title="حذف نهائي"
                            aria-label="حذف نهائي"
                            className="rounded border border-border p-1.5 text-red-400
                              transition-colors hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
