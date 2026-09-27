/**
 * Where a generated letter is filed — one picker, used by both forms screens.
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
 * ─── Why a filtered select and not a tree ──────────────────────────────────
 *
 * A collapsible tree was rejected: the question here is "which folder", asked
 * once, and the full path answers it unambiguously where a bare name does not
 * (two folders may be called «الصادر»). The same choice was already made for
 * the correspondence intake folder. What a flat list lacks on a large archive
 * is reachability, so a text box narrows the options, and the selected folder
 * is always kept in the list even when the filter excludes it — otherwise
 * typing would silently clear a choice already made.
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
 * belong to a different signed-in person. The select then shows «— اختر
 * المجلد —» while a folder id nobody saw is still held in state, and the letter
 * is filed — or refused — for a destination the person never chose.
 *
 * So the fill screen asks for that value to be cleared, which makes the missing
 * choice visible and blocks the submit. The administration dialog does not: it
 * lists folders the tree endpoint may have capped, and dropping a stored default
 * merely because it lies past the cap would be a quiet edit to someone else's
 * configuration.
 */

import { useEffect, useMemo, useState } from 'react';

import { useTree } from '../TreeContext.jsx';
import { Alert, TextField } from './ui.jsx';

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
      return { folderId: folder.folderId, permissions: folder.permissions, path: parts.join(' / ') };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'ar'));
}

/**
 * @param {object} props
 * @param {string} props.value          The chosen folder id, as a string ('' = none).
 * @param {Function} props.onChange     Called with the new folder id string.
 * @param {string} [props.label]
 * @param {string} [props.hint]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.requireUpload] Keep only folders the user may file into.
 * @param {string} [props.emptyLabel]   Offer "no folder" with this text; omitted = required.
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
  const [filter, setFilter] = useState('');

  const usable = useMemo(
    () => withPaths(folders ?? []).filter((folder) => !requireUpload || folder.permissions?.upload),
    [folders, requireUpload],
  );

  /*
   * A value the list does not contain is no choice at all, so it is dropped.
   *
   * Only once the tree has actually arrived: while it is loading, or if it
   * failed, `usable` is empty for reasons that say nothing about whether the
   * folder exists, and clearing then would throw away a good default.
   */
  useEffect(() => {
    if (!clearWhenUnavailable || loading || error || !value) return;
    if (!usable.some((folder) => folder.folderId === String(value))) onChange('');
  }, [clearWhenUnavailable, loading, error, value, usable, onChange]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return usable;
    // The chosen folder stays in the list whatever the filter says, so
    // narrowing the search never throws away a selection already made.
    return usable.filter(
      (folder) => folder.path.toLowerCase().includes(needle) || folder.folderId === String(value),
    );
  }, [usable, filter, value]);

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-text">{label}</span>
        <select
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || loading}
          className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
            focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">{emptyLabel ?? '— اختر المجلد —'}</option>
          {shown.map((folder) => (
            <option key={folder.folderId} value={folder.folderId}>
              {folder.path}
            </option>
          ))}
        </select>
      </label>

      {/* Offered whenever there is more than one folder; a filter over a single
          option is furniture, and a list of forty without one is unusable. */}
      {usable.length > 1 ? (
        <TextField
          label="تصفية المجلدات"
          placeholder="اكتب جزءاً من اسم المجلد أو مساره"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={disabled}
          hint={
            filter.trim() ? (
              <>
                <span>المعروض </span>
                <span className="num">{shown.length}</span>
                <span> من </span>
                <span className="num">{usable.length}</span>
                <span> مجلداً</span>
              </>
            ) : (
              <>
                <span className="num">{usable.length}</span>
                <span> مجلداً متاحاً</span>
              </>
            )
          }
        />
      ) : null}

      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}

      {truncated ? <Alert tone="warning">القائمة غير كاملة — استخدم البحث.</Alert> : null}

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
