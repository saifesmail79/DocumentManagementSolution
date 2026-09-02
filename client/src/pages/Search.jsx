import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, FileText, Folder, Layers, X, SlidersHorizontal, Bookmark, Star } from 'lucide-react';

import { api } from '../api.js';
import { formatDate, formatBytes } from '../format.js';
import { Button, Card, Spinner, EmptyState, Alert, ReadOnlyBadge } from '../components/ui.jsx';
import SearchCriteria from '../components/SearchCriteria.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { useDialogs } from '../components/DialogProvider.jsx';

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
  // The shared parameter filters, identical in shape to the folder listing's.
  const [filters, setFilters] = useState({});
  const [sortBy, setSortBy] = useState('updated');
  const [sortDir, setSortDir] = useState('desc');
  const [facets, setFacets] = useState(null);
  const [snippets, setSnippets] = useState({});
  const [saved, setSaved] = useState([]);
  const { prompt } = useDialogs();

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
          // Null is fine, and is the point of the parameter mode: a document can
          // be found by what it IS with no keyword involved at all.
          q: draft.trim() || null,
          // Every parameter filter, in the shape the shared normaliser expects,
          // so this page and the folder listing ask the same questions.
          ...filters,
          sortBy,
          sortDir,
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
    const name = await prompt({
      title: 'حفظ البحث',
      message: 'يُحفظ نص البحث ومعاييره تحت اسم تختاره، ويمكن الرجوع إليه لاحقاً.',
      label: 'اسم البحث',
      placeholder: 'مثال: عقود لم تُعتمد بعد',
      confirmLabel: 'حفظ',
      required: true,
    });
    if (!name?.trim()) return;
    try {
      await api.saveSearch({
        name: name.trim(),
        // Filters are saved alongside the field criteria, not folded into them:
        // a saved search that quietly dropped "filed by Sara, larger than 10MB"
        // would return a different result set every time it was reopened, which
        // is the one thing a saved search must not do.
        criteria: { q: draft.trim() || null, filters, sortBy, sortDir, ...criteria },
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
        {advanced ? 'إخفاء البحث بالخصائص' : 'بحث بالخصائص (بدون كلمات)'}
      </button>

      {advanced ? (
        <div className="space-y-3">
          {/*
            The same bar the folder listing uses, on the same filter shape. It
            searches the whole tree here rather than one folder, which is the
            only difference between the two — so no folderId is passed and the
            offered vocabulary covers everything the user may browse.
          */}
          <FilterBar value={filters} onChange={setFilters} />

          <SearchCriteria
            value={criteria}
            onChange={setCriteria}
            // The type is chosen in the bar above; this panel needs it only to
            // know which custom fields exist for it.
            typeId={filters.typeId}
            onSearch={runAdvanced}
            onClear={() => {
              setCriteria({ fields: [] });
              setFilters({});
              setResults(null);
            }}
          />

          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-text-muted">الترتيب حسب</span>
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value)}
                className="rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                  focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="updated">آخر تعديل</option>
                <option value="created">تاريخ الإضافة</option>
                <option value="title">العنوان</option>
                <option value="size">الحجم</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-text-muted">الاتجاه</span>
              <select
                value={sortDir}
                onChange={(event) => setSortDir(event.target.value)}
                className="rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                  focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="desc">تنازلي</option>
                <option value="asc">تصاعدي</option>
              </select>
            </label>

            <Button onClick={runAdvanced}>
              <SearchIcon size={15} />
              بحث
            </Button>
          </div>
        </div>
      ) : null}

      {saved.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Bookmark size={13} className="text-text-muted" />
          {saved.map((entry) => (
            <span key={entry.searchId} className="flex items-center gap-1">
              <button
                onClick={() => {
                  const { filters: savedFilters, sortBy: savedSortBy, sortDir: savedSortDir, ...rest } =
                    entry.criteria ?? {};
                  setCriteria({ fields: [], ...rest });
                  // Searches saved before filters existed carry none, and an
                  // undefined here would leave whatever was last on screen.
                  setFilters(savedFilters ?? {});
                  setSortBy(savedSortBy ?? 'updated');
                  setSortDir(savedSortDir ?? 'desc');
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
            {/*
              Only when a keyword was actually given. A parameter search reads
              no content by design, so showing "content not indexed yet" for one
              would report a fault where there is none — and send the user
              looking for a broken extraction queue.
            */}
            {draft.trim() && !results.contentSearched ? (
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
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <button
                          onClick={() => navigate(`/folders/${item.folderId}`)}
                          className="flex items-center gap-1 text-xs text-text-muted hover:text-primary"
                        >
                          <Folder size={12} />
                          {item.folderName}
                        </button>
                        {/*
                          The parameters that were filtered on, shown on the row
                          that matched them. A size filter whose results do not
                          say how big anything is asks the user to take it on
                          trust.
                        */}
                        {item.multiFile ? (
                          <span className="num flex items-center gap-1 text-xs text-text-muted">
                            <Layers size={12} />
                            {item.fileCount} ملفات
                          </span>
                        ) : null}
                        {item.bytes != null ? (
                          <span className="num text-xs text-text-muted">{formatBytes(item.bytes)}</span>
                        ) : null}
                        {item.createdBy ? (
                          <span className="text-xs text-text-muted">{item.createdBy}</span>
                        ) : null}
                      </div>
                    </div>
                    <span className="num shrink-0 text-xs text-text-muted">
                      {formatDate(item.updatedAt)}
                    </span>
                    {item.canRead ? (
                      <a
                        // A multi-file document has no single blob; the content
                        // route refuses it, so the whole set is offered instead.
                        href={
                          item.multiFile
                            ? api.filesZipUrl(item.documentId)
                            : api.contentUrl(item.documentId)
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-xs text-primary hover:underline"
                      >
                        {item.multiFile ? 'تنزيل' : 'فتح'}
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
