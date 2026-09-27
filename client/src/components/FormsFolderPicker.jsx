/**
 * Where a generated letter is filed — one searchable picker, used by both
 * forms screens.
 *
 * ─── Why it reads the shared tree rather than asking the server ─────────────
 *
 * `useTree()` already holds the whole visible tree, fetched once above the
 * routes, and every folder row carries `permissions` from
 * `fn_effective_permission`. So the set of folders a letter may be filed into
 * is already in memory: those with `permissions.upload`. Asking the server for
 * a second, forms-specific list would be a second place for that rule to drift
 * away from the one the upload itself enforces.
 *
 * Hiding the folders without upload permission is courtesy, not security —
 * `createDocument` checks the bits again and refuses. The point of hiding them
 * is that the person does not fill a whole letter in and then learn, after the
 * conversion, that the destination was never theirs to file into.
 *
 * ─── Why one searchable box and not a select plus a filter ──────────────────
 *
 * The first version was a native select with a separate text box that
 * narrowed its options. Two controls for one question read as two questions,
 * and the second sat under the first, so it was found after the list had
 * already been scrolled. Now the box IS the list: typing narrows it, the
 * arrow keys and Enter choose, and the chosen folder's full path stays in the
 * box afterwards — the full path, because two folders may both be called
 * «الصادر» and a bare name would not say which. A collapsible tree was
 * rejected for the same reason the correspondence intake picker rejected it:
 * "which folder" is asked once, and a path answers it in one line.
 *
 * Matching folds Arabic the way the search index does — no tashkeel or
 * tatweel, one alef, one yaa, one haa — because a person types a folder's
 * name as they spell it, and past the row cap typing is the only way to reach
 * a folder at all.
 *
 * ─── Why the list is positioned against the viewport ────────────────────────
 *
 * The administration dialog renders this picker inside a scrolling body. A
 * list positioned inside that body is clipped at its edge, so an administrator
 * saw two rows and a scrollbar. The list is therefore fixed against the
 * measured box, the same escape hatch HelpTip and ExpandableActions use, and
 * re-measured on scroll and resize while it is open.
 *
 * `truncated` is reported rather than hidden: the tree endpoint caps its
 * result, and a list that looks complete while missing the folder someone is
 * hunting for is worse than a list that says so.
 *
 * ─── Why clearing an unavailable choice is opt-in ───────────────────────────
 *
 * A folder can be handed in that this picker will not offer: a template's
 * default destination is chosen by an administrator without the upload rule
 * applied, and the last-used folder is remembered in the browser, which may
 * belong to a different signed-in person. The box would then show nothing
 * while a folder id nobody saw is still held in state, and the letter is
 * filed — or refused — for a destination the person never chose.
 *
 * So the fill screen asks for that value to be cleared, which makes the missing
 * choice visible and blocks the submit. The administration dialog does not: it
 * lists folders the tree endpoint may have capped, and dropping a stored default
 * merely because it lies past the cap would be a quiet edit to someone else's
 * configuration — but the × still offers to return it to «no default».
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

import { useTree } from '../TreeContext.jsx';
import { Alert } from './ui.jsx';

const TASHKEEL = /[ً-ْٰ]/g;

/** The same folding the search index applies, so typing finds what was filed. */
function fold(text) {
  return (text ?? '')
    .normalize('NFKC')
    .replace(TASHKEEL, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

/** Full paths, built from the flat rows the tree endpoint returns. */
function withPaths(folders) {
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]));

  return folders
    .map((folder) => {
      const parts = [];
      let cursor = folder;
      // Bounded by the map: a cycle would otherwise hang the render.
      for (let hops = 0; cursor && hops < 64; hops += 1) {
        parts.unshift(cursor.name);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
      }
      const path = parts.join(' / ');
      return { folderId: folder.folderId, permissions: folder.permissions, path, folded: fold(path) };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'ar'));
}

