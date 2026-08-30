import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, FileText, Folder, X, SlidersHorizontal, Bookmark, Star } from 'lucide-react';

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
  const [facets, setFacets] = useState(null);
  const [snippets, setSnippets] = useState({});
  const [saved, setSaved] = useState([]);

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
      .then(async (data) => {
        // A slow earlier request must not overwrite a newer one's results.
        if (cancelled) return;
        setResults(data);

        // Facets and snippets are fetched alongside rather than inside the
        // search response: they are useful separately and a client that does not
        // want them should not pay for them.
        const ids = data.results.map((r) => r.documentId);
        const [facetResult, snippetResult] = await Promise.all([
          api.facets(`q=${encodeURIComponent(query)}`).catch(() => null),
          ids.length ? api.snippets(ids, query).catch(() => ({ snippets: {} })) : { snippets: {} },
        ]);
        if (cancelled) return;
        setFacets(facetResult);
        setSnippets(snippetResult.snippets ?? {});
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

  useEffect(() => {
    api
      .savedSearches()
      .then((result) => setSaved(result.searches))
      .catch(() => setSaved([]));
  }, []);

  async function persist() {
    const name = window.prompt('اسم البحث المحفوظ');
    if (!name?.trim()) return;
    try {
      await api.saveSearch({
        name: name.trim(),
        criteria: { q: draft.trim() || null, ...criteria },
      });
      setSaved((await api.savedSearches()).searches);
    } catch {
      setError('تعذر حفظ البحث.');
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

      {saved.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Bookmark size={13} className="text-text-muted" />
          {saved.map((entry) => (
            <span key={entry.searchId} className="flex items-center gap-1">
              <button
                onClick={() => {
                  setCriteria({ fields: [], ...entry.criteria });
                  setDraft(entry.criteria?.q ?? '');
                  setAdvanced(true);
                }}
                className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-text hover:bg-primary/10 hover:text-primary"
              >
                {entry.name}
                {entry.isShared && !entry.isMine ? ` · ${entry.owner}` : ''}
              </button>
              {entry.isMine ? (
                <button
                  onClick={async () => {
                    await api.deleteSavedSearch(entry.searchId);
                    setSaved((await api.savedSearches()).searches);
                  }}
                  aria-label="حذف البحث المحفوظ"
                  className="text-text-muted hover:text-red-600"
                >
                  <X size={11} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      {loading ? <Spinner label="جارٍ البحث…" /> : null}

      {!loading && results ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="num">{results.total} نتيجة</span>
            <button onClick={persist} className="flex items-center gap-1 text-primary hover:underline">
              <Star size={12} />
              حفظ البحث
            </button>
            {!results.contentSearched ? (
              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-600">
                بحث في العناوين فقط — لم يُفهرس محتوى الوثائق بعد
              </span>
            ) : null}
          </div>

          {facets ? (
            <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-surface p-3">
              <FacetGroup
                label="النوع"
                items={facets.types}
                onPick={(name) => {
                  setAdvanced(true);
                  setCriteria((current) => ({ ...current, typeName: name }));
                }}
              />
              <FacetGroup label="السرية" items={facets.sensitivities} />
              <FacetGroup label="الحالة" items={facets.states} />
            </div>
          ) : null}

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
                      {snippets[item.documentId] ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">
                          {snippets[item.documentId].text}
                        </p>
                      ) : null}
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

/**
 * One facet dimension.
 *
 * The counts come from the same predicate the results do, so a chip reading
 * "Contracts (12)" cannot select down to nine.
 */
function FacetGroup({ label, items, onPick }) {
  if (!items?.length) return null;

  return (
    <div className="min-w-[8rem]">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</p>
      <ul className="space-y-0.5">
        {items.slice(0, 5).map((item) => (
          <li key={item.name}>
            <button
              onClick={() => onPick?.(item.name)}
              disabled={!onPick}
              className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-xs
                text-text disabled:cursor-default hover:bg-primary/10"
            >
              <span className="truncate">{item.name}</span>
              <span className="num text-text-muted">{item.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
