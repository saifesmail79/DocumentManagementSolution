import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, Folder, FolderOpen, Link2Off, RefreshCw } from 'lucide-react';

import { useTree } from '../TreeContext.jsx';
import { Spinner } from './ui.jsx';

/**
 * The filing tree.
 *
 * The API returns every browsable folder flat, in depth-first order; nesting
 * happens here. One request rather than one per expanded node, because a filing
 * tree is browsed by clicking around it and a round trip per expand makes that
 * feel broken.
 *
 * Sorted with a real Arabic collator rather than a plain string compare —
 * JavaScript's default ordering is by code point, which puts Arabic names in an
 * order no reader would call alphabetical.
 */
const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });

/**
 * Nests the flat list.
 *
 * A folder whose parent is absent becomes a root. That is not a defensive
 * fallback for bad data — it is the normal shape when someone is granted a
 * subfolder inside a branch they cannot otherwise see, and dropping those nodes
 * would hide folders the user was deliberately given.
 */
function buildTree(folders) {
  const nodes = new Map(folders.map((folder) => [folder.folderId, { ...folder, children: [] }]));
  const roots = [];

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      // Either a genuine root, or visible-but-detached from an invisible parent.
      roots.push({ ...node, detached: Boolean(node.parentId) });
    }
  }

  const sort = (list) => {
    list.sort((a, b) => collator.compare(a.name, b.name));
    for (const item of list) sort(item.children);
    return list;
  };

  return sort(roots);
}

/** Ids of every ancestor of `folderId`, so the tree can open to the current folder. */
function ancestorsOf(folders, folderId) {
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]));
  const chain = new Set();
  let current = byId.get(folderId);
  while (current?.parentId && byId.has(current.parentId)) {
    chain.add(current.parentId);
    current = byId.get(current.parentId);
  }
  return chain;
}

export default function FolderTree() {
  const { folderId } = useParams();
  const navigate = useNavigate();
  const { folders, truncated, loading, error, reload } = useTree();

  const [expanded, setExpanded] = useState(() => new Set());
  // Tracks which folder the auto-expand has already run for, so a user who
  // collapses a branch does not have it reopened on every render.
  const [openedFor, setOpenedFor] = useState(null);

  const tree = useMemo(() => buildTree(folders), [folders]);

  useEffect(() => {
    if (!folderId || folderId === openedFor || folders.length === 0) return;
    const chain = ancestorsOf(folders, folderId);
    setExpanded((current) => new Set([...current, ...chain]));
    setOpenedFor(folderId);
  }, [folderId, folders, openedFor]);

  function toggle(id) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading && folders.length === 0) return <Spinner />;

  return (
    <nav aria-label="شجرة المجلدات" className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          المجلدات
        </span>
        <button
          onClick={reload}
          title="تحديث"
          aria-label="تحديث الشجرة"
          className="rounded p-1 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error ? <p className="px-1 text-xs text-red-600">تعذر تحميل الشجرة.</p> : null}

      <div className="flex-1 overflow-y-auto">
        <button
          onClick={() => navigate('/folders')}
          className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-right text-sm
            transition-colors ${
              !folderId
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-text hover:bg-surface-muted'
            }`}
        >
          <Folder size={15} className="shrink-0" />
          <span className="truncate">جميع المجلدات</span>
        </button>

        {tree.length === 0 && !loading ? (
          <p className="px-2 py-3 text-xs text-text-muted">لا توجد مجلدات متاحة لك.</p>
        ) : null}

        <ul>
          {tree.map((node) => (
            <TreeNode
              key={node.folderId}
              node={node}
              level={0}
              activeId={folderId}
              expanded={expanded}
              onToggle={toggle}
              onSelect={(id) => navigate(`/folders/${id}`)}
            />
          ))}
        </ul>

        {truncated ? (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-600">
            الشجرة كبيرة وتم عرض جزء منها فقط. استخدم البحث للوصول إلى بقية المجلدات.
          </p>
        ) : null}
      </div>
    </nav>
  );
}

function TreeNode({ node, level, activeId, expanded, onToggle, onSelect }) {
  const isOpen = expanded.has(node.folderId);
  const isActive = activeId === node.folderId;
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded-lg transition-colors ${
          isActive ? 'bg-primary/10' : 'hover:bg-surface-muted'
        }`}
        // Indent grows away from the start edge, which RTL flips automatically.
        style={{ paddingInlineStart: `${level * 12}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.folderId)}
            aria-label={isOpen ? 'طي' : 'توسيع'}
            aria-expanded={isOpen}
            className="shrink-0 rounded p-1 text-text-muted hover:text-primary"
          >
            {/* RTL: a collapsed node points leftward, which reads as "forward". */}
            {isOpen ? <ChevronDown size={13} /> : <ChevronLeft size={13} />}
          </button>
        ) : (
          <span className="w-[21px] shrink-0" aria-hidden="true" />
        )}

        <button
          onClick={() => onSelect(node.folderId)}
          className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pe-2 text-right text-sm ${
            isActive ? 'font-medium text-primary' : 'text-text'
          }`}
        >
          {isOpen && hasChildren ? (
            <FolderOpen size={15} className="shrink-0 text-primary/70" />
          ) : (
            <Folder size={15} className="shrink-0 text-text-muted" />
          )}
          <span className="truncate">{node.name}</span>

          {/* A folder reached through an invisible parent. Marking it explains why
              it sits at the top level instead of under the branch it belongs to. */}
          {node.detached ? (
            <Link2Off size={11} className="shrink-0 text-amber-600" aria-label="مجلد مشارَك" />
          ) : null}

          {node.documentCount > 0 ? (
            <span className="num shrink-0 text-[11px] text-text-muted">{node.documentCount}</span>
          ) : null}
        </button>
      </div>

      {isOpen && hasChildren ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.folderId}
              node={child}
              level={level + 1}
              activeId={activeId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