/**
 * How many matches the list shows at once. Past this the person is told to
 * type more rather than handed a list nobody scrolls to the end of.
 */
const MAX_SHOWN = 100;

/**
 * @param {object} props
 * @param {string} props.value          The chosen folder id, as a string ('' = none).
 * @param {Function} props.onChange     Called with the new folder id string.
 * @param {string} [props.label]
 * @param {string} [props.hint]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.requireUpload] Keep only folders the user may file into.
 * @param {string} [props.emptyLabel]   What an empty, closed box means, e.g. «بلا مجلد افتراضي».
 * @param {boolean} [props.clearWhenUnavailable] Clear a value this picker cannot offer.
 */
export default function FormsFolderPicker({
  value,
  onChange,
  label = 'مجلد الإيداع',
  hint,
  disabled = false,
  requireUpload = true,
  emptyLabel = null,
  clearWhenUnavailable = false,
}) {
  const { folders, truncated, loading, error } = useTree();
  const listId = useId();
  const inputId = useId();
  const inputRef = useRef(null);

  // The text being typed while the list is open. Closed, the box shows the
  // chosen folder's path instead, so the two never fight over one string.
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // -1 means "nothing highlighted": the chosen folder lies past the row cap.
  const [highlight, setHighlight] = useState(0);
  // Where the list is drawn, measured from the box while open.
  const [box, setBox] = useState(null);

  const held = String(value ?? '');
  const hasValue = held !== '';

  const usable = useMemo(
    () => withPaths(folders ?? []).filter((folder) => !requireUpload || folder.permissions?.upload),
    [folders, requireUpload],
  );

  const selected = useMemo(() => usable.find((folder) => folder.folderId === held) ?? null, [usable, held]);

  /*
   * A value the list does not contain is no choice at all, so it is dropped.
   *
   * Only once the tree has actually arrived: while it is loading, or if it
   * failed, `usable` is empty for reasons that say nothing about whether the
   * folder exists, and clearing then would throw away a good default.
   */
  useEffect(() => {
    if (!clearWhenUnavailable || loading || error || !hasValue) return;
    if (!usable.some((folder) => folder.folderId === held)) onChange('');
  }, [clearWhenUnavailable, loading, error, hasValue, held, usable, onChange]);

  const matches = useMemo(() => {
    const needle = fold(query.trim());
    if (!needle) return usable;
    return usable.filter((folder) => folder.folded.includes(needle));
  }, [usable, query]);

  const shown = matches.slice(0, MAX_SHOWN);

  // The highlight never points past the list it belongs to.
  useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(shown.length - 1, -1)));
  }, [shown.length]);

  // Measured while open: the dialog body and the page both scroll under it.
  useEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      setBox({
        left: rect.left,
        top: rect.bottom + 4,
        width: rect.width,
        // Room below the box, with a margin; never less than a few rows.
        maxHeight: Math.max(window.innerHeight - rect.bottom - 16, 120),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  function openList() {
    if (disabled || loading) return;
    setQuery('');
    // Open AT the current choice, so a reflexive Enter re-picks it rather
    // than the alphabetically first folder; past the cap, highlight nothing.
    const at = selected ? usable.findIndex((folder) => folder.folderId === selected.folderId) : -1;
    setHighlight(at >= 0 && at < MAX_SHOWN ? at : selected ? -1 : 0);
    setOpen(true);
  }

  function closeList() {
    setOpen(false);
    setQuery('');
  }

  function pick(folder) {
    onChange(folder.folderId);
    closeList();
    inputRef.current?.blur();
  }

  function clear() {
    onChange('');
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus();
    setOpen(true);
  }

  function onKeyDown(event) {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, shown.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (highlight >= 0 && shown[highlight]) pick(shown[highlight]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeList();
    }
  }

  // The administrator's "no default" label speaks only for a box that is
  // closed and genuinely holds nothing; open, the box is a search box.
  const placeholder = usable.length === 0
    ? ''
    : (!open && !hasValue && emptyLabel) || 'اكتب جزءاً من اسم المجلد أو مساره…';

  return (
    <div className="space-y-2">
      <div className="block">
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-text">
          {label}
        </label>
        <div className="relative">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && highlight >= 0 && shown[highlight] ? `${listId}-${shown[highlight].folderId}` : undefined
            }
            autoComplete="off"
            value={open ? query : (selected?.path ?? '')}
            placeholder={placeholder}
            disabled={disabled || loading}
            onFocus={openList}
            onClick={() => { if (!open) openList(); }}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
              if (!open) setOpen(true);
            }}
            onKeyDown={onKeyDown}
            // The list takes the pointer with mousedown prevented, so the box
            // has not blurred by the time a click lands on a row; anything else
            // that takes focus closes the list.
            onBlur={closeList}
            className={`w-full rounded-lg border border-border bg-control py-2 pe-9 text-sm text-text
              focus:outline-none focus:ring-2 focus:ring-primary/40 ${hasValue && !open ? 'ps-9' : 'ps-3'}`}
          />
          {hasValue && !open && !disabled ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clear}
              aria-label="إلغاء اختيار المجلد"
              title="إلغاء الاختيار"
              className="absolute start-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:bg-primary/10 hover:text-primary"
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}

          {open && box ? (
            <ul
              id={listId}
              role="listbox"
              // One guard for the rows, the footer, the padding and the
              // scrollbar: pressing anywhere in the list must not blur the box.
              onMouseDown={(event) => event.preventDefault()}
              style={{ left: box.left, top: box.top, width: box.width, maxHeight: Math.min(box.maxHeight, 320) }}
              className="fixed z-50 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
            >
              {shown.length === 0 ? (
                <li className="px-3 py-2 text-sm text-text-muted">لا يوجد مجلد يطابق ما كتبت.</li>
              ) : null}
              {shown.map((folder, index) => {
                const active = index === highlight;
                const chosen = folder.folderId === held;
                return (
                  <li
                    key={folder.folderId}
                    id={`${listId}-${folder.folderId}`}
                    // aria-activedescendant scrolls nothing by itself; the
                    // highlighted row is brought into view here, and only when
                    // it is outside the box.
                    ref={active ? (node) => node?.scrollIntoView({ block: 'nearest' }) : null}
                    role="option"
                    aria-selected={chosen}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => pick(folder)}
                    className={`cursor-pointer px-3 py-2 text-sm ${
                      active ? 'bg-primary/10 text-primary' : chosen ? 'font-medium text-text' : 'text-text'
                    }`}
                  >
                    {folder.path}
                  </li>
                );
              })}
              {matches.length > shown.length ? (
                <li className="border-t border-border px-3 py-2 text-xs text-text-muted">
                  <span>المعروض </span>
                  <span className="num">{shown.length}</span>
                  <span> من </span>
                  <span className="num">{matches.length}</span>
                  <span> — اكتب المزيد لتضييق القائمة.</span>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </div>

      {usable.length > 0 ? (
        <p className="text-xs text-text-muted">
          <span className="num">{usable.length}</span>
          <span> مجلداً متاحاً. اكتب للبحث، أو افتح القائمة واختر.</span>
        </p>
      ) : null}

      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}

      {truncated ? <Alert tone="warning">القائمة غير كاملة — اكتب اسم المجلد للبحث عنه.</Alert> : null}

      {error && usable.length === 0 ? (
        <Alert tone="error">تعذر تحميل شجرة المجلدات. حدّث الصفحة وحاول مجدداً.</Alert>
      ) : null}

      {!loading && !error && usable.length === 0 ? (
        <Alert tone="warning">
          لا يوجد مجلد تملك فيه صلاحية «رفع». اطلب من مدير النظام منحك الصلاحية على المجلد الذي
          تودع فيه كتبك.
        </Alert>
      ) : null}
    </div>
  );
}
