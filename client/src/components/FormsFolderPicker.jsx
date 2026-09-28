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
 * ─── Why `only` narrows the list instead of the caller filtering it ─────────
 *
 * A template may be assigned to particular folders, and then a letter from it
 * may be filed into none but those. The rule is the server's — `generate`
 * refuses `folder_not_allowed` — and this box is where it becomes visible, so
 * it takes the allowed ids and shows their intersection with the folders the
 * person may upload into. Narrowing here rather than around the picker keeps
 * one list behind the search, the row cap, the counted line and the "nothing
 * to offer" warning; a caller that filtered its own set beforehand would have
 * to reproduce all four.
 *
 * ─── Why choosing several folders is the same box, not a second control ─────
 *
 * The administration dialog needs a LIST of folders, and its first version
 * asked for them one at a time: choose a folder, watch it drop into a list
 * above, find the box again, choose the next. Four folders were four trips
 * through a search box that emptied itself after each one, and nothing on the
 * screen said the question was "which folders" rather than "which folder".
 *
 * So the same box answers both. In `multiple` mode it holds the chosen folders
 * as chips and the list rows carry a checkbox: a row toggles, the list stays
 * open, and what was typed keeps filtering while the next folder is picked.
 * Nothing else changes — one list behind one search, one row cap, one counted
 * line, one Arabic folding — because the moment the two modes stop sharing that
 * machinery they start disagreeing about which folders exist.
 *
 * The chips print the full path, and `labelFor` lets the caller name a folder
 * this box cannot: the tree endpoint caps its result and a deleted folder is
 * not in it at all, yet both may still be assigned to a template, and a chip
 * reading «#42» is not something an administrator can act on.
 *
 * ─── Why clearing an unavailable choice is opt-in ───────────────────────────
 *
 * A folder can be handed in that this picker will not offer: the folders
 * assigned to a template are chosen by an administrator without the upload
 * rule applied, and the last-used folder is remembered in the browser, which
 * may belong to a different signed-in person. The box would then show nothing
 * while a folder id nobody saw is still held in state, and the letter is
 * filed — or refused — for a destination the person never chose.
 *
 * So the fill screen asks for that value to be cleared, which makes the missing
 * choice visible and blocks the submit. The administration dialog does not: it
 * lists folders the tree endpoint may have capped, and dropping an assigned
 * folder merely because it lies past the cap would be a quiet edit to someone
 * else's configuration — but the × still offers to empty the box.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';

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

/**
 * Full paths, built from the flat rows the tree endpoint returns, as a map of
 * folder id → path.
 *
 * Exported because the administration screen lists a template's assigned
 * folders and must print them the way this box does — the full path, since two
 * folders may both be called «الصادر». One builder, one spelling of a path.
 */
export function folderPaths(folders) {
  const rows = folders ?? [];
  const byId = new Map(rows.map((folder) => [String(folder.folderId), folder]));
  const paths = new Map();

  for (const folder of rows) {
    const parts = [];
    let cursor = folder;
    // Bounded by the map: a cycle would otherwise hang the render.
    for (let hops = 0; cursor && hops < 64; hops += 1) {
      parts.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : null;
    }
    paths.set(String(folder.folderId), parts.join(' / '));
  }

  return paths;
}

