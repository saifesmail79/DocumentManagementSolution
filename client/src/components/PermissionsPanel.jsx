import { useCallback, useEffect, useState } from 'react';
import { Shield, Trash2, Plus, Unlink, Link as LinkIcon, X } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { Button, Card, Spinner, Alert, TextField } from './ui.jsx';

/**
 * Folder permission editor.
 *
 * Reachable by anyone holding MANAGE_PERMS on the folder, not only
 * administrators — the point of that verb is that a department runs its own
 * branch. The server checks it per folder; this component only decides what to
 * draw.
 *
 * Inherited entries are shown read-only alongside the folder's own. "Why can
 * this person read this folder" is usually answered several levels up, and a
 * screen that hides that is what makes permissions feel like guesswork.
 */

/** The six verbs, in the order they escalate. */
const VERBS = [
  { key: 'browse', bit: 1, label: 'استعراض', hint: 'رؤية المجلد وعناوين وثائقه' },
  { key: 'read', bit: 2, label: 'قراءة', hint: 'فتح الوثائق وتنزيلها' },
  { key: 'upload', bit: 4, label: 'رفع', hint: 'إضافة وثائق وإصدارات جديدة' },
  { key: 'editMeta', bit: 8, label: 'تعديل البيانات', hint: 'تغيير العناوين والحقول' },
  { key: 'delete', bit: 16, label: 'حذف', hint: 'حذف الوثائق والمجلدات' },
  { key: 'managePerms', bit: 32, label: 'إدارة الصلاحيات', hint: 'تعديل هذه القائمة' },
];

const bitsToLabels = (bits) =>
  VERBS.filter((verb) => (bits & verb.bit) !== 0)
    .map((verb) => verb.label)
    .join('، ') || '—';

