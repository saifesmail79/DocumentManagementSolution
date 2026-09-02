/**
 * Folder security, in the same place as the users, groups and roles it grants to.
 *
 * ─── Why it lives here and not on the folder ────────────────────────────────
 *
 * Permissions were reachable only from the folder being browsed, which put a
 * security control in the middle of everyday filing and scattered the model
 * across as many screens as there are folders. Nobody could answer "who can see
 * what" without walking the tree.
 *
 * Administration already holds the other half — the accounts, the groups and
 * the roles a grant is built from — so the grant itself belongs beside them:
 * pick a folder on the left, see and edit exactly who holds what on the right.
 *
 * ─── The tree is the picker ─────────────────────────────────────────────────
 *
 * `/api/folders/tree` returns every folder the viewer may browse, already
 * carrying its own effective bits, so the list can mark the ones that cannot be
 * edited rather than letting someone choose a folder and then be refused.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Folder, Search, Shield } from 'lucide-react';

import { api } from '../api.js';
import { Card, Spinner, Alert, TextField, EmptyState } from './ui.jsx';
import PermissionsPanel from './PermissionsPanel.jsx';
import TabIntro from './TabIntro.jsx';

export default function FolderPermissionsTab() {
  const [folders, setFolders] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.tree();
      setFolders(result.folders ?? []);
      if (result.truncated) {
        setError('الشجرة كبيرة وعُرض جزء منها فقط — استخدم البحث للوصول إلى مجلد بعينه.');
      }
    } catch {
      setError('تعذر تحميل شجرة المجلدات.');
      setFolders([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const needle = query.trim().toLowerCase();

  /*
   * The full path per folder, built once from the parent links.
   *
   * A flat list of names is ambiguous the moment two folders share one — and
   * "Penelties" alone tells you nothing about which branch it is on, which is
   * exactly the question a permissions screen has to answer.
   */
  const withPaths = useMemo(() => {
    if (!folders) return [];
    const byId = new Map(folders.map((folder) => [folder.folderId, folder]));

    return folders.map((folder) => {
      const parts = [];
      let cursor = folder;
      // Bounded by the map: a cycle would otherwise hang the render.
      for (let hops = 0; cursor && hops < 64; hops += 1) {
        parts.unshift(cursor.name);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
      }
      return { ...folder, path: parts.join(' / ') };
    });
  }, [folders]);

  const visible = needle
    ? withPaths.filter((folder) => folder.path.toLowerCase().includes(needle))
    : withPaths;

  if (!folders) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.permissions" />

      {error ? <Alert tone="warning">{error}</Alert> : null}

      <div className="grid gap-3 lg:grid-cols-[22rem_1fr]">
        <Card className="flex flex-col overflow-hidden">
          <div className="border-b border-border bg-surface-muted px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            المجلدات
          </div>

          <div className="border-b border-border p-3">
            <TextField
              label="بحث"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ابحث بالاسم أو بالمسار"
            />
          </div>

          {visible.length === 0 ? (
            <EmptyState icon={Folder} title="لا مجلدات مطابقة" />
          ) : (
            <ul className="max-h-[32rem] divide-y divide-border/50 overflow-y-auto">
              {visible.map((folder) => {
                const active = selected?.folderId === folder.folderId;
                // Marked rather than hidden: knowing a folder exists and that
                // you may not edit it is more useful than it silently missing.
                const editable = folder.permissions?.managePerms;

                return (
                  <li key={folder.folderId}>
                    <button
                      type="button"
                      onClick={() => setSelected({ folderId: folder.folderId, name: folder.path })}
                      disabled={!editable}
                      className={`flex w-full items-center gap-2 px-4 py-2 text-right transition-colors
                        disabled:cursor-not-allowed disabled:opacity-50 ${
                          active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-surface-muted/50'
                        }`}
                    >
                      <Folder size={14} className="shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{folder.name}</span>
                        {folder.path !== folder.name ? (
                          <span className="block truncate text-[11px] text-text-muted">{folder.path}</span>
                        ) : null}
                      </span>
                      {!editable ? (
                        <span className="shrink-0 text-[10px] text-text-muted">للعرض فقط</span>
                      ) : (
                        <ChevronLeft size={14} className="shrink-0 text-text-muted" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {selected ? (
          <PermissionsPanel
            // Keyed on the folder, so switching re-seeds the panel rather than
            // leaving the previous folder's grants on screen.
            key={selected.folderId}
            folderId={selected.folderId}
            folderName={selected.name}
            onClose={() => setSelected(null)}
            onChanged={load}
          />
        ) : (
          <Card>
            <EmptyState
              icon={Shield}
              title="اختر مجلداً"
              hint="اختر مجلداً من القائمة لعرض من يملك صلاحية عليه وتعديلها."
            />
          </Card>
        )}
      </div>
    </div>
  );
}