/** The rows this box searches: id, upload bits, full path and its folded form. */
function withPaths(folders) {
  const paths = folderPaths(folders);

  return (folders ?? [])
    .map((folder) => {
      const path = paths.get(String(folder.folderId)) ?? folder.name;
      return {
        folderId: String(folder.folderId),
        permissions: folder.permissions,
        path,
        folded: fold(path),
      };
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
 * @param {string} [props.value]        Single mode: the chosen folder id as a string ('' = none).
 * @param {Function} [props.onChange]   Single mode: called with the new folder id string.
 * @param {boolean} [props.multiple]    Several folders at once, shown as removable chips.
 * @param {string[]} [props.values]     Multi mode: the chosen folder ids.
 * @param {Function} [props.onChangeMany] Multi mode: called with the whole new list.
 * @param {Function} [props.labelFor]   Multi mode: `(id) => label` for a folder the tree lacks.
 * @param {string} [props.label]
 * @param {string} [props.hint]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.requireUpload] Keep only folders the user may file into.
 * @param {string[]} [props.only]     When non-empty, the only folder ids offered.
 * @param {string} [props.emptyLabel]   What an empty, closed box means, e.g. «بلا مجلد افتراضي».
 * @param {boolean} [props.clearWhenUnavailable] Clear a value this picker cannot offer.
 */
export default function FormsFolderPicker({
  value,
  onChange,
  multiple = false,
  values = null,
  onChangeMany = null,
  labelFor = null,
  label = 'مجلد الإيداع',
  hint,
  disabled = false,
  requireUpload = true,
  only = null,
  emptyLabel = null,
  clearWhenUnavailable = false,
}) {
  const { folders, truncated, loading, error } = useTree();
  const listId = useId();
  const inputId = useId();
  const inputRef = useRef(null);
  // The whole control, which in multi mode is the chip box around the search:
  // the list is measured against THIS, or it would hang under the narrow input
  // squeezed between the chips.
  const fieldRef = useRef(null);

  // The text being typed while the list is open. Closed, the box shows the
  // chosen folder's path instead, so the two never fight over one string.
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // -1 means "nothing highlighted": the chosen folder lies past the row cap.
  const [highlight, setHighlight] = useState(0);
  // Where the list is drawn, measured from the box while open.
  const [box, setBox] = useState(null);

  // Single mode's one id; in multi mode nothing is "held" in the box — the
  // chips are, and `chosen` below is the whole answer.
  const held = multiple ? '' : String(value ?? '');
  const picked = multiple ? (values ?? []).map(String) : [];
  const pickedSet = new Set(picked);
  const hasValue = multiple ? picked.length > 0 : held !== '';

  /*
   * The allowed set, from `only`, as a value that changes with its contents.
   *
   * Callers build that array while rendering, so its identity changes on every
   * keystroke elsewhere on the page; keyed on the ids themselves, the list is
   * rebuilt only when the allowed folders actually differ.
   */
  const onlyKey = Array.isArray(only) ? only.map(String).join('\u0000') : '';
  const allowed = useMemo(() => (onlyKey ? new Set(onlyKey.split('\u0000')) : null), [onlyKey]);

  const usable = useMemo(
    () =>
      withPaths(folders ?? []).filter(
        (folder) =>
          (!requireUpload || folder.permissions?.upload) && (!allowed || allowed.has(folder.folderId)),
      ),
    [folders, requireUpload, allowed],
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
    if (multiple || !clearWhenUnavailable || loading || error || !hasValue) return;
    if (!usable.some((folder) => folder.folderId === held)) onChange('');
  }, [multiple, clearWhenUnavailable, loading, error, hasValue, held, usable, onChange]);

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
      const rect = (fieldRef.current ?? inputRef.current)?.getBoundingClientRect();
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
    // Also on the chip count: ticking a folder makes the box taller, and a list
    // still drawn against the old height would overlap the box it belongs to.
  }, [open, picked.length]);

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

  /*
   * Multi mode: a row is a switch, and the list is not a dialog.
   *
   * Neither the list nor the typed text is disturbed, because the person is
   * mid-question: they typed «صادر» to see the four folders that match it and
   * are ticking three of them. Closing the list after the first tick is what
   * made the old add-one-at-a-time control tiring.
   */
  function toggle(folderId) {
    const id = String(folderId);
    const next = pickedSet.has(id) ? picked.filter((entry) => entry !== id) : [...picked, id];
    onChangeMany?.(next);
  }

  function choose(folder) {
    if (multiple) toggle(folder.folderId);
    else pick(folder);
  }

  function clear() {
    if (multiple) onChangeMany?.([]);
    else onChange('');
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus();
    setOpen(true);
  }

  /** What a chip says: the tree's path, else the caller's name, else the id. */
  function chipLabel(id) {
    const fromTree = usable.find((folder) => folder.folderId === String(id))?.path;
    return labelFor?.(String(id)) || fromTree || `#${id}`;
  }

  function onKeyDown(event) {
    /*
     * Backspace on an empty search box removes the last chip.
     *
     * The habit every tag field teaches, and the only way to undo a mistaken
     * tick without reaching for the mouse. Guarded on an empty query so it
     * never eats a letter someone is still deleting.
     */
    if (multiple && event.key === 'Backspace' && query === '' && picked.length > 0) {
      event.preventDefault();
      onChangeMany?.(picked.slice(0, -1));
      return;
    }
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
      if (highlight >= 0 && shown[highlight]) choose(shown[highlight]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeList();
    }
  }

  // The administrator's "no default" label speaks only for a box that is
  // closed and genuinely holds nothing; open, the box is a search box.
  const placeholder = usable.length === 0
    ? ''
    : (!open && !hasValue && emptyLabel)
      || (multiple && hasValue ? 'إضافة مجلد آخر…' : 'اكتب جزءاً من اسم المجلد أو مساره…');

  /*
   * What the search box does, whichever shape holds it.
   *
   * One object rather than two copies: the combobox wiring — what the list is,
   * which row is announced, when it opens, when it closes — is the part that
   * must not differ between one folder and several.
   */
  const searchProps = {
    id: inputId,
    type: 'text',
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-activedescendant':
      open && highlight >= 0 && shown[highlight] ? `${listId}-${shown[highlight].folderId}` : undefined,
    autoComplete: 'off',
    placeholder,
    disabled: disabled || loading,
    onFocus: openList,
    onClick: () => {
      if (!open) openList();
    },
    onChange: (event) => {
      setQuery(event.target.value);
      setHighlight(0);
      if (!open) setOpen(true);
    },
    onKeyDown,
    // The list takes the pointer with mousedown prevented, so the box has not
    // blurred by the time a click lands on a row; anything else that takes
    // focus closes the list.
    onBlur: closeList,
  };

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
          {multiple ? (
            <div
              ref={fieldRef}
              // The chips and the search are one control, so pressing anywhere
              // inside it puts the caret in the search rather than nowhere.
              onClick={() => inputRef.current?.focus()}
              className={`flex min-h-[2.5rem] w-full flex-wrap items-center gap-1 rounded-lg border
                border-border bg-control px-2 py-1.5 pe-9 focus-within:ring-2 focus-within:ring-primary/40
                ${disabled || loading ? 'opacity-60' : ''}`}
            >
              {picked.map((id) => {
                const name = chipLabel(id);
                return (
                  <span
                    key={id}
                    className="flex max-w-full items-center gap-1 rounded border border-border
                      bg-surface px-1.5 py-0.5 text-xs text-text"
                  >
                    <span className="min-w-0 break-all">{name}</span>
                    <button
                      type="button"
                      // The box must not blur: the list stays open while the
                      // administrator prunes what they have already ticked.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        // Not the box's click: removing a chip is not a request
                        // to open the list.
                        event.stopPropagation();
                        toggle(id);
                      }}
                      disabled={disabled}
                      aria-label={`إزالة المجلد ${name}`}
                      title="إزالة من القائمة"
                      className="rounded p-0.5 text-text-muted hover:bg-red-500/10 hover:text-red-600
                        disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
              <input
                ref={inputRef}
                {...searchProps}
                // Always the query: what is chosen is the chips' business, so
                // the two never fight over one string.
                value={query}
                className="min-w-[8rem] flex-1 border-0 bg-transparent p-0.5 text-sm text-text
                  placeholder:text-text-muted focus:outline-none"
              />
            </div>
          ) : (
            <input
              ref={inputRef}
              {...searchProps}
              value={open ? query : (selected?.path ?? '')}
              className={`w-full rounded-lg border border-border bg-control py-2 pe-9 text-sm text-text
                focus:outline-none focus:ring-2 focus:ring-primary/40 ${hasValue && !open ? 'ps-9' : 'ps-3'}`}
            />
          )}
          {!multiple && hasValue && !open && !disabled ? (
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
              aria-multiselectable={multiple ? true : undefined}
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
                const chosen = multiple ? pickedSet.has(folder.folderId) : folder.folderId === held;
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
                    onClick={() => choose(folder)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                      active ? 'bg-primary/10 text-primary' : chosen ? 'font-medium text-text' : 'text-text'
                    }`}
                  >
                    {multiple ? (
                      // A drawn box, not an <input type="checkbox">: a real one
                      // inside a row would take the focus the combobox needs and
                      // give Space a second, conflicting meaning.
                      <span
                        aria-hidden="true"
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          chosen ? 'border-primary bg-primary text-white' : 'border-border bg-control'
                        }`}
                      >
                        {chosen ? <Check size={12} strokeWidth={3} /> : null}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 break-words">{folder.path}</span>
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

      {multiple && picked.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span>
            <span className="num">{picked.length}</span>
            <span> مجلداً مختاراً.</span>
          </span>
          <button
            type="button"
            // Same guard as the chips: emptying the list is not a reason to
            // lose the open list and what was typed into it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
            disabled={disabled}
            className="rounded px-1.5 py-0.5 text-primary hover:bg-primary/10
              disabled:cursor-not-allowed disabled:opacity-50"
          >
            مسح الكل
          </button>
        </div>
      ) : null}

      {usable.length > 0 ? (
        <p className="text-xs text-text-muted">
          <span className="num">{usable.length}</span>
          <span>
            {multiple
              ? ' مجلداً متاحاً. اكتب للبحث، ثم أشّر على كل مجلد يودع فيه هذا النموذج.'
              : ' مجلداً متاحاً. اكتب للبحث، أو افتح القائمة واختر.'}
          </span>
        </p>
      ) : null}

      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}

      {truncated ? <Alert tone="warning">القائمة غير كاملة — اكتب اسم المجلد للبحث عنه.</Alert> : null}

      {error && usable.length === 0 ? (
        <Alert tone="error">تعذر تحميل شجرة المجلدات. حدّث الصفحة وحاول مجدداً.</Alert>
      ) : null}

      {!loading && !error && usable.length === 0 ? (
        <Alert tone="warning">
          {allowed
            ? 'لا يوجد من مجلدات هذا النموذج مجلدٌ تملك فيه صلاحية «رفع». اطلب من مدير النظام منحك الصلاحية، أو إضافة مجلد آخر إلى النموذج.'
            : 'لا يوجد مجلد تملك فيه صلاحية «رفع». اطلب من مدير النظام منحك الصلاحية على المجلد الذي تودع فيه كتبك.'}
        </Alert>
      ) : null}
    </div>
  );
}