export default function PermissionsPanel({ folderId, folderName, onClose, onChanged }) {
  const [acl, setAcl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [picker, setPicker] = useState({ open: false, query: '', results: [] });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAcl(await api.admin.folderAcl(folderId));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'لا تملك صلاحية إدارة هذا المجلد.'
          : 'تعذر تحميل الصلاحيات.',
      );
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(principalId, allowBits, denyBits) {
    setBusy(true);
    setError(null);
    try {
      if (allowBits === 0 && denyBits === 0) {
        // An entry that neither allows nor denies means "remove it" — the server
        // refuses to store one, so say it plainly rather than surfacing a
        // constraint error.
        await api.admin.removeAce(folderId, principalId);
      } else {
        await api.admin.setAce(folderId, principalId, { allowBits, denyBits });
      }
      setEditing(null);
      await load();
      onChanged?.();
    } catch {
      setError('تعذر حفظ الصلاحية.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(principalId, displayName) {
    if (!window.confirm(`إزالة صلاحيات ${displayName} من هذا المجلد؟`)) return;
    setBusy(true);
    try {
      await api.admin.removeAce(folderId, principalId);
      await load();
      onChanged?.();
    } catch {
      setError('تعذر إزالة الصلاحية.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleInheritance() {
    const breaking = acl.folder.inheritsAcl;

    const message = breaking
      ? 'إيقاف الوراثة من المجلد الأعلى. سيتم نسخ الصلاحيات الموروثة الحالية إلى هذا المجلد حتى لا يفقد أحد وصوله. متابعة؟'
      : 'إعادة تفعيل الوراثة من المجلد الأعلى؟';

    if (!window.confirm(message)) return;

    setBusy(true);
    try {
      await api.admin.setInheritance(folderId, !breaking, true);
      await load();
      onChanged?.();
    } catch {
      setError('تعذر تغيير الوراثة.');
    } finally {
      setBusy(false);
    }
  }

  async function searchPrincipals(query) {
    setPicker((current) => ({ ...current, query }));
    if (query.trim().length < 1) return setPicker((current) => ({ ...current, results: [] }));
    try {
      const { principals } = await api.admin.principals(query);
      setPicker((current) => ({ ...current, results: principals }));
    } catch {
      /* the picker degrades to empty rather than blocking the panel */
    }
  }

  if (loading) return <Spinner label="جارٍ تحميل الصلاحيات…" />;
  if (error && !acl) return <Alert tone="error">{error}</Alert>;

  return (
    <Card className="p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
          <Shield size={16} className="text-primary" />
          صلاحيات: {folderName}
        </h3>
        <button
          onClick={onClose}
          aria-label="إغلاق"
          className="rounded p-1 text-text-muted hover:bg-surface-muted hover:text-text"
        >
          <X size={16} />
        </button>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="mb-4 flex flex-row items-center gap-2">
        <Button
          variant="secondary"
          icon={acl.folder.inheritsAcl ? Unlink : LinkIcon}
          onClick={toggleInheritance}
          disabled={busy}
        >
          {acl.folder.inheritsAcl ? 'إيقاف الوراثة' : 'إعادة الوراثة'}
        </Button>
        <Button
          icon={Plus}
          onClick={() => setPicker({ open: true, query: '', results: [] })}
          disabled={busy}
        >
          إضافة صلاحية
        </Button>
        <span className="text-xs text-text-muted">
          {acl.folder.inheritsAcl ? 'يرث الصلاحيات من المجلد الأعلى' : 'لا يرث — الصلاحيات محلية فقط'}
        </span>
      </div>

      {picker.open ? (
        <div className="mb-4 rounded-lg border border-border bg-surface-muted/40 p-3">
          <TextField
            label="ابحث عن مستخدم أو مجموعة"
            value={picker.query}
            onChange={(event) => searchPrincipals(event.target.value)}
            autoFocus
          />
          <ul className="mt-2 max-h-48 overflow-y-auto">
            {picker.results.map((principal) => (
              <li key={principal.principalId}>
                <button
                  onClick={() => {
                    setEditing({
                      principalId: principal.principalId,
                      displayName: principal.displayName,
                      allowBits: 1,
                      denyBits: 0,
                    });
                    setPicker({ open: false, query: '', results: [] });
                  }}
                  className="w-full rounded px-2 py-1.5 text-right text-sm hover:bg-primary/10"
                >
                  {principal.displayName}
                  <span className="me-2 text-xs text-text-muted">
                    {principal.type === 'group' ? 'مجموعة' : principal.username}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {editing ? (
        <VerbEditor
          entry={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(allowBits, denyBits) => save(editing.principalId, allowBits, denyBits)}
        />
      ) : null}

      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
        صلاحيات هذا المجلد
      </h4>

      {acl.entries.length === 0 ? (
        <p className="mb-4 text-sm text-text-muted">لا توجد صلاحيات محلية.</p>
      ) : (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <th className="px-3 py-2 text-right font-semibold">الجهة</th>
                <th className="px-3 py-2 text-right font-semibold">مسموح</th>
                <th className="px-3 py-2 text-right font-semibold">ممنوع</th>
                <th className="px-3 py-2 text-center font-semibold">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {acl.entries.map((entry) => (
                <tr key={entry.aceId} className="hover:bg-surface-muted/30">
                  <td className="px-3 py-2 text-right">
                    <span className="font-medium text-text">{entry.displayName}</span>
                    <span className="me-2 text-xs text-text-muted">
                      {entry.principalType === 'group' ? 'مجموعة' : 'مستخدم'}
                    </span>
                    {!entry.isActive ? (
                      <span className="me-2 text-xs text-amber-600">غير مفعّل</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right text-text-muted">
                    {bitsToLabels(entry.allowBits)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {entry.denyBits ? (
                      <span className="text-red-600">{bitsToLabels(entry.denyBits)}</span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => setEditing({ ...entry })}
                        className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-primary/10 hover:text-primary"
                      >
                        تعديل
                      </button>
                      <button
                        onClick={() => remove(entry.principalId, entry.displayName)}
                        aria-label="إزالة"
                        className="rounded border border-border p-1 text-red-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {acl.inherited.length > 0 ? (
        <>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            موروثة من المجلدات الأعلى
          </h4>
          <ul className="space-y-1">
            {acl.inherited.map((entry, index) => (
              <li
                key={`${entry.folderId}-${entry.principalId}-${index}`}
                className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="font-medium text-text">{entry.displayName}</span>
                <span className="text-text-muted">{bitsToLabels(entry.allowBits)}</span>
                {entry.denyBits ? (
                  <span className="text-red-600">منع: {bitsToLabels(entry.denyBits)}</span>
                ) : null}
                <span className="text-text-muted">من: {entry.folderName}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/** Checkbox grid for one entry. Allow and deny are separate: DENY beats ALLOW. */
function VerbEditor({ entry, busy, onCancel, onSave }) {
  const [allowBits, setAllowBits] = useState(entry.allowBits ?? 0);
  const [denyBits, setDenyBits] = useState(entry.denyBits ?? 0);

  const toggle = (bits, setBits, bit, otherBits, setOtherBits) => {
    setBits(bits ^ bit);
    // A verb cannot be both allowed and denied — deny would win and the allow
    // would be a lie on screen.
    if ((otherBits & bit) !== 0) setOtherBits(otherBits & ~bit);
  };

  return (
    <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <p className="mb-2 text-sm font-medium text-text">{entry.displayName}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        {VERBS.map((verb) => (
          <div key={verb.key} className="flex items-center justify-between gap-2 rounded bg-surface px-2 py-1.5">
            <span className="text-sm text-text" title={verb.hint}>
              {verb.label}
            </span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={(allowBits & verb.bit) !== 0}
                  onChange={() => toggle(allowBits, setAllowBits, verb.bit, denyBits, setDenyBits)}
                />
                سماح
              </label>
              <label className="flex items-center gap-1 text-xs text-red-600">
                <input
                  type="checkbox"
                  checked={(denyBits & verb.bit) !== 0}
                  onChange={() => toggle(denyBits, setDenyBits, verb.bit, allowBits, setAllowBits)}
                />
                منع
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-row gap-2">
        <Button onClick={() => onSave(allowBits, denyBits)} disabled={busy}>
          حفظ
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          إلغاء
        </Button>
        {allowBits === 0 && denyBits === 0 ? (
          <span className="self-center text-xs text-text-muted">
            بلا صلاحيات — سيؤدي الحفظ إلى إزالة الإدخال.
          </span>
        ) : null}
      </div>
    </div>
  );
}
