import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, FileText, Folder, X, SlidersHorizontal } from 'lucide-react';

import { api } from '../api.js';
import { formatDate } from '../format.js';
import { Card, Spinner, EmptyState, Alert, ReadOnlyBadge } from '../components/ui.jsx';
import SearchCriteria from '../components/SearchCriteria.jsx';

/**
 * Search results.
 *
 * The query lives in the URL so a result set is linkable and survives a refresh.
 *
 * `contentSearched` from the API is surfaced rather than hidden: if the
 * full-text index has not caught up, the user is told the search covered titles
 * only. Silently returning fewer results implies the document is not there.
 */
export default function Search() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get('q') ?? '';

  const [draft, setDraft] = useState(query);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [criteria, setCriteria] = useState({ fields: [] });

  useEffect(() => {
    setDraft(query);
    if (!query.trim()) {
      setResults(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .search(query)
      .then((data) => {
        // A slow earlier request must not overwrite a newer one's results.
        if (!cancelled) setResults(data);
      })
      .catch(() => {
        if (!cancelled) setError('تعذر تنفيذ البحث.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query]);

  function submit(event) {
    event.preventDefault();
    setParams(draft.trim() ? { q: draft.trim() } : {});
  }

  /**
   * Runs a multi-criteria search.
   *
   * Kept out of the URL, unlike the simple query: the criteria object is
   * structured and a client will want to save it, which is a different feature
   * from a linkable result set.
   */
  async function runAdvanced() {
    setLoading(true);
    setError(null);
    try {
      setResults(
        await api.advancedSearch({
          q: draft.trim() || null,
          typeId: criteria.typeId || null,
          labelId: criteria.labelId || null,
          createdFrom: criteria.createdFrom || null,
          createdTo: criteria.createdTo || null,
          // Rows with no field chosen are dropped rather than sent as empty
          // criteria that would narrow nothing and confuse the result count.
          fields: (criteria.fields ?? []).filter((c) => c.fieldId),
        }),
      );
    } catch {
      setError('تعذر تنفيذ البحث.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="relative max-w-xl">
        {/* Search icon sits on the right in RTL. */}
        <SearchIcon size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          dir="rtl"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="ابحث في العناوين ومحتوى الوثائق…"
          className="w-full rounded-lg border border-border bg-control py-2 pr-9 ps-9 text-sm text-text
            placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        {draft ? (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              setParams({});
            }}
            aria-label="مسح"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
          >
            <X size={16} />
          </button>
        ) : null}
      </form>

      <button
        onClick={() => setAdvanced((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-text-muted hover:text-primary"
      >
        <SlidersHorizontal size={13} />
        {advanced ? 'إخفاء البحث المتقدّم' : 'بحث متقدّم'}
      </button>

      {advanced ? (
        <SearchCriteria
          value={criteria}
          onChange={setCriteria}
          onSearch={runAdvanced}
          onClear={() => {
            setCriteria({ fields: [] });
            setResults(null);
          }}
        />
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      {loading ? <Spinner label="جارٍ البحث…" /> : null}

      {!loading && results ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="num">{results.total} نتيجة</span>
            {!results.contentSearched ? (
              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-600">
                بحث في العناوين فقط — لم يُفهرس محتوى الوثائق بعد
              </span>
            ) : null}
          </div>

          {results.results.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="لا توجد نتائج"
              hint="جرّب كلمات أقل أو تحقق من الإملاء."
            />
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border/50">
                {results.results.map((item) => (
                  <li
                    key={item.documentId}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-muted/30"
                  >
                    <FileText size={16} className="shrink-0 text-text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => navigate(`/documents/${item.documentId}`)}
                          className="truncate text-sm font-medium text-text hover:text-primary hover:underline"
                        >
                          {item.title}
                        </button>
                        {!item.canRead ? <ReadOnlyBadge /> : null}
                      </div>
                      <button
                        onClick={() => navigate(`/folders/${item.folderId}`)}
                        className="mt-0.5 flex items-center gap-1 text-xs text-text-muted hover:text-primary"
                      >
                        <Folder size={12} />
                        {item.folderName}
                      </button>
                    </div>
                    <span className="num shrink-0 text-xs text-text-muted">
                      {formatDate(item.updatedAt)}
                    </span>
                    {item.canRead ? (
                      <a
                        href={api.contentUrl(item.documentId)}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-xs text-primary hover:underline"
                      >
                        فتح
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      ) : null}

      {!loading && !results && !error ? (
        <EmptyState
          icon={SearchIcon}
          title="ابحث في الوثائق"
          hint="يشمل البحث عناوين الوثائق ومحتواها، ضمن المجلدات المصرّح لك بها فقط."
        />
      ) : null}
    </div>
  );
}
