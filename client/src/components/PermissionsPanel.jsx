import { useCallback, useEffect, useState } from 'react';
import { Shield, Trash2, Plus, Unlink, Link as LinkIcon, X } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { Button, Card, Spinner, Alert, TextField } from './ui.jsx';
import PermissionIcons, { VERBS } from './PermissionIcons.jsx';
import { RoleBadge, RolePicker } from './RoleBadge.jsx';
import { useDialogs } from './DialogProvider.jsx';
import { Modal } from './Modal.jsx';

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


export default function PermissionsPanel({ folderId, folderName, onClose, onChanged }) {
  const [acl, setAcl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [picker, setPicker] = useState({ open: false, query: '', results: [] });
  /*
   * The roles a grant can be built from.
   *
   * The server has always accepted a `roleId` on an access-control entry and
   * stored it as `from_role_id`, but nothing ever sent one — so the roles tab
   * could create templates that no screen could apply, and the column recorded
   * nothing. Offering them here is what makes that feature reachable.
   */
  const [roles, setRoles] = useState([]);
  const { confirm } = useDialogs();

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

  useEffect(() => {
    // A failure here only costs the shortcut; the verb checkboxes still work.
    api.admin
      .roles()
      .then((result) => setRoles(result.roles ?? []))
      .catch(() => setRoles([]));
  }, []);

  async function save(principalId, allowBits, denyBits, roleId = null) {
    setBusy(true);
    setError(null);
    try {
      if (allowBits === 0 && denyBits === 0) {
        // An entry that neither allows nor denies means "remove it" — the server
        // refuses to store one, so say it plainly rather than surfacing a
        // constraint error.
        await api.admin.removeAce(folderId, principalId);
      } else {
        // `roleId` is recorded, not enforced: the bits are copied onto the entry
        // at grant time, so editing the role later leaves existing grants alone.
        // It is what lets the list say where a grant came from.
        await api.admin.setAce(folderId, principalId, { allowBits, denyBits, roleId });
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
    const confirmed = await confirm({
      title: 'إزالة الصلاحية',
      message: `ستُزال صلاحيات ${displayName} على هذا المجلد.`,
      detail: 'الصلاحيات الموروثة من مجلد أعلى لا تتأثر بهذا الإجراء.',
      confirmLabel: 'إزالة',
      variant: 'danger',
    });
    if (!confirmed) return;
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

    const confirmed = await confirm({
      title: breaking ? 'إيقاف الوراثة' : 'إعادة تفعيل الوراثة',
      message: breaking
        ? 'لن يرث هذا المجلد صلاحيات المجلد الأعلى بعد الآن.'
        : 'سيعود هذا المجلد إلى وراثة صلاحيات المجلد الأعلى.',
      detail: breaking
        ? 'تُنسخ الصلاحيات الموروثة الحالية إلى هذا المجلد أولاً، حتى لا يفقد أحد وصوله.'
        : 'الصلاحيات الممنوحة على هذا المجلد مباشرةً تبقى كما هي.',
      confirmLabel: breaking ? 'إيقاف الوراثة' : 'تفعيل الوراثة',
      variant: 'warning',
    });
    if (!confirmed) return;

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
                  <span className="ms-2 text-xs text-text-muted">
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
          key={editing.principalId}
          entry={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          roles={roles}
          onSave={(allowBits, denyBits, roleId) =>
            save(editing.principalId, allowBits, denyBits, roleId)}
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
                    <span className="ms-2 text-xs text-text-muted">
                      {entry.principalType === 'group' ? 'مجموعة' : 'مستخدم'}
                    </span>
                    {/* Where the grant came from. Recorded at grant time, so it
                        stays true even after the role itself is edited — which
                        is exactly what the badge's tooltip says. */}
                    {entry.fromRole ? (
                      <span className="ms-2 inline-flex align-middle">
                        <RoleBadge
                          role={roles.find((role) => role.roleId === entry.fromRoleId) ?? null}
                          name={entry.fromRole}
                          hint="نُسخت الصلاحيات من هذا الدور لحظة المنح؛ تعديل الدور لاحقاً لا يغيّر هذا الإدخال."
                        />
                      </span>
                    ) : null}
                    {!entry.isActive ? (
                      <span className="ms-2 text-xs text-amber-600">غير مفعّل</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <PermissionIcons bits={entry.allowBits} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {entry.denyBits ? (
                      <PermissionIcons bits={entry.denyBits} tone="deny" />
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
                <PermissionIcons bits={entry.allowBits} />
                {entry.denyBits ? <PermissionIcons bits={entry.denyBits} tone="deny" /> : null}
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
/**
 * Allow and deny, one row per verb.
 *
 * A dialog rather than a panel that unfolds above the table: the entry being
 * edited sits in that table, and expanding a block over it pushed the row out
 * from under the pointer that had just clicked it.
 *
 * Keyed by the entry it is editing, so opening a second one re-seeds the
 * checkboxes instead of carrying the first one's state across.
 */
/**
 * A verb's three states, in RTL reading order: the affirmative first.
 *
 * «بلا» is not "off" — it means this entry says nothing about the verb, so
 * whatever a higher folder grants or denies still applies. That third meaning
 * is what the old pair of checkboxes could not draw.
 */
const VERB_STATES = [
  { key: 'allow', label: 'سماح', active: 'bg-green-500/10 font-medium text-green-600' },
  { key: 'none', label: 'بلا', active: 'bg-surface-muted font-medium text-text' },
  { key: 'deny', label: 'منع', active: 'bg-red-500/10 font-medium text-red-600' },
];

function VerbEditor({ entry, busy, onCancel, onSave, roles = [] }) {
  const [allowBits, setAllowBits] = useState(entry.allowBits ?? 0);
  const [denyBits, setDenyBits] = useState(entry.denyBits ?? 0);
  const [roleId, setRoleId] = useState(entry.fromRoleId ?? '');

  /*
   * One verb is in exactly one of three states — allowed, unstated, denied.
   * The two-checkbox rendering hid that: a pair of boxes reads as independent
   * switches, with the mutual exclusion happening off-screen after the click.
   * A segmented control per verb makes the three states the control itself.
   */
  const stateOf = (bit) =>
    (denyBits & bit) !== 0 ? 'deny' : (allowBits & bit) !== 0 ? 'allow' : 'none';

  const setState = (bit, state) => {
    setAllowBits(state === 'allow' ? allowBits | bit : allowBits & ~bit);
    setDenyBits(state === 'deny' ? denyBits | bit : denyBits & ~bit);
  };

  const emptying = allowBits === 0 && denyBits === 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title="تعديل الصلاحية"
      subtitle={entry.displayName}
      icon={Shield}
      size="md"
      footer={
        <>
          <Button
            onClick={() => onSave(allowBits, denyBits, roleId === '' ? null : Number(roleId))}
            disabled={busy}
          >
            حفظ
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            إلغاء
          </Button>
          {emptying ? (
            <span className="text-xs text-amber-600">
              بلا صلاحيات — سيؤدي الحفظ إلى إزالة الإدخال.
            </span>
          ) : null}
        </>
      }
    >
      <p className="mb-3 text-xs text-text-muted">
        «منع» يتقدّم على «سماح» دائماً، بما في ذلك السماح الموروث من مجلد أعلى.
      </p>

      {/*
        A starting point, not a lock.

        Choosing a role ticks the verbs it carries and records which role the
        grant came from; the checkboxes stay editable afterwards, because the
        bits are copied at grant time and the entry is what the server enforces.
        Editing the role later never changes a grant already made.

        Chips, not a dropdown: five roles read as five sentences in a select,
        and the one being considered hid the other four. As chips every option
        is visible at once, the icon carries the meaning, and the description
        appears on hover instead of being prose inside the control.
      */}
      {roles.length > 0 ? (
        <div className="mb-3">
          <span className="mb-1.5 block text-xs text-text-muted">ابدأ من دور (اختياري)</span>
          <RolePicker
            roles={roles}
            value={roleId}
            fallbackName={entry.fromRole}
            disabled={busy}
            onChange={(chosen, role) => {
              setRoleId(chosen);
              if (!role) return;
              setAllowBits(role.permissionBits);
              // A role grants; it never denies. Leaving a stale deny in place
              // would silently cancel part of what was just chosen.
              setDenyBits(0);
            }}
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        {VERBS.map((verb) => {
          const Icon = verb.icon;
          const current = stateOf(verb.bit);

          return (
            <div
              key={verb.key}
              className="flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2"
            >
              {/* The same icon the tables draw for this verb, so the editor and
                  the matrix it produces speak one visual language. */}
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon size={14} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-text">{verb.label}</span>
                  <span className="block truncate text-[11px] text-text-muted">{verb.hint}</span>
                </span>
              </span>

              {/* A radiogroup, because the three states are exclusive: a screen
                  reader should announce "one of three", not three toggles. */}
              <div
                role="radiogroup"
                aria-label={verb.label}
                className="flex shrink-0 overflow-hidden rounded-lg border border-border"
              >
                {VERB_STATES.map((state, index) => (
                  <button
                    key={state.key}
                    type="button"
                    role="radio"
                    aria-checked={current === state.key}
                    disabled={busy}
                    onClick={() => setState(verb.bit, state.key)}
                    className={`px-3 py-1 text-xs transition-colors focus:outline-none
                      focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed
                      ${index > 0 ? 'border-s border-border' : ''}
                      ${current === state.key ? state.active : 'text-text-muted hover:bg-surface-muted/60'}`}
                  >
                    {state.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* What will actually be stored, drawn exactly as the table will draw it. */}
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-surface-muted/40 px-3 py-2">
        <span className="text-xs text-text-muted">الناتج:</span>
        <PermissionIcons bits={allowBits} />
        {denyBits !== 0 ? <PermissionIcons bits={denyBits} tone="deny" /> : null}
      </div>
    </Modal>
  );
}
