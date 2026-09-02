import { useCallback, useEffect, useState } from 'react';
import {
  MessageSquare, Link2, Tag, Send, Trash2, Share2, Copy, QrCode,
  Lock, Unlock, CalendarClock, ShieldAlert, RotateCcw, Check, X, Bell, BellOff,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatDuration } from '../format.js';
import { useDialogs } from './DialogProvider.jsx';
import { Button, Card, Alert, TextField, Spinner } from './ui.jsx';

/**
 * The side panels on a document: tags, comments, relations, approvals, state
 * and sharing.
 *
 * Grouped in one file because they share a shape — each loads its own slice,
 * acts on it, and reloads — and splitting them into six files would spread that
 * pattern thin without making any of them easier to read.
 *
 * Each panel decides what to render from the document's own `permissions`, but
 * none of them enforces anything: the server refuses regardless of what is
 * drawn. Hiding a control the user cannot use is courtesy, not security.
 */

// ── Tags ─────────────────────────────────────────────────────────────────

export function TagPanel({ documentId, canEdit, onCount }) {
  const [tags, setTags] = useState([]);
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTags((await api.documentTags(documentId)).tags.map((t) => t.name));
    } catch {
      setTags([]);
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

/*
 * `onCount` — how many items this panel holds.
 *
 * The tab strip needs to show which sections have something in them without
 * opening each one, and only the panel knows. Reported from an effect on the
 * loaded state rather than from inside the fetch, so adding or removing an item
 * updates the tab immediately instead of waiting for the next reload.
 *
 * The parent's callback is identity-stable and ignores an unchanged value, so
 * this cannot drive a render loop.
 */
  useEffect(() => {
    onCount?.(tags?.length ?? 0);
  }, [tags, onCount]);

  async function commit(next) {
    setBusy(true);
    try {
      await api.setTags(documentId, next);
      setTags(next);
    } finally {
      setBusy(false);
    }
  }

  async function suggest(value) {
    setDraft(value);
    if (value.trim().length < 1) return setSuggestions([]);
    try {
      const result = await api.tags(value);
      setSuggestions(result.tags.filter((t) => !tags.includes(t.name)).slice(0, 6));
    } catch {
      setSuggestions([]);
    }
  }

  function add(name) {
    const clean = String(name).trim();
    if (!clean || tags.includes(clean)) return;
    setDraft('');
    setSuggestions([]);
    commit([...tags, clean]);
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <Tag size={15} className="text-primary" />
        الوسوم
      </h3>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
          >
            {tag}
            {canEdit ? (
              <button
                onClick={() => commit(tags.filter((t) => t !== tag))}
                disabled={busy}
                aria-label={`إزالة ${tag}`}
                className="hover:text-red-600"
              >
                <X size={11} />
              </button>
            ) : null}
          </span>
        ))}
        {tags.length === 0 ? <span className="text-xs text-text-muted">لا توجد وسوم.</span> : null}
      </div>

      {canEdit ? (
        <div className="relative">
          <input
            value={draft}
            onChange={(event) => suggest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add(draft);
              }
            }}
            placeholder="أضف وسماً واضغط Enter"
            className="w-full rounded-lg border border-border bg-control px-3 py-1.5 text-sm
              focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {suggestions.length > 0 ? (
            <ul className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface shadow-sm">
              {suggestions.map((tag) => (
                <li key={tag.tagId}>
                  <button
                    onClick={() => add(tag.name)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-right text-sm hover:bg-primary/10"
                  >
                    <span>{tag.name}</span>
                    <span className="num text-xs text-text-muted">{tag.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// ── Comments ─────────────────────────────────────────────────────────────

export function CommentPanel({ documentId, currentUserId, canRead, onCount }) {
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) return setComments([]);
    try {
      setComments((await api.comments(documentId)).comments);
    } catch {
      setComments([]);
    }
  }, [documentId, canRead]);

  useEffect(() => {
    load();
  }, [load]);

/*
 * `onCount` — how many items this panel holds.
 *
 * The tab strip needs to show which sections have something in them without
 * opening each one, and only the panel knows. Reported from an effect on the
 * loaded state rather than from inside the fetch, so adding or removing an item
 * updates the tab immediately instead of waiting for the next reload.
 *
 * The parent's callback is identity-stable and ignores an unchanged value, so
 * this cannot drive a render loop.
 */
  useEffect(() => {
    onCount?.(comments?.length ?? 0);
  }, [comments, onCount]);

  async function submit(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api.addComment(documentId, draft.trim(), replyTo);
      setDraft('');
      setReplyTo(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) {
    return (
      <Card className="p-4">
        <p className="text-xs text-text-muted">تتطلب المناقشة صلاحية القراءة.</p>
      </Card>
    );
  }

  if (!comments) return <Spinner />;

  const roots = comments.filter((c) => !c.parentCommentId);

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <MessageSquare size={15} className="text-primary" />
        المناقشة
        <span className="num text-xs font-normal text-text-muted">({comments.length})</span>
      </h3>

      <ul className="mb-3 space-y-3">
        {roots.map((comment) => (
          <li key={comment.commentId}>
            <CommentBody
              comment={comment}
              currentUserId={currentUserId}
              onReply={() => setReplyTo(comment.commentId)}
              onDelete={async () => {
                await api.deleteComment(comment.commentId);
                await load();
              }}
            />
            <ul className="mt-2 space-y-2 border-s-2 border-border pe-3 ps-3">
              {comments
                .filter((c) => c.parentCommentId === comment.commentId)
                .map((child) => (
                  <li key={child.commentId}>
                    <CommentBody
                      comment={child}
                      currentUserId={currentUserId}
                      onDelete={async () => {
                        await api.deleteComment(child.commentId);
                        await load();
                      }}
                    />
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>

      {comments.length === 0 ? (
        <p className="mb-3 text-xs text-text-muted">لا توجد تعليقات بعد.</p>
      ) : null}

      <form onSubmit={submit} className="space-y-2">
        {replyTo ? (
          <p className="flex items-center gap-2 text-xs text-text-muted">
            رد على تعليق
            <button type="button" onClick={() => setReplyTo(null)} className="text-primary hover:underline">
              إلغاء
            </button>
          </p>
        ) : null}
        <textarea
          dir="rtl"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="اكتب تعليقاً…"
          className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm
            focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <Button type="submit" icon={Send} disabled={busy || !draft.trim()} className="!px-3 !py-1.5 text-xs">
          إرسال
        </Button>
      </form>
    </Card>
  );
}

function CommentBody({ comment, currentUserId, onReply, onDelete }) {
  if (comment.isDeleted) {
    // A tombstone, not a removal: replies below it would otherwise be orphaned.
    return <p className="text-xs italic text-text-muted">حُذف هذا التعليق.</p>;
  }

  return (
    <div className="rounded-lg bg-surface-muted/40 p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text">{comment.author}</span>
        <span className="num text-[11px] text-text-muted">{formatDate(comment.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-text">{comment.body}</p>
      <div className="mt-1 flex gap-2 text-[11px]">
        {onReply ? (
          <button onClick={onReply} className="text-text-muted hover:text-primary">
            رد
          </button>
        ) : null}
        {String(comment.authorId) === String(currentUserId) ? (
          <button onClick={onDelete} className="text-text-muted hover:text-red-600">
            حذف
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Relations ────────────────────────────────────────────────────────────

const RELATION_LABELS = {
  related: 'مرتبطة',
  supersedes: 'تحل محل',
  superseded_by: 'حلّت محلها',
  attachment: 'مرفق',
  reply_to: 'رد على',
};

export function RelationPanel({ documentId, onOpen, onCount }) {
  const [relations, setRelations] = useState([]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [type, setType] = useState('related');

  const load = useCallback(async () => {
    try {
      setRelations((await api.relations(documentId)).relations);
    } catch {
      setRelations([]);
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

/*
 * `onCount` — how many items this panel holds.
 *
 * The tab strip needs to show which sections have something in them without
 * opening each one, and only the panel knows. Reported from an effect on the
 * loaded state rather than from inside the fetch, so adding or removing an item
 * updates the tab immediately instead of waiting for the next reload.
 *
 * The parent's callback is identity-stable and ignores an unchanged value, so
 * this cannot drive a render loop.
 */
  useEffect(() => {
    onCount?.(relations?.length ?? 0);
  }, [relations, onCount]);

  async function search(value) {
    setQuery(value);
    if (value.trim().length < 2) return setResults([]);
    try {
      const found = await api.search(value);
      setResults(found.results.filter((r) => r.documentId !== documentId).slice(0, 6));
    } catch {
      setResults([]);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <Link2 size={15} className="text-primary" />
        وثائق مرتبطة
      </h3>

      <ul className="mb-2 space-y-1">
        {relations.map((relation) => (
          <li
            key={relation.relationId}
            className="flex items-center justify-between gap-2 rounded bg-surface-muted/40 px-2 py-1.5"
          >
            <button
              onClick={() => onOpen(relation.documentId)}
              className="min-w-0 flex-1 truncate text-right text-sm text-text hover:text-primary"
            >
              {relation.title}
            </button>
            <span className="shrink-0 text-[11px] text-text-muted">
              {RELATION_LABELS[relation.relationType] ?? relation.relationType}
              {!relation.outgoing ? ' ←' : ' →'}
            </span>
            <button
              onClick={async () => {
                await api.unrelate(relation.relationId);
                await load();
              }}
              aria-label="إزالة الربط"
              className="shrink-0 text-text-muted hover:text-red-600"
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>

      {relations.length === 0 ? <p className="mb-2 text-xs text-text-muted">لا توجد روابط.</p> : null}

      {adding ? (
        <div className="space-y-2">
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm"
          >
            {Object.entries(RELATION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <TextField value={query} onChange={(event) => search(event.target.value)} placeholder="ابحث عن وثيقة…" />
          <ul className="max-h-40 overflow-y-auto">
            {results.map((result) => (
              <li key={result.documentId}>
                <button
                  onClick={async () => {
                    await api.relate(documentId, result.documentId, type);
                    setAdding(false);
                    setQuery('');
                    setResults([]);
                    await load();
                  }}
                  className="w-full truncate rounded px-2 py-1.5 text-right text-sm hover:bg-primary/10"
                >
                  {result.title}
                </button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => setAdding(false)} className="!px-3 !py-1 text-xs">
            إلغاء
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)} className="!px-3 !py-1 text-xs">
          ربط وثيقة
        </Button>
      )}
    </Card>
  );
}

// ── State: lock, lifecycle, expiry, legal hold, watch ────────────────────

const LIFECYCLE_LABELS = {
  draft: 'مسودة',
  active: 'نافذة',
  superseded: 'محل محلها',
  obsolete: 'ملغاة',
};

export function StatePanel({ document, isSuperAdmin, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [watching, setWatching] = useState(false);
  const { confirm, prompt } = useDialogs();

  const documentId = document.documentId;

  useEffect(() => {
    api
      .watches()
      .then((result) => setWatching(result.watches.some((w) => w.documentId === documentId)))
      .catch(() => {});
  }, [documentId]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? {
              locked: `الوثيقة محجوزة لدى ${caught.body?.lockedBy?.name ?? 'مستخدم آخر'}.`,
              not_your_lock: 'الحجز ليس لك.',
              forbidden: 'لا تملك صلاحية لهذا الإجراء.',
              legal_hold: 'الوثيقة تحت حجز قانوني.',
            }[caught.code] ?? 'تعذر إتمام الإجراء.'
          : 'تعذر إتمام الإجراء.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-text">حالة الوثيقة</h3>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {document.legalHold ? (
        <Alert tone="warning">
          <span className="flex items-center gap-1">
            <ShieldAlert size={13} />
            تحت حجز قانوني — لا يمكن حذفها.
            {document.legalHoldReason ? ` (${document.legalHoldReason})` : ''}
          </span>
        </Alert>
      ) : null}

      {/*
        Sized to their content and set side by side.

        Both were `w-full` because this panel used to live in a narrow side
        column, which capped them. Once it became a full-width tab that cap was
        gone and a four-option dropdown and a date stretched the width of the
        page — a control that wide reads as a text field and gives no clue how
        much input it expects.
      */}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-text-muted">الحالة</span>
          <select
            value={document.lifecycleState ?? 'active'}
            disabled={busy}
            onChange={(event) => act(() => api.setLifecycle(documentId, event.target.value))}
            className="w-48 rounded-lg border border-border bg-control px-2 py-1.5 text-sm"
          >
            {Object.entries(LIFECYCLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-text-muted">تاريخ الانتهاء</span>
          <input
            type="date"
            dir="ltr"
            disabled={busy}
            defaultValue={document.expiresAt ? String(document.expiresAt).slice(0, 10) : ''}
            onChange={(event) => act(() => api.setExpiry(documentId, event.target.value || null))}
            className="w-44 rounded-lg border border-border bg-control px-2 py-1.5 text-sm"
          />
        </label>

      </div>

      <div className="mt-3 flex flex-row flex-wrap gap-2">
          {document.lockedBy ? (
            <Button
              variant="secondary"
              icon={Unlock}
              disabled={busy}
              onClick={() => act(() => api.checkIn(documentId))}
              className="!px-3 !py-1 text-xs"
            >
              إعادة الحجز
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon={Lock}
              disabled={busy}
              onClick={() => act(() => api.checkOut(documentId))}
              className="!px-3 !py-1 text-xs"
            >
              حجز للتعديل
            </Button>
          )}

          <Button
            variant="secondary"
            icon={watching ? BellOff : Bell}
            disabled={busy}
            onClick={() =>
              act(async () => {
                if (watching) await api.unwatch({ documentId });
                else await api.watch({ documentId });
                setWatching(!watching);
              })
            }
            className="!px-3 !py-1 text-xs"
          >
            {watching ? 'إلغاء المتابعة' : 'متابعة'}
          </Button>

          {isSuperAdmin ? (
            <Button
              variant={document.legalHold ? 'secondary' : 'danger'}
              icon={ShieldAlert}
              disabled={busy}
              onClick={async () => {
                if (document.legalHold) {
                  const lifted = await confirm({
                    title: 'رفع الحجز القانوني',
                    message: 'سيعود حذف هذه الوثيقة ممكناً وفق صلاحيات المجلد.',
                    confirmLabel: 'رفع الحجز',
                    variant: 'warning',
                  });
                  if (lifted) act(() => api.setLegalHold(documentId, false, null));
                  return;
                }

                // The reason is the whole value of the record — a hold with no
                // stated cause cannot be reviewed later, so dismissing the
                // dialog cancels the hold rather than placing an unexplained one.
                const reason = await prompt({
                  title: 'حجز قانوني',
                  message: 'يمنع الحجز حذف الوثيقة نهائياً حتى يُرفع، ويتقدّم على دورة الحياة وتاريخ الانتهاء.',
                  label: 'سبب الحجز',
                  placeholder: 'مثال: قضية رقم ١٢٣ / ٢٠٢٦',
                  confirmLabel: 'تطبيق الحجز',
                  variant: 'warning',
                  required: true,
                });
                if (reason) act(() => api.setLegalHold(documentId, true, reason));
              }}
              className="!px-3 !py-1 text-xs"
            >
              {document.legalHold ? 'رفع الحجز' : 'حجز قانوني'}
            </Button>
        ) : null}
      </div>

      {document.lockedBy ? (
        <p className="mt-2 text-xs text-amber-600">
          محجوزة لدى {document.lockedBy} منذ {formatDate(document.lockedAt)}
        </p>
      ) : null}
    </Card>
  );
}

// ── Sharing ──────────────────────────────────────────────────────────────

export function SharePanel({ documentId, canRead, onCount }) {
  const [links, setLinks] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ expiresInHours: 168, password: '', maxDownloads: '' });
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      setLinks((await api.shares(documentId)).links);
    } catch {
      setLinks([]);
    }
  }, [documentId, canRead]);

  useEffect(() => {
    load();
  }, [load]);

/*
 * `onCount` — how many items this panel holds.
 *
 * The tab strip needs to show which sections have something in them without
 * opening each one, and only the panel knows. Reported from an effect on the
 * loaded state rather than from inside the fetch, so adding or removing an item
 * updates the tab immediately instead of waiting for the next reload.
 *
 * The parent's callback is identity-stable and ignores an unchanged value, so
 * this cannot drive a render loop.
 */
  useEffect(() => {
    onCount?.(links?.length ?? 0);
  }, [links, onCount]);

  if (!canRead) return null;

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.createShare(documentId, {
        expiresInHours: Number(form.expiresInHours) || 168,
        password: form.password || null,
        maxDownloads: form.maxDownloads ? Number(form.maxDownloads) : null,
      });
      // Shown once: the token is hashed on the server and cannot be recovered.
      setCreated(result.url);
      setCreating(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <Share2 size={15} className="text-primary" />
        روابط المشاركة
      </h3>

      {created ? (
        <Alert tone="success">
          <div className="space-y-1">
            <p className="text-xs">الرابط جاهز — يُعرض مرة واحدة فقط:</p>
            <div className="flex items-center gap-1">
              <code dir="ltr" className="flex-1 truncate rounded bg-surface px-2 py-1 text-[11px]">
                {created}
              </code>
              <button
                onClick={() => navigator.clipboard?.writeText(created)}
                aria-label="نسخ"
                className="rounded border border-border p-1 hover:bg-primary/10"
              >
                <Copy size={12} />
              </button>
            </div>
          </div>
        </Alert>
      ) : null}

      <ul className="my-2 space-y-1">
        {links.map((link) => (
          <li
            key={link.shareId}
            className="flex items-center justify-between gap-2 rounded bg-surface-muted/40 px-2 py-1.5 text-xs"
          >
            <span className={link.revoked || link.expired ? 'text-text-muted line-through' : 'text-text'}>
              ينتهي {formatDate(link.expiresAt)}
              {link.hasPassword ? ' · بكلمة مرور' : ''}
              {link.maxDownloads ? ` · ${link.downloads}/${link.maxDownloads}` : ` · ${link.downloads} تنزيل`}
            </span>
            {!link.revoked ? (
              <button
                onClick={async () => {
                  await api.revokeShare(link.shareId);
                  await load();
                }}
                aria-label="إبطال"
                className="text-text-muted hover:text-red-600"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {creating ? (
        <form onSubmit={create} className="space-y-2">
          <TextField
            label="مدة الصلاحية (ساعات)"
            value={form.expiresInHours}
            onChange={(event) => setForm({ ...form, expiresInHours: event.target.value })}
            dir="ltr"
          />
          <TextField
            label="كلمة مرور (اختياري)"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            dir="ltr"
          />
          <TextField
            label="حد التنزيلات (اختياري)"
            value={form.maxDownloads}
            onChange={(event) => setForm({ ...form, maxDownloads: event.target.value })}
            dir="ltr"
          />
          <div className="flex flex-row gap-2">
            <Button type="submit" disabled={busy} className="!px-3 !py-1 text-xs">
              إنشاء
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreating(false)}
              className="!px-3 !py-1 text-xs"
            >
              إلغاء
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-row gap-2">
          <Button variant="secondary" onClick={() => setCreating(true)} className="!px-3 !py-1 text-xs">
            رابط جديد
          </Button>
          <a
            href={api.stampedUrl(documentId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1
              text-xs text-text-muted hover:bg-primary/10 hover:text-primary"
          >
            <QrCode size={13} />
            نسخة برمز QR
          </a>
        </div>
      )}
    </Card>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────

const APPROVAL_LABELS = {
  pending: 'قيد الاعتماد',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
  cancelled: 'ملغاة',
};

/**
 * One request, step by step: who is on each stage, what they decided, and how
 * long it sat there.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * The panel used to list decisions already taken and nothing else. Every
 * question people actually ask of an approval — where is it now, who is holding
 * it up, how long has it been there, how long did the earlier stages take — was
 * unanswerable, even though the API had been returning `decidedAt`,
 * `currentStep` and `completedAt` all along and the client was discarding them.
 *
 * ─── How a stage is timed ───────────────────────────────────────────────────
 *
 * A stage begins when the one before it ended, and the first begins when the
 * request was raised. So its duration is its own decision time minus the
 * previous one — and for the stage still open, it is the time since then,
 * counted to now.
 */
function RequestTimeline({ request, steps }) {
  // Latest decision per step: with `requireAll`, a step collects one row per
  // group member, and the step is finished when the last of them lands.
  const decisionFor = (order) =>
    request.decisions.filter((d) => d.step === order).slice(-1)[0] ?? null;

  let previousAt = request.requestedAt;

  return (
    <ol className="mt-2 space-y-1.5">
      {steps.map((step) => {
        const decision = decisionFor(step.order);
        const isCurrent = request.status === 'pending' && request.currentStep === step.order;
        const startedAt = previousAt;
        if (decision) previousAt = decision.decidedAt;

        // A stage after a rejection never ran, so it gets no duration at all —
        // showing "0 دقيقة" would imply it was decided instantly.
        const unreached = !decision && !isCurrent;

        const tone = decision?.decision === 'rejected'
          ? 'border-red-200 bg-red-50'
          : decision
            ? 'border-green-200 bg-green-50'
            : isCurrent
              ? 'border-primary/40 bg-primary/5'
              : 'border-border bg-surface-muted/30';

        return (
          <li key={step.order} className={`rounded-lg border px-2 py-1.5 ${tone}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-[11px]">
                <span className="num text-text-muted">{step.order}.</span>{' '}
                <span className="font-medium text-text">{step.approver}</span>
                {step.requireAll ? (
                  <span className="text-text-muted"> · موافقة الجميع</span>
                ) : null}
              </span>

              <span className="shrink-0 text-[11px]">
                {decision ? (
                  <span className={decision.decision === 'rejected' ? 'text-red-600' : 'text-green-600'}>
                    {decision.decision === 'rejected' ? 'رفض' : 'اعتمد'}
                  </span>
                ) : isCurrent ? (
                  <span className="text-primary">بانتظار القرار</span>
                ) : (
                  <span className="text-text-muted">لم تبدأ</span>
                )}
              </span>
            </div>

            {!unreached ? (
              <p className="mt-0.5 text-[11px] text-text-muted">
                {decision ? `${decision.actor} · ` : ''}
                {formatDuration(startedAt, decision?.decidedAt)}
                {decision ? '' : ' حتى الآن'}
                {/* The SLA is what turns a duration into a judgement. */}
                {step.slaHours && !decision ? ` · المهلة ${step.slaHours} ساعة` : ''}
              </p>
            ) : null}

            {decision?.note ? (
              <p className="mt-0.5 text-[11px] text-text">{decision.note}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ApprovalPanel({ documentId, canRead, onChanged, onCount }) {
  const [requests, setRequests] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      const [history, templateList] = await Promise.all([
        api.documentApprovals(documentId),
        api.approvalTemplates().catch(() => ({ templates: [] })),
      ]);
      setRequests(history.requests);
      setTemplates(templateList.templates ?? []);
    } catch {
      setRequests([]);
    }
  }, [documentId, canRead]);

  useEffect(() => {
    load();
  }, [load]);

/*
 * `onCount` — how many items this panel holds.
 *
 * The tab strip needs to show which sections have something in them without
 * opening each one, and only the panel knows. Reported from an effect on the
 * loaded state rather than from inside the fetch, so adding or removing an item
 * updates the tab immediately instead of waiting for the next reload.
 *
 * The parent's callback is identity-stable and ignores an unchanged value, so
 * this cannot drive a render loop.
 */
  useEffect(() => {
    onCount?.(requests?.length ?? 0);
  }, [requests, onCount]);

  if (!canRead) return null;

  const live = requests.find((r) => r.status === 'pending');

  async function start(templateId) {
    setBusy(true);
    setError(null);
    try {
      await api.requestApproval(documentId, templateId ? { templateId } : {});
      await load();
      await onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'no_template'
          ? 'لا يوجد مسار اعتماد لهذا النوع.'
          : caught instanceof ApiError && caught.code === 'already_pending'
            ? 'يوجد طلب اعتماد قائم بالفعل.'
            : 'تعذر بدء الاعتماد.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <Check size={15} className="text-primary" />
        الاعتماد
      </h3>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {requests.length === 0 ? (
        <p className="mb-2 text-xs text-text-muted">لم يُطلب اعتماد لهذه الوثيقة.</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {requests.map((request) => (
            <li key={request.requestId} className="rounded-lg bg-surface-muted/40 p-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-text">{APPROVAL_LABELS[request.status]}</span>
                <span className="num text-text-muted">{formatDate(request.requestedAt)}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-text-muted">
                بطلب من {request.requestedBy}
                {request.templateName ? ` · ${request.templateName}` : ''}
              </p>
              {/* Total elapsed, so "how long has this taken" is answered without
                  adding the stages up by hand. */}
              <p className="mt-0.5 text-[11px] text-text-muted">
                {request.status === 'pending' ? 'مضى ' : 'استغرق '}
                {formatDuration(request.requestedAt, request.completedAt)}
              </p>

              {(() => {
                const steps = templates.find(
                  (t) => t.templateId === request.templateId,
                )?.steps;

                // The template is the only source of the stages still to come.
                // Deleted since, or never linked: fall back to what was decided,
                // which is at least the truth about what happened.
                if (steps?.length) return <RequestTimeline request={request} steps={steps} />;

                return request.decisions.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {request.decisions.map((decision, index) => (
                      <li key={index} className="text-[11px] text-text-muted">
                        خطوة {decision.step}: {decision.decision === 'approved' ? 'اعتمد' : 'رفض'} —{' '}
                        {decision.actor} · {formatDate(decision.decidedAt)}
                        {decision.note ? ` (${decision.note})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null;
              })()}
              {request.status === 'pending' ? (
                <button
                  onClick={async () => {
                    await api.cancelApproval(request.requestId);
                    await load();
                  }}
                  className="mt-1 text-[11px] text-text-muted hover:text-red-600"
                >
                  إلغاء الطلب
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!live ? (
        <div className="flex flex-row flex-wrap gap-2">
          {templates.length > 0 ? (
            <select
              disabled={busy}
              onChange={(event) => event.target.value && start(Number(event.target.value))}
              defaultValue=""
              className="rounded-lg border border-border bg-control px-2 py-1 text-xs"
            >
              <option value="">اختر مساراً…</option>
              {templates.map((template) => (
                <option key={template.templateId} value={template.templateId}>
                  {template.name}
                </option>
              ))}
            </select>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => start(null)} className="!px-3 !py-1 text-xs">
              طلب اعتماد
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

// ── Versions, with restore ───────────────────────────────────────────────

export function VersionPanel({ documentId, versions, canRestore, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { confirm } = useDialogs();

  async function restore(versionNumber) {
    const confirmed = await confirm({
      title: 'استعادة إصدار سابق',
      message: `سيُنشأ إصدار جديد يحمل محتوى الإصدار ${versionNumber}.`,
      detail: 'لا يُحذف أي إصدار: التاريخ كله يبقى محفوظاً، وتضاف الاستعادة إليه.',
      confirmLabel: 'استعادة',
      variant: 'warning',
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.restoreVersion(documentId, versionNumber);
      await onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'locked'
          ? `الوثيقة محجوزة لدى ${caught.body?.lockedBy?.name ?? 'مستخدم آخر'}.`
          : 'تعذرت الاستعادة.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul className="space-y-2">
        {versions.map((version, index) => (
          <li key={version.version} className="rounded border border-border p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="num font-medium text-text">إصدار {version.version}</span>
              <span className="num text-text-muted">{formatDate(version.uploadedAt)}</span>
            </div>
            <p className="mt-0.5 text-text-muted">{version.uploadedBy}</p>
            {version.comment ? <p className="mt-0.5 text-text">{version.comment}</p> : null}
            <div className="mt-1 flex gap-2">
              <a
                href={api.contentUrl(documentId, version.version)}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                فتح
              </a>
              {/* The newest version is already current, so restoring it is a no-op. */}
              {canRestore && index !== 0 ? (
                <button
                  onClick={() => restore(version.version)}
                  disabled={busy}
                  className="flex items-center gap-1 text-text-muted hover:text-primary"
                >
                  <RotateCcw size={11} />
                  استعادة
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
