import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Clock, Bell, FileText, Folder, CheckSquare } from 'lucide-react';

import { api } from '../api.js';
import { formatDate } from '../format.js';
import { Card, Spinner, EmptyState, Alert, ReadOnlyBadge, Button } from '../components/ui.jsx';

/**
 * The personal landing page: favourites, recently viewed, watches, and
 * approvals waiting on you.
 *
 * "I can never find my documents again" was the most consistently cited reason
 * people abandon a DMS. This page is the answer to it — everything here is
 * scoped to one person and needs no search.
 */
const TABS = [
  { key: 'favourites', label: 'المفضلة', icon: Star },
  { key: 'recent', label: 'المفتوحة مؤخراً', icon: Clock },
  { key: 'watches', label: 'المتابَعة', icon: Bell },
  { key: 'approvals', label: 'بانتظار موافقتي', icon: CheckSquare },
];

export default function MyDocuments() {
  const [tab, setTab] = useState('favourites');

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-text">مساحتي</h2>

      <div className="flex flex-row flex-wrap gap-1 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === item.key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            <item.icon size={15} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'favourites' ? <DocumentList loader={() => api.favourites()} empty="لا توجد وثائق مفضلة." /> : null}
      {tab === 'recent' ? <DocumentList loader={() => api.recent()} empty="لم تفتح أي وثيقة بعد." /> : null}
      {tab === 'watches' ? <Watches /> : null}
      {tab === 'approvals' ? <Approvals /> : null}
    </div>
  );
}

function DocumentList({ loader, empty }) {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState(null);

  useEffect(() => {
    loader()
      .then((result) => setDocuments(result.documents))
      .catch(() => setDocuments([]));
  }, [loader]);

  if (!documents) return <Spinner />;
  if (documents.length === 0) return <EmptyState icon={FileText} title={empty} />;

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border/50">
        {documents.map((document) => (
          <li
            key={document.documentId}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-muted/30"
          >
            <FileText size={16} className="shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
              <button
                onClick={() => navigate(`/documents/${document.documentId}`)}
                className="block max-w-full truncate text-right text-sm font-medium text-text hover:text-primary"
              >
                {document.title}
              </button>
              <button
                onClick={() => navigate(`/folders/${document.folderId}`)}
                className="mt-0.5 flex items-center gap-1 text-xs text-text-muted hover:text-primary"
              >
                <Folder size={12} />
                {document.folderName}
              </button>
            </div>
            {!document.canRead ? <ReadOnlyBadge /> : null}
            <span className="num shrink-0 text-xs text-text-muted">{formatDate(document.addedAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Watches() {
  const navigate = useNavigate();
  const [watches, setWatches] = useState(null);

  const load = useCallback(async () => {
    try {
      setWatches((await api.watches()).watches);
    } catch {
      setWatches([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!watches) return <Spinner />;
  if (watches.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        title="لا تتابع أي مجلد أو وثيقة"
        hint="تابع مجلداً لتصلك إشعارات بما يُضاف إليه."
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border/50">
        {watches.map((watch) => (
          <li key={watch.watchId} className="flex items-center gap-3 px-4 py-3">
            {watch.folderId ? (
              <Folder size={16} className="shrink-0 text-primary" />
            ) : (
              <FileText size={16} className="shrink-0 text-text-muted" />
            )}
            <button
              onClick={() =>
                navigate(watch.folderId ? `/folders/${watch.folderId}` : `/documents/${watch.documentId}`)
              }
              className="min-w-0 flex-1 truncate text-right text-sm text-text hover:text-primary"
            >
              {watch.name}
            </button>
            {watch.folderId && watch.recursive ? (
              <span className="shrink-0 text-[11px] text-text-muted">ويشمل ما بداخله</span>
            ) : null}
            <button
              onClick={async () => {
                await api.unwatch(
                  watch.folderId ? { folderId: watch.folderId } : { documentId: watch.documentId },
                );
                await load();
              }}
              className="shrink-0 text-xs text-text-muted hover:text-red-600"
            >
              إلغاء
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Approvals() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setRequests((await api.pendingApprovals()).requests);
    } catch {
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(requestId, decision) {
    const note = decision === 'rejected' ? window.prompt('سبب الرفض (اختياري)') : null;
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(requestId, decision, note);
      await load();
    } catch {
      setError('تعذر تسجيل القرار.');
    } finally {
      setBusy(false);
    }
  }

  if (!requests) return <Spinner />;
  if (requests.length === 0) {
    return <EmptyState icon={CheckSquare} title="لا توجد طلبات بانتظار موافقتك" />;
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      {requests.map((request) => (
        <Card key={request.requestId} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <button
                onClick={() => navigate(`/documents/${request.documentId}`)}
                className="block max-w-full truncate text-right text-sm font-medium text-text hover:text-primary"
              >
                {request.title}
              </button>
              <p className="num mt-0.5 text-xs text-text-muted">
                {request.folderName} · بطلب من {request.requestedBy} · {formatDate(request.requestedAt)}
              </p>
              {request.note ? <p className="mt-1 text-sm text-text">{request.note}</p> : null}
            </div>

            {/* An overdue step is marked rather than silently reassigned: a
                decision made by someone nobody expected is worse than a late one. */}
            {request.overdue ? (
              <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-600">
                متأخر · {request.hoursWaiting} ساعة
              </span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-row gap-2">
            <Button
              disabled={busy}
              onClick={() => decide(request.requestId, 'approved')}
              className="!px-3 !py-1 text-xs"
            >
              اعتماد
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => decide(request.requestId, 'rejected')}
              className="!px-3 !py-1 text-xs"
            >
              رفض
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
