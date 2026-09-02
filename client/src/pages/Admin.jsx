import { useCallback, useEffect, useState } from 'react';
import {
  Users,
  UsersRound,
  KeyRound,
  Plus,
  Unlock,
  ShieldCheck,
  RotateCcw,
  SlidersHorizontal,
  Save,
  ScrollText,
  Shield,
  UserPlus,
  UserMinus,
  Search,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import QueueHealth from '../components/QueueHealth.jsx';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth.jsx';
import { ADMIN_TABS as TABS } from '../navigation.js';
import { formatBytes, formatDate, formatDateTime } from '../format.js';
import { passwordProblemMessages } from '../passwordProblems.js';
import { Button, Card, Spinner, Alert, TextField, EmptyState, CopyField } from '../components/ui.jsx';
import {
  ApiKeysTab,
  WebhooksTab,
  ApprovalTemplatesTab,
  ReportsTab,
} from '../components/AdminTabs.jsx';
import ClassificationTab from '../components/ClassificationTab.jsx';
import { useHelpTopic } from '../help/HelpContext.jsx';
import { SETTING_HELP, PERMISSION_BITS, roleDisplay } from '../help/content.js';
import HelpTip from '../components/HelpTip.jsx';
import TabIntro from '../components/TabIntro.jsx';
import PermissionIcons from '../components/PermissionIcons.jsx';
import StorageRootCard from '../components/StorageRootCard.jsx';
import FolderPermissionsTab from '../components/FolderPermissionsTab.jsx';
import ColourField, { normaliseHex } from '../components/ColourField.jsx';
import TagField from '../components/TagField.jsx';
import ExpandableActions from '../components/ExpandableActions.jsx';
import { Modal } from '../components/Modal.jsx';
import { useDialogs } from '../components/DialogProvider.jsx';

/**
 * Administration: users, groups and roles.
 *
 * Every route behind this is super-admin gated on the server. This page checks
 * the same flag only to decide what to render — a non-admin who reaches the URL
 * gets 403s from the API regardless of what is drawn.
 */

export default function Admin() {
  const { user } = useAuth();
  // Read from the URL so a tile can open one screen directly, and so any of the
  // twelve can be linked to at all — until now the eleventh was reachable only
  // by opening the first and clicking ten times.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab = TABS.some((entry) => entry.key === requested) ? requested : 'users';
  const setTab = (key) => setSearchParams(key === 'users' ? {} : { tab: key });

  // Nine screens behind one route, so the help button follows the tab rather
  // than describing all nine at once. Declared before the guard below, because a
  // hook that runs only for some users runs in a different order for the rest.
  useHelpTopic(`admin.${tab}`);

  if (!user.isSuperAdmin) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="هذه الصفحة لمديري النظام فقط"
        hint="راجع مدير النظام إذا كنت تحتاج صلاحية إدارية."
      />
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-text">إدارة النظام</h2>

      <div className="flex flex-row gap-1 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === item.key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            <item.icon size={15} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'users' ? <UsersTab /> : null}
      {tab === 'groups' ? <GroupsTab /> : null}
      {tab === 'roles' ? <RolesTab /> : null}
      {tab === 'permissions' ? <FolderPermissionsTab /> : null}
      {tab === 'metadata' ? <MetadataTab /> : null}
      {tab === 'settings' ? <SettingsTab /> : null}
      {tab === 'approvals' ? <ApprovalTemplatesTab /> : null}
      {tab === 'keys' ? <ApiKeysTab /> : null}
      {tab === 'webhooks' ? <WebhooksTab /> : null}
      {tab === 'reports' ? <ReportsTab /> : null}
      {tab === 'audit' ? <AuditTab /> : null}
      {tab === 'diagnostics' ? <DiagnosticsTab /> : null}
      {tab === 'classification' ? <ClassificationTab /> : null}
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────

/**
 * Create and edit in one dialog.
 *
 * Creating needs a username (which never changes) plus the two editable fields.
 * Editing shows the username read-only, so there is no confusion about what the
 * save button does, and only touches displayName and email.
 */
function UserDialog({ open, draft, onChange, onSubmit, onClose, busy }) {
  const editing = Boolean(draft?.userId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'تعديل المستخدم' : 'مستخدم جديد'}
      subtitle={
        editing
          ? 'اسم المستخدم لا يتغيّر — يمكن تعديل الاسم الظاهر والبريد فقط.'
          : 'ستُولَّد كلمة مرور مؤقتة تُعرض مرة واحدة.'
      }
      icon={Users}
      size="md"
      footer={
        <>
          <Button
            icon={editing ? Save : Plus}
            onClick={onSubmit}
            disabled={
              busy
              || (!editing && !draft?.username.trim())
              || !draft?.displayName.trim()
            }
          >
            {editing ? 'حفظ' : 'إنشاء'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      {draft ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {editing ? (
            /* Username is the login; it is immutable after creation, so we show
               it as a muted label rather than an input to make clear that the
               save button will not touch it. */
            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-text-muted">اسم المستخدم</span>
              <span className="block text-sm text-text-muted" dir="ltr">{draft.username}</span>
            </div>
          ) : (
            <TextField
              label="اسم المستخدم"
              dir="ltr"
              hint="يُستعمل لتسجيل الدخول ولا يمكن تغييره لاحقاً."
              value={draft.username}
              onChange={(event) => onChange({ ...draft, username: event.target.value })}
            />
          )}
          <TextField
            label="الاسم الظاهر"
            hint="كما يظهر في القوائم والسجلات."
            value={draft.displayName}
            onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
          />
          <TextField
            label="البريد الإلكتروني (اختياري)"
            dir="ltr"
            type="email"
            hint="يُرسل إليه رابط استعادة كلمة المرور."
            value={draft.email}
            onChange={(event) => onChange({ ...draft, email: event.target.value })}
          />
        </div>
      ) : null}
    </Modal>
  );
}

const EMPTY_USER = { userId: null, username: '', displayName: '', email: '' };

function UsersTab() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // A generated password gets its own state rather than being pasted into a
  // sentence: it is shown once, never retrievable, and needs a copy button.
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false);
  // Search query, debounced before it hits the server.
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(true);
  // One draft drives both create and edit; a userId on it means edit.
  const [draft, setDraft] = useState(null);
  const { confirm } = useDialogs();

  // `fetch` is the one place that touches the API. It takes explicit parameters
  // so the checkbox fires immediately while the search box debounces — two
  // different interaction speeds, one underlying call.
  const fetchUsers = useCallback(async (query, inactive) => {
    try {
      setUsers(await api.admin.users(query, { includeInactive: inactive }));
    } catch {
      setError('تعذر تحميل المستخدمين.');
    }
  }, []);

  // Reload after any mutation — reads current state values.
  const load = useCallback(() => fetchUsers(q, includeInactive), [fetchUsers, q, includeInactive]);

  // Initial load.
  useEffect(() => { fetchUsers('', true); }, [fetchUsers]);

  // The search box is debounced 250ms; the checkbox fires immediately via its
  // onChange below — only one effect per control, one fetch per interaction.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) fetchUsers(q, includeInactive);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function act(fn, onDone) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      await load();
      onDone?.(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitUser() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setSecret(null);
    try {
      if (draft.userId) {
        // Edit path: only displayName and email travel.
        await api.admin.updateUser(draft.userId, {
          displayName: draft.displayName.trim(),
          email: draft.email.trim() || null,
        });
        setDraft(null);
        await load();
        setNotice('حُفظت بيانات المستخدم.');
      } else {
        // Create path: server generates the one-time password.
        const result = await api.admin.createUser({
          username: draft.username.trim(),
          displayName: draft.displayName.trim(),
          email: draft.email.trim() || null,
        });
        setDraft(null);
        await load();
        setSecret({
          title: `أُنشئ المستخدم ${result.username}`,
          value: result.password,
        });
      }
    } catch (caught) {
      // The dialog stays open, holding what was typed.
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /** The actions offered on one row, in the order they escalate. */
  function rowActions(item) {
    return [
      {
        key: 'reset',
        icon: RotateCcw,
        title: 'إعادة تعيين كلمة المرور',
        bgClass: 'bg-primary/10',
        textClass: 'text-primary',
        hoverClass: 'hover:bg-primary/20',
        onClick: async () => {
          const confirmed = await confirm({
            title: 'إعادة تعيين كلمة المرور',
            message: `ستُولَّد كلمة مرور جديدة للحساب ${item.username}.`,
            detail: 'تنتهي جلساته المفتوحة فوراً، ويُطلب منه تغيير الكلمة عند أول دخول.',
            confirmLabel: 'إعادة التعيين',
            variant: 'warning',
          });
          if (!confirmed) return;
          await act(
            () => api.admin.resetPassword(item.userId),
            (result) =>
              setSecret({ title: `كلمة مرور مؤقتة لـ ${item.username}`, value: result.password }),
          );
        },
      },
      ...(item.isLocked
        ? [{
          key: 'unlock',
          icon: Unlock,
          title: 'فك القفل',
          bgClass: 'bg-emerald-500/10',
          textClass: 'text-emerald-600',
          hoverClass: 'hover:bg-emerald-500/20',
          onClick: () => act(() => api.admin.unlock(item.userId)),
        }]
        : []),
      {
        key: 'super',
        icon: ShieldCheck,
        title: item.isSuperAdmin ? 'إلغاء صفة المدير' : 'جعله مديراً',
        bgClass: item.isSuperAdmin ? 'bg-amber-500/10' : 'bg-indigo-500/10',
        textClass: item.isSuperAdmin ? 'text-amber-600' : 'text-indigo-600',
        hoverClass: item.isSuperAdmin ? 'hover:bg-amber-500/20' : 'hover:bg-indigo-500/20',
        onClick: async () => {
          const granting = !item.isSuperAdmin;
          const confirmed = await confirm({
            title: granting ? 'منح صفة مدير النظام' : 'إلغاء صفة مدير النظام',
            message: granting
              ? `سيصبح ${item.displayName} مديراً للنظام.`
              : `لن يعود ${item.displayName} مديراً للنظام.`,
            detail: granting
              ? 'مدير النظام يتجاوز كل قيود المجلدات ويرى كل الوثائق ويدير الحسابات.'
              : 'يعود وصوله محكوماً بصلاحيات المجلدات وحدها.',
            confirmLabel: granting ? 'منح الصفة' : 'إلغاء الصفة',
            variant: 'warning',
          });
          if (confirmed) await act(() => api.admin.setSuperAdmin(item.userId, granting));
        },
      },
    ];
  }

  if (!users) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.users" />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {secret ? (
        <Alert tone="success">
          <div className="space-y-1.5">
            <p className="text-xs">{secret.title}. كلمة المرور تُعرض مرة واحدة — انسخها الآن:</p>
            <CopyField value={secret.value} label="نسخ كلمة المرور" />
            <button
              type="button"
              onClick={() => setSecret(null)}
              className="text-[11px] text-text-muted underline hover:text-text"
            >
              إخفاء
            </button>
          </div>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={Plus} onClick={() => setDraft(EMPTY_USER)} disabled={busy}>
          مستخدم جديد
        </Button>
        {/* Search beside the create button, debounced, so the list narrows as
            you type without a round-trip per keystroke. */}
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute start-2 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="بحث…"
            className="rounded-lg border border-border bg-control py-2 ps-7 pe-3 text-sm"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-text">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => {
              const next = event.target.checked;
              setIncludeInactive(next);
              // Fire immediately rather than waiting for a state-driven effect,
              // so the list refreshes in the same tick as the checkbox change.
              fetchUsers(q, next);
            }}
          />
          إظهار الحسابات المعطّلة
        </label>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <th className="px-4 py-3 text-right font-semibold">الاسم</th>
                <th className="px-4 py-3 text-right font-semibold">اسم المستخدم</th>
                <th className="px-4 py-3 text-right font-semibold">البريد الإلكتروني</th>
                <th className="px-4 py-3 text-center font-semibold">الحالة</th>
                <th className="px-4 py-3 text-left font-semibold">آخر دخول</th>
                <th className="w-32 px-4 py-3 text-center font-semibold">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {users.map((item) => (
                <tr key={item.userId} className="hover:bg-surface-muted/30">
                  <td className="px-4 py-3 text-right font-medium text-text">
                    {item.displayName}
                    {item.isSuperAdmin ? (
                      <span className="ms-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                        مدير النظام
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right" dir="ltr">
                    {item.username}
                  </td>
                  <td className="px-4 py-3 text-text-muted" dir="ltr">
                    {item.email ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {!item.isActive ? (
                      <span className="text-xs text-text-muted">معطّل</span>
                    ) : item.isLocked ? (
                      <span className="text-xs text-amber-600">مقفل</span>
                    ) : item.mustChangePassword ? (
                      <span className="text-xs text-blue-600">بانتظار تغيير كلمة المرور</span>
                    ) : (
                      <span className="text-xs text-green-600">نشط</span>
                    )}
                  </td>
                  <td className="num px-4 py-3 text-left text-text-muted">
                    {item.lastLoginAt ? formatDate(item.lastLoginAt) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center">
                      {/*
                        An account is never deleted, only deactivated — the audit
                        trail has to keep naming who did what — so deactivation
                        takes the destructive slot that delete would occupy.
                      */}
                      <ExpandableActions
                        onEdit={() =>
                          setDraft({
                            userId: item.userId,
                            username: item.username,
                            displayName: item.displayName,
                            email: item.email ?? '',
                          })
                        }
                        customActions={rowActions(item)}
                        onToggleActive={async () => {
                          const deactivating = item.isActive;
                          const confirmed = await confirm({
                            title: deactivating ? 'تعطيل الحساب' : 'تفعيل الحساب',
                            message: deactivating
                              ? `لن يستطيع ${item.displayName} تسجيل الدخول.`
                              : `سيستعيد ${item.displayName} القدرة على تسجيل الدخول.`,
                            detail: deactivating
                              ? 'الحساب لا يُحذف: اسمه يبقى في السجلات وصلاحياته محفوظة إن أُعيد تفعيله.'
                              : undefined,
                            confirmLabel: deactivating ? 'تعطيل' : 'تفعيل',
                            variant: deactivating ? 'danger' : 'info',
                          });
                          if (confirmed) await act(() => api.admin.setActive(item.userId, !item.isActive));
                        }}
                        isActive={item.isActive}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <UserDialog
        open={Boolean(draft)}
        draft={draft}
        busy={busy}
        onChange={setDraft}
        onSubmit={submitUser}
        onClose={() => setDraft(null)}
      />
    </div>
  );
}


// ── Groups ───────────────────────────────────────────────────────────────

/**
 * Groups and their members.
 *
 * ─── Why the whole roster is on screen ──────────────────────────────────────
 *
 * Adding a member used to require typing into a search box: nothing was listed
 * until you had guessed part of a name, so building a group meant knowing in
 * advance exactly who belonged in it and spelling each one correctly. On a
 * directory of any size that is a lookup tool, not a picker.
 *
 * Now everyone is listed, already-added people are filtered out, several can be
 * ticked at once, and the search narrows the same list rather than being the
 * only way to see it.
 */
function GroupsTab() {
  const [groups, setGroups] = useState(null);
  const [selected, setSelected] = useState(null);
  const [members, setMembers] = useState([]);
  const [principals, setPrincipals] = useState([]);
  // Server-side matches for the current query, used instead of the local filter.
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  // Members ticked for removal. Separate from `picked`, which is the add side:
  // one selection driving two opposite actions is how the wrong people get removed.
  const [pickedMembers, setPickedMembers] = useState(() => new Set());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // One draft for edit dialog; null when closed.
  const [editingGroup, setEditingGroup] = useState(null);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();

  const load = useCallback(async () => {
    try {
      // The roster is fetched once with the groups rather than per keystroke:
      // the picker filters it locally, so typing costs nothing.
      const [groupList, principalList] = await Promise.all([
        api.admin.groups(),
        api.admin.principals(''),
      ]);
      setGroups(groupList.groups);
      setPrincipals(principalList.principals);
    } catch {
      setError('تعذر تحميل المجموعات.');
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openGroup = useCallback(async (group) => {
    setSelected(group);
    setError(null);
    setPicked(new Set());
    setPickedMembers(new Set());
    setQuery('');
    setFound(null);
    try {
      setMembers((await api.admin.groupMembers(group.groupId)).members);
    } catch {
      setError('تعذر تحميل الأعضاء.');
      setMembers([]);
    }
  }, []);

  async function createGroup(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.admin.createGroup({ name: name.trim(), description: description.trim() || undefined });
      setName('');
      setDescription('');
      setCreating(false);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup() {
    if (!editingGroup) return;
    setBusy(true);
    setError(null);
    try {
      await api.admin.updateGroup(editingGroup.groupId, {
        name: editingGroup.name.trim(),
        description: editingGroup.description.trim() || null,
      });
      const prevId = editingGroup.groupId;
      setEditingGroup(null);
      // Re-load both groups and principals so a renamed group shows its new
      // name in the member picker without a full page reload.
      const [groupList, principalList] = await Promise.all([api.admin.groups(), api.admin.principals('')]);
      const fresh = groupList.groups;
      setGroups(fresh);
      setPrincipals(principalList.principals);
      const reSelected = fresh.find((g) => String(g.groupId) === String(prevId));
      if (reSelected) await openGroup(reSelected);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /*
   * Asks the server whenever the box has text, after a pause.
   *
   * Debounced because this fires per keystroke otherwise, and the answer for
   * "ah" is thrown away by the time "ahm" is typed.
   */
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setFound(null);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.admin.principals(needle);
        if (!cancelled) setFound(result.principals);
      } catch {
        // Falls back to filtering the loaded roster, which is still useful.
        if (!cancelled) setFound(null);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  async function addPicked() {
    setBusy(true);
    setError(null);
    try {
      // Sequentially, so a single rejection — a cycle, say — names itself
      // instead of vanishing into a batch that half worked.
      for (const principalId of picked) {
        await api.admin.addMember(selected.groupId, principalId);
      }
      setPicked(new Set());
      await openGroup(selected);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
      await openGroup(selected);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Removes the ticked members, after one confirmation for the whole batch.
   *
   * Named individually when it is one person and counted when it is several —
   * "سيُزال ٧ أعضاء" is checkable at a glance, whereas seven consecutive dialogs
   * are answered by reflex, which is the opposite of what a confirmation is for.
   */
  async function removePicked() {
    const going = members.filter((member) => pickedMembers.has(String(member.principalId)));
    if (going.length === 0) return;

    const confirmed = await confirm({
      title: 'إزالة من المجموعة',
      message:
        going.length === 1
          ? `سيُزال ${going[0].displayName} من مجموعة "${selected.name}".`
          : `سيُزال ${going.length} أعضاء من مجموعة "${selected.name}".`,
      detail: 'يفقدون فوراً كل صلاحية كانوا يستمدونها من هذه المجموعة، وتبقى صلاحياتهم الأخرى كما هي.',
      confirmLabel: 'إزالة',
      variant: 'danger',
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      // Sequentially, so a refusal names itself rather than disappearing into a
      // batch that half succeeded.
      for (const member of going) {
        await api.admin.removeMember(selected.groupId, member.principalId);
      }
      await openGroup(selected);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
      // Re-read either way: some removals may have landed before the failure.
      await openGroup(selected);
    } finally {
      setBusy(false);
    }
  }

  if (!groups) return <Spinner />;

  const memberIds = new Set(members.map((member) => String(member.principalId)));
  const needle = query.trim().toLowerCase();

  /*
   * The roster the picker offers.
   *
   * `listPrincipals` returns at most 100 rows, so the list loaded up front is
   * the first hundred names and nothing more. Filtering only that locally would
   * make everyone past it unreachable — and silently, since the list would look
   * complete. So a query goes to the server, which searches the whole directory,
   * and its answer replaces the local filter while the box has text in it.
   */
  const pool = needle && found ? found : principals;

  const addable = pool.filter((principal) => {
    if (memberIds.has(String(principal.principalId))) return false;
    // A group cannot contain itself; the server refuses it, and offering it here
    // would only produce an error the user could not have predicted.
    if (selected && String(principal.principalId) === String(selected.groupId)) return false;
    if (!needle || found) return true;
    return `${principal.displayName} ${principal.username ?? ''}`.toLowerCase().includes(needle);
  });

  const capped = !needle && principals.length >= 100;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.groups" />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-row gap-2">
        <Button icon={Plus} onClick={() => setCreating(true)} disabled={busy}>
          مجموعة جديدة
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="overflow-hidden">
          <div className="border-b border-border bg-surface-muted px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            المجموعات
          </div>
          <ul className="divide-y divide-border/50">
            {groups.map((group) => (
              <li key={group.groupId}>
                <button
                  onClick={() => openGroup(group)}
                  className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-right text-sm transition-colors ${
                    selected?.groupId === group.groupId
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'hover:bg-surface-muted/40'
                  }`}
                >
                  {/* Inactive groups are muted with line-through and a badge so
                      they stay visible (the admin may need to reactivate them)
                      but clearly distinct from active ones. */}
                  <span className={`flex flex-wrap items-center gap-1.5 truncate ${group.isActive === false ? 'text-text-muted line-through' : ''}`}>
                    {group.name}
                    {group.isActive === false ? (
                      <span className="rounded bg-text-muted/10 px-1 py-0.5 text-[10px] no-underline" style={{ textDecoration: 'none' }}>
                        معطّلة
                      </span>
                    ) : null}
                  </span>
                  <span className="num shrink-0 text-xs text-text-muted">
                    {group.memberCount} عضو
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {groups.length === 0 ? (
            <EmptyState icon={UsersRound} title="لا توجد مجموعات بعد" />
          ) : null}
        </Card>

        {selected ? (
          <>
            <Card className="flex flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-4 py-2">
                <span className="flex items-center gap-2">
                  {/* Select-all, so emptying a group is not a row-by-row chore.
                      Indeterminate when the selection is partial, which is the
                      only way a tri-state checkbox reads honestly. */}
                  {members.length > 0 ? (
                    <input
                      type="checkbox"
                      aria-label="تحديد كل الأعضاء"
                      checked={pickedMembers.size === members.length}
                      ref={(node) => {
                        if (node) {
                          node.indeterminate =
                            pickedMembers.size > 0 && pickedMembers.size < members.length;
                        }
                      }}
                      onChange={() =>
                        setPickedMembers(
                          pickedMembers.size === members.length
                            ? new Set()
                            : new Set(members.map((member) => String(member.principalId))),
                        )
                      }
                    />
                  ) : null}
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                      أعضاء {selected.name}
                    </span>
                    {/* Description shown here so the admin sees what the group is
                        for without having to open an edit dialog. */}
                    {selected.description ? (
                      <span className="block text-[11px] text-text-muted">{selected.description}</span>
                    ) : null}
                  </div>
                </span>
                <div className="flex items-center gap-2">
                  <span className="num text-xs text-text-muted">{members.length}</span>
                  {/* Edit name/description and toggle active, both reachable from
                      the same card header instead of buried in a separate screen. */}
                  <ExpandableActions
                    onEdit={() =>
                      setEditingGroup({
                        groupId: selected.groupId,
                        name: selected.name,
                        description: selected.description ?? '',
                      })
                    }
                    onToggleActive={async () => {
                      const deactivating = selected.isActive !== false;
                      const confirmed = await confirm(
                        deactivating
                          ? {
                            title: 'تعطيل المجموعة',
                            message: `تعطيل مجموعة "${selected.name}".`,
                            detail: 'لن تنقل أي صلاحية لأعضائها ما دامت معطّلة. عضويتها وصلاحياتها تبقى محفوظة وتعود بإعادة تفعيلها.',
                            confirmLabel: 'تعطيل',
                            variant: 'danger',
                          }
                          : {
                            title: 'تفعيل المجموعة',
                            message: `تفعيل مجموعة "${selected.name}".`,
                            confirmLabel: 'تفعيل',
                            variant: 'info',
                          },
                      );
                      if (!confirmed) return;
                      setBusy(true);
                      setError(null);
                      try {
                        const nowActive = selected.isActive === false;
                        await api.admin.setGroupActive(selected.groupId, nowActive);
                        // Re-load groups and re-select from the fresh list so the
                        // selected object reflects the new isActive value.
                        const [groupList] = await Promise.all([
                          api.admin.groups(),
                          api.admin.principals(''),
                        ]);
                        const fresh = groupList.groups;
                        setGroups(fresh);
                        const reSelected = fresh.find(
                          (g) => String(g.groupId) === String(selected.groupId),
                        );
                        if (reSelected) await openGroup(reSelected);
                      } catch (caught) {
                        setError(errorMessage(caught));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    isActive={selected.isActive !== false}
                  />
                </div>
              </div>

              {members.length === 0 ? (
                <EmptyState icon={UsersRound} title="لا أعضاء" hint="اختر من القائمة المجاورة." />
              ) : (
                /* Ticked and removed in a batch, mirroring the add panel beside
                   it — the two halves of the same job should not be two
                   different interactions. */
                <ul className="divide-y divide-border/50">
                  {members.map((member) => {
                    const id = String(member.principalId);
                    const checked = pickedMembers.has(id);

                    return (
                      <li key={id}>
                        <label
                          className={`flex cursor-pointer items-center gap-2 px-4 py-2 transition-colors ${
                            checked ? 'bg-red-50' : 'hover:bg-surface-muted/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const next = new Set(pickedMembers);
                              if (checked) next.delete(id);
                              else next.add(id);
                              setPickedMembers(next);
                            }}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-text">
                              {member.displayName}
                            </span>
                            <span className="block text-[11px] text-text-muted">
                              {member.type === 'group' ? 'مجموعة' : 'مستخدم'}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-auto border-t border-border p-3">
                <Button
                  variant="danger"
                  icon={UserMinus}
                  onClick={removePicked}
                  disabled={busy || pickedMembers.size === 0}
                  className="w-full justify-center"
                >
                  {pickedMembers.size > 0 ? `إزالة ${pickedMembers.size}` : 'إزالة المحدَّدين'}
                </Button>
              </div>
            </Card>

            <Card className="flex flex-col overflow-hidden">
              <div className="border-b border-border bg-surface-muted px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                إضافة أعضاء
              </div>

              <div className="border-b border-border p-3">
                <TextField
                  label="بحث"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="ابحث بالاسم أو باسم المستخدم"
                  hint={capped ? 'تُعرض أول ١٠٠ اسم — استخدم البحث للوصول إلى البقية.' : undefined}
                />
              </div>

              {addable.length === 0 ? (
                <EmptyState
                  icon={UsersRound}
                  title={needle ? 'لا نتائج مطابقة' : 'الجميع أعضاء بالفعل'}
                />
              ) : (
                <ul className="max-h-72 divide-y divide-border/50 overflow-y-auto">
                  {addable.map((principal) => {
                    const id = String(principal.principalId);
                    const checked = picked.has(id);

                    return (
                      <li key={id}>
                        <label
                          className={`flex cursor-pointer items-center gap-2 px-4 py-2 transition-colors ${
                            checked ? 'bg-primary/5' : 'hover:bg-surface-muted/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const next = new Set(picked);
                              if (checked) next.delete(id);
                              else next.add(id);
                              setPicked(next);
                            }}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-text">
                              {principal.displayName}
                            </span>
                            <span className="block text-[11px] text-text-muted" dir="auto">
                              {principal.type === 'group' ? 'مجموعة' : principal.username}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-auto border-t border-border p-3">
                <Button
                  icon={UserPlus}
                  onClick={addPicked}
                  disabled={busy || picked.size === 0}
                  className="w-full justify-center"
                >
                  {picked.size > 0 ? `إضافة ${picked.size}` : 'إضافة المحدَّدين'}
                </Button>
              </div>
            </Card>
          </>
        ) : (
          <Card className="lg:col-span-2">
            <EmptyState
              icon={UsersRound}
              title="اختر مجموعة"
              hint="اختر مجموعة من القائمة لعرض أعضائها وإضافة غيرهم."
            />
          </Card>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="مجموعة جديدة"
        subtitle="سمِّها باسم الوظيفة لا بأسماء الأشخاص، فالعضوية تتغيّر والوظيفة تبقى."
        icon={UsersRound}
        size="md"
        footer={
          <>
            <Button icon={Plus} onClick={createGroup} disabled={busy || !name.trim()}>
              إنشاء
            </Button>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={busy}>
              إلغاء
            </Button>
          </>
        }
      >
        <form onSubmit={createGroup} className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="اسم المجموعة"
            placeholder="مثال: قسم المحاسبة"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            label="الوصف (اختياري)"
            hint="لماذا وُجدت هذه المجموعة — يقرؤه من يراجع الصلاحيات لاحقاً."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </form>
      </Modal>

      {/* Edit-group dialog: name and description, same shape as create. */}
      <Modal
        open={Boolean(editingGroup)}
        onClose={() => setEditingGroup(null)}
        title="تعديل المجموعة"
        subtitle="يُعدَّل الاسم في سجلات المجلدات وجدول المبادئ معاً."
        icon={UsersRound}
        size="md"
        footer={
          <>
            <Button
              icon={Save}
              onClick={saveGroup}
              disabled={busy || !editingGroup?.name.trim()}
            >
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setEditingGroup(null)} disabled={busy}>
              إلغاء
            </Button>
          </>
        }
      >
        {editingGroup ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="اسم المجموعة"
              value={editingGroup.name}
              onChange={(event) => setEditingGroup({ ...editingGroup, name: event.target.value })}
            />
            <TextField
              label="الوصف (اختياري)"
              hint="لماذا وُجدت هذه المجموعة — يقرؤه من يراجع الصلاحيات لاحقاً."
              value={editingGroup.description}
              onChange={(event) =>
                setEditingGroup({ ...editingGroup, description: event.target.value })
              }
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}


// ── Roles ────────────────────────────────────────────────────────────────

/** The permission checkboxes, each with the explanation of what the bit grants. */
function PermissionPicker({ bits, onChange, disabled }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {PERMISSION_BITS.map((verb) => (
        <span key={verb.bit} className="flex items-center gap-1">
          <label className="flex items-center gap-1.5 text-sm text-text">
            <input
              type="checkbox"
              checked={(bits & verb.bit) !== 0}
              disabled={disabled}
              onChange={() => onChange(bits ^ verb.bit)}
            />
            {verb.label}
          </label>
          {/* Six words with six very different consequences — "إدارة الصلاحيات"
              in particular lets its holder grant themselves the rest, and a
              checkbox label cannot say that. */}
          <HelpTip text={verb.help} label={`شرح صلاحية: ${verb.label}`} />
        </span>
      ))}
    </div>
  );
}

const EMPTY_ROLE = { roleId: null, name: '', description: '', bits: 3 };

/**
 * Create and edit in one dialog.
 *
 * Both forms ask for exactly the same three things, so they are the same form.
 * Two near-identical blocks would drift the moment one gained a field — and
 * dropping `description` from the create form while keeping it on edit is the
 * shape that bug already took here once.
 */
function RoleDialog({ open, draft, onChange, onSubmit, onClose, busy }) {
  const editing = Boolean(draft?.roleId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'تعديل الدور' : 'دور جديد'}
      subtitle={
        editing
          ? 'الصلاحيات الممنوحة من قبل لا تتغيّر بهذا التعديل.'
          : 'حزمة صلاحيات تُمنح على المجلدات دفعة واحدة.'
      }
      icon={KeyRound}
      size="md"
      footer={
        <>
          <Button
            icon={Save}
            onClick={onSubmit}
            disabled={busy || !draft?.name.trim() || draft?.bits === 0}
          >
            {editing ? 'حفظ' : 'إنشاء'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      {draft ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="الاسم"
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
            <TextField
              label="الوصف (اختياري)"
              hint="متى يُستعمل هذا الدور — يقرؤه من يمنحه لاحقاً."
              value={draft.description}
              onChange={(event) => onChange({ ...draft, description: event.target.value })}
            />
          </div>

          <div>
            <span className="mb-2 block text-sm font-medium text-text">الصلاحيات</span>
            <PermissionPicker bits={draft.bits} onChange={(bits) => onChange({ ...draft, bits })} />
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function RolesTab() {
  const [roles, setRoles] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // One draft drives both create and edit; a roleId on it means edit.
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();

  const load = useCallback(async () => {
    try {
      setRoles((await api.admin.roles()).roles);
    } catch {
      setError('تعذر تحميل الأدوار.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        name: draft.name.trim(),
        // Sent, not silently dropped: the column exists, the server stores it,
        // and it is the only thing telling a later administrator what the role
        // was for.
        description: draft.description.trim() || null,
        permissionBits: draft.bits,
      };

      if (draft.roleId) {
        await api.admin.updateRole(draft.roleId, body);
        setNotice('حُفظ الدور. الصلاحيات الممنوحة سابقاً لم تتغيّر.');
      } else {
        await api.admin.createRole(body);
        setNotice('أُنشئ الدور.');
      }

      setDraft(null);
      await load();
    } catch (caught) {
      // The dialog stays open on failure, holding what was typed.
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(role) {
    const display = roleDisplay(role);
    const confirmed = await confirm({
      title: 'حذف الدور',
      message: `سيُحذف الدور "${display.name}".`,
      detail: 'الصلاحيات الممنوحة به تبقى عاملة كما هي — يسقط عنها اسم الدور فقط.',
      confirmLabel: 'حذف',
      variant: 'danger',
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.admin.deleteRole(role.roleId);
      await load();
    } catch (caught) {
      // Previously unhandled: a refused delete left the row on screen with no
      // explanation, which reads as the button being broken.
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!roles) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.roles" />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Alert tone="info">
        الدور قالب: تُنسخ صلاحياته لحظة المنح، فتعديله لاحقاً لا يغيّر أي صلاحية مُنحت من قبل.
      </Alert>

      <div className="flex flex-row gap-2">
        <Button icon={Plus} onClick={() => setDraft(EMPTY_ROLE)} disabled={busy}>
          دور جديد
        </Button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3 text-right font-semibold">الاسم</th>
              <th className="px-4 py-3 text-right font-semibold">الصلاحيات</th>
              <th className="w-32 px-4 py-3 text-center font-semibold">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {roles.map((role) => {
              const display = roleDisplay(role);

              return (
                <tr key={role.roleId} className="hover:bg-surface-muted/30">
                  <td className="px-4 py-3 text-right">
                    {/*
                      Spaced by flex `gap`, not by a margin on each chip.

                      `ms-2` is `margin-inline-start`, and inline-start is
                      resolved against the element's OWN direction — so putting
                      it on the `dir="ltr"` identifier below moved the gap to
                      that chip's left, away from the badge, and the two ran
                      together. `gap` sits between items whatever direction each
                      one declares, which is the only version of this that
                      cannot be got wrong.
                    */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">{display.name}</span>
                      {role.isSystem ? (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted">
                          نظامي
                        </span>
                      ) : null}
                      {/* The stored English name, kept discoverable for anyone
                          matching this screen against the API or the docs. */}
                      {display.identifier ? (
                        <span dir="ltr" className="text-[11px] text-text-muted/70">
                          {display.identifier}
                        </span>
                      ) : null}
                    </div>
                    {display.description ? (
                      <span className="mt-0.5 block text-[11px] text-text-muted">
                        {display.description}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PermissionIcons bits={role.permissionBits} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center">
                      {role.isSystem ? (
                        // Refused by the server too; saying so here stops the
                        // attempt rather than explaining the failure after it.
                        <span
                          title="الأدوار النظامية لا تُعدَّل ولا تُحذف"
                          className="text-xs text-text-muted"
                        >
                          غير قابل للتعديل
                        </span>
                      ) : (
                        <ExpandableActions
                          onEdit={() =>
                            setDraft({
                              roleId: role.roleId,
                              name: role.name,
                              description: role.description ?? '',
                              bits: role.permissionBits,
                            })
                          }
                          onDelete={() => remove(role)}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {roles.length === 0 ? <EmptyState icon={KeyRound} title="لا توجد أدوار بعد" /> : null}
      </Card>

      <RoleDialog
        open={Boolean(draft)}
        draft={draft}
        busy={busy}
        onChange={setDraft}
        onSubmit={submit}
        onClose={() => setDraft(null)}
      />
    </div>
  );
}


// ── Settings ─────────────────────────────────────────────────────────────

/** Labels for the setting keys, so the panel is not a list of dotted paths. */
const SETTING_LABELS = {
  'organisation.name': 'اسم الجهة',
  'upload.max_bytes': 'أقصى حجم للرفع (ميغابايت)',
  'upload.allowed_extensions': 'الامتدادات المسموحة (فارغ = الكل)',
  'upload.duplicate_policy': 'سياسة الملفات المكررة',
  'storage.purge_grace_days': 'مهلة الاسترجاع قبل الحذف النهائي (أيام)',
  'auth.session_ttl_hours': 'مدة الجلسة (ساعات)',
  'auth.max_failed_logins': 'محاولات الدخول الفاشلة قبل القفل',
  'auth.lockout_minutes': 'مدة القفل (دقائق)',
  'auth.min_password_length': 'أقل طول لكلمة المرور',
  'auth.password_block_predictable': 'رفض كلمات المرور المتوقعة',
  'auth.password_block_username': 'رفض احتواء اسم المستخدم',
  'auth.password_require_lowercase': 'إلزام حرف لاتيني صغير (a-z)',
  'auth.password_require_uppercase': 'إلزام حرف لاتيني كبير (A-Z)',
  'auth.password_require_digit': 'إلزام رقم',
  'auth.password_require_symbol': 'إلزام رمز (! @ # %)',
  'ocr.enabled': 'المسح الضوئي للنصوص (OCR)',
  'extraction.enabled': 'استخراج نص الوثائق',
  'classification.enabled': 'التعرّف التلقائي على الوثائق (تجريبي)',
};

/*
 * The panel is sections, not a heap.
 *
 * Thirteen unrelated rows in one table make every question a scan of all of
 * them, and the rows that answer one question — the three password rules, say —
 * sit apart as if they had nothing to do with each other. Grouped, the password
 * policy reads as the single decision it is.
 *
 * Membership is asserted by a test against the server's own list, so a setting
 * added there without a home here fails the build instead of quietly rendering
 * at the bottom of nowhere.
 */
const SETTING_SECTIONS = [
  {
    title: 'كلمة المرور',
    hint: 'القواعد التي تُقاس عليها كل كلمة مرور جديدة. لا تُبطل كلمات المرور القائمة.',
    keys: [
      'auth.min_password_length',
      'auth.password_block_predictable',
      'auth.password_block_username',
      'auth.password_require_lowercase',
      'auth.password_require_uppercase',
      'auth.password_require_digit',
      'auth.password_require_symbol',
    ],
  },
  {
    title: 'الجلسات والدخول',
    hint: 'مدة بقاء الجلسة، ومتى يُقفل الحساب بعد محاولات فاشلة.',
    keys: ['auth.session_ttl_hours', 'auth.max_failed_logins', 'auth.lockout_minutes'],
  },
  {
    title: 'الرفع',
    hint: 'ما يُقبل من الملفات: حجمها وامتداداتها وما يحدث عند التكرار.',
    keys: ['upload.max_bytes', 'upload.allowed_extensions', 'upload.duplicate_policy'],
  },
  {
    title: 'التخزين',
    hint: 'كم تبقى الوثيقة المحذوفة قابلة للاسترجاع قبل محو محتواها.',
    keys: ['storage.purge_grace_days'],
  },
  {
    title: 'المعالجة',
    hint: 'الاستخراج والتعرّف الضوئي اللذان يجعلان محتوى الوثائق قابلاً للبحث.',
    keys: ['ocr.enabled', 'extraction.enabled', 'classification.enabled'],
  },
  {
    title: 'عام',
    hint: 'اسم الجهة كما يظهر على شاشة الدخول وفي أعلى النظام.',
    keys: ['organisation.name'],
  },
];

/** Option values are stored in English; these are what an operator reads. */
const OPTION_LABELS = {
  allow: 'السماح',
  warn: 'تنبيه',
  block: 'منع',
  ar: 'العربية',
  en: 'الإنجليزية',
};

function SettingsTab() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings((await api.settings.list()).settings);
    } catch {
      setError('تعذر تحميل الإعدادات.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(key, value) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.settings.set(key, value);
      setNotice('تم الحفظ.');
      await load();
    } catch (caught) {
      // The bounds come back with the refusal, so the message can name them
      // instead of leaving the reader to find the limit by trial and error.
      if (caught?.code === 'out_of_range') {
        const { min, max } = caught.body ?? {};
        const range =
          min != null && max != null ? ` المسموح من ${min} إلى ${max}.`
            : min != null ? ` أقل قيمة مسموحة ${min}.`
              : max != null ? ` أكبر قيمة مسموحة ${max}.`
                : '';
        setError(`القيمة خارج النطاق المسموح.${range}`);
      } else if (caught?.code === 'invalid_value') {
        setError('القيمة غير صالحة لهذا الإعداد.');
      } else {
        setError('تعذر حفظ الإعداد.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function revert(key) {
    setBusy(true);
    try {
      await api.settings.clear(key);
      await load();
    } catch {
      setError('تعذرت الاستعادة.');
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.settings" />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Alert tone="info">
        تُطبَّق هذه الإعدادات فوراً دون إعادة تشغيل. ما يبقى في ملف البيئة عمداً هو الاتصال
        بقاعدة البيانات وبيانات البريد: قيمة خاطئة فيهما يجب أن توقف التشغيل لا أن تكسره في
        منتصفه.
      </Alert>

      {/* Its own card rather than a row in the table: pointing the system at a
          directory needs checking, a summary and a follow-up, and none of that
          fits in a text box. */}
      <StorageRootCard />

      {SETTING_SECTIONS.map((section) => {
        const rows = settings.filter((setting) => section.keys.includes(setting.key));
        if (rows.length === 0) return null;

        return (
          <Card key={section.title} className="overflow-hidden">
            <div className="border-b border-border bg-surface-muted/60 px-4 py-2.5">
              <h3 className="text-sm font-semibold text-text">{section.title}</h3>
              <p className="text-[11px] text-text-muted">{section.hint}</p>
            </div>
            <table className="w-full text-sm">
              <thead>
            <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3 text-right font-semibold">الإعداد</th>
              <th className="px-4 py-3 text-right font-semibold">القيمة</th>
              <th className="px-4 py-3 text-center font-semibold">
                <span className="inline-flex items-center gap-1">
                  المصدر
                  <HelpTip
                    label="شرح عمود المصدر"
                    text={'«مخصّص» يعني أن القيمة مضبوطة هنا ومحفوظة في قاعدة البيانات، وهي تتقدّم على ملف البيئة. '
                      + '«افتراضي» يعني أنها آتية من ملف البيئة ولم يغيّرها أحد. '
                      + 'زر الاستعادة يمحو القيمة المخصّصة فيعود الإعداد إلى الافتراضي.'}
                  />
                </span>
              </th>
              <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
            </tr>
          </thead>
              <tbody className="divide-y divide-border/50">
                {rows.map((setting) => (
                  <SettingRow
                    key={setting.key}
                    setting={setting}
                    busy={busy}
                    onSave={save}
                    onRevert={revert}
                  />
                ))}
              </tbody>
            </table>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Offered as one-click chips on the extensions list.
 *
 * These are the formats the pipeline actually does something with: the office
 * types LibreOffice converts, the images sharp handles, the scan formats OCR
 * reads, and PDF. Anything else can still be typed — this is a shortcut, not a
 * whitelist of what the field will accept.
 */
const EXTENSION_SUGGESTIONS = [
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'tiff', 'tif', 'png', 'jpg', 'jpeg', 'txt', 'csv', 'zip',
];

/** Extensions are stored bare and lower case: `.PDF` and `pdf` are one value. */
const normaliseExtension = (item) =>
  String(item).trim().toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9]/g, '');

const BYTES_PER_MB = 1024 * 1024;

/**
 * Settings the server stores in one unit and a person should type in another.
 *
 * `upload.max_bytes` is bytes on the wire because that is what the upload check
 * compares against, but nobody sets an upload limit by counting bytes —
 * `209715200` has to be divided by hand before it means anything, and typing a
 * new one means multiplying by hand and getting it right. The row converts, and
 * shows the stored value underneath so nothing is hidden.
 *
 * @type {Record<string, {suffix: string, toDisplay: Function, toStored: Function, describe: Function}>}
 */
const UNITS = {
  'upload.max_bytes': {
    suffix: 'ميغابايت',
    toDisplay: (stored) => {
      const bytes = Number(stored);
      if (!Number.isFinite(bytes)) return String(stored ?? '');
      const mb = bytes / BYTES_PER_MB;
      // Whole numbers stay whole; an awkward stored value keeps enough precision
      // to survive the round trip rather than being silently rounded on save.
      return Number.isInteger(mb) ? String(mb) : String(Number(mb.toFixed(2)));
    },
    toStored: (typed) => {
      const mb = Number(String(typed).trim());
      // Left alone when it is not a number: the server's own validation should
      // produce the error, not a silent NaN written over a working limit.
      return Number.isFinite(mb) ? String(Math.round(mb * BYTES_PER_MB)) : String(typed);
    },
    describe: (typed) => {
      const mb = Number(String(typed).trim());
      if (!Number.isFinite(mb) || mb <= 0) return null;
      return `= ${Math.round(mb * BYTES_PER_MB).toLocaleString('en-US')} بايت`;
    },
  },
};

function SettingRow({ setting, busy, onSave, onRevert }) {
  const unit = UNITS[setting.key];

  /** The stored value as it would appear in a text box, in the unit shown. */
  const stored = Array.isArray(setting.value) ? setting.value.join(', ') : String(setting.value);
  const serialised = unit ? unit.toDisplay(stored) : stored;

  // A dropdown saves the moment it changes. Only a free-text box has a draft
  // the user might be part-way through typing, and so only it needs a Save
  // button.
  const isChoice = setting.type === 'bool' || Boolean(setting.options);

  const [draft, setDraft] = useState(serialised);

  // Re-seed whenever the stored value changes underneath — after a save, or
  // after a revert to the environment default.
  //
  // Without this the draft held its original value for the life of the row. So
  // choosing "enabled" in a dropdown left `changed` true, which put a Save
  // button on the row still carrying the stale "false"; clicking it wrote that
  // false straight back, and the setting looked like it refused to stay on. The
  // audit trail showed the pair every time: ocr.enabled = true, then two seconds
  // later ocr.enabled = false.
  useEffect(() => {
    setDraft(serialised);
  }, [serialised]);

  const changed = !isChoice && draft !== serialised;

  return (
    <tr className="hover:bg-surface-muted/30">
      <td className="px-4 py-3 text-right">
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium text-text">{SETTING_LABELS[setting.key] ?? setting.key}</span>
          {/* Beside the control, not in the page panel: the accepted range is
              what you need while choosing a value, and a panel you have to open,
              read and close before typing is not where that belongs. */}
          <HelpTip text={SETTING_HELP[setting.key]} label={`شرح: ${SETTING_LABELS[setting.key] ?? setting.key}`} />
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        {setting.type === 'bool' ? (
          <select
            value={String(setting.value)}
            onChange={(event) => onSave(setting.key, event.target.value)}
            disabled={busy}
            className="rounded-lg border border-border bg-control px-2 py-1 text-sm"
          >
            <option value="true">مفعّل</option>
            <option value="false">معطّل</option>
          </select>
        ) : setting.options ? (
          <select
            value={String(setting.value)}
            onChange={(event) => onSave(setting.key, event.target.value)}
            disabled={busy}
            className="rounded-lg border border-border bg-control px-2 py-1 text-sm"
          >
            {setting.options.map((option) => (
              <option key={option} value={option}>
                {OPTION_LABELS[option] ?? option}
              </option>
            ))}
          </select>
        ) : setting.type === 'list' ? (
          <div className="max-w-md">
            <TagField
              value={draft}
              onChange={setDraft}
              suggestions={setting.key === 'upload.allowed_extensions' ? EXTENSION_SUGGESTIONS : []}
              normalise={setting.key === 'upload.allowed_extensions' ? normaliseExtension : undefined}
              placeholder="اكتب امتداداً ثم Enter"
              emptyHint="القائمة فارغة — كل الامتدادات مسموحة."
            />
          </div>
        ) : (
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                dir={setting.type === 'int' ? 'ltr' : 'rtl'}
                className="w-full rounded-lg border border-border bg-control px-2 py-1 text-sm"
              />
              {unit ? (
                <span className="shrink-0 text-xs text-text-muted">{unit.suffix}</span>
              ) : null}
            </div>
            {/* The stored value, live. Converting for readability should not
                make the real number unknowable — this is the one the API,
                the logs and the error messages all speak in. */}
            {unit?.describe(draft) ? (
              <span className="num mt-1 block text-[11px] text-text-muted">
                {unit.describe(draft)}
              </span>
            ) : null}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-center">
        {/* Which values are stored and which come from the environment is what
            makes "I changed it and nothing happened" diagnosable. */}
        <span className={`text-xs ${setting.source === 'database' ? 'text-primary' : 'text-text-muted'}`}>
          {setting.source === 'database' ? 'مخصّص' : 'افتراضي'}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-center gap-1">
          {changed ? (
            <Button
              onClick={() => onSave(setting.key, unit ? unit.toStored(draft) : draft)}
              disabled={busy}
              className="!px-2 !py-1 text-xs"
            >
              حفظ
            </Button>
          ) : null}
          {setting.source === 'database' ? (
            <button
              onClick={() => onRevert(setting.key)}
              disabled={busy}
              title="العودة إلى قيمة البيئة"
              aria-label="العودة إلى قيمة البيئة"
              className="rounded border border-border p-1.5 text-text-muted hover:bg-primary/10 hover:text-primary"
            >
              <RotateCcw size={14} />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ── Metadata vocabulary ──────────────────────────────────────────────────

/** The field kinds the server accepts, with what each one means to a user. */
const DATA_TYPES = [
  { value: 'text', label: 'نص' },
  { value: 'number', label: 'رقم' },
  { value: 'date', label: 'تاريخ' },
  { value: 'bool', label: 'نعم / لا' },
  { value: 'choice', label: 'اختيار من قائمة' },
  { value: 'multiselect', label: 'اختيار متعدد' },
  { value: 'user', label: 'مستخدم' },
];

const NEEDS_CHOICES = new Set(['choice', 'multiselect']);

/**
 * Document types, custom fields and sensitivity labels.
 *
 * All three are super-admin routes that have existed since Tier 1 and had no
 * interface at all: `POST /api/metadata/types`, `/fields` and `/labels` were
 * reachable only with a REST client. That mattered more than it sounds, because
 * the metadata form on every document is generated from these definitions — with
 * no way to create a type, the document form has nothing to render and the
 * feature reads as missing rather than unconfigured.
 *
 * Nothing here deletes. The server offers deactivation instead, because a type
 * or field that documents already reference cannot be removed without stranding
 * the values recorded against it. Definitions are now editable in place through
 * the row actions; what stays fixed after creation (field data_type and type_id,
 * choice_id on individual choices) is shown read-only inside the edit dialogs.
 */
function MetadataTab() {
  const [types, setTypes] = useState(null);
  const [fields, setFields] = useState([]);
  const [labels, setLabels] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [typeForm, setTypeForm] = useState({ name: '', description: '' });
  const [fieldForm, setFieldForm] = useState({
    name: '',
    dataType: 'text',
    typeId: '',
    isRequired: false,
    isSearchable: true,
    choices: '',
  });
  const [labelForm, setLabelForm] = useState({ name: '', severityRank: '', colour: '' });

  // Edit dialogs — one draft per entity kind; null when the dialog is closed.
  const [editingType, setEditingType] = useState(null);
  const [editingField, setEditingField] = useState(null);
  const [editingLabel, setEditingLabel] = useState(null);

  const load = useCallback(async () => {
    try {
      // Inactive included: this is the only screen from which a retired
      // definition can be switched back on, so hiding them would strand them.
      // Labels also need the inactive flag — a retired label can be reactivated
      // from here, and without it the toggle would disappear the moment it fires.
      const [typeList, fieldList, labelList] = await Promise.all([
        api.metadata.types(true),
        api.metadata.fields(null, true),
        api.metadata.labels(true),
      ]);
      setTypes(typeList.types);
      setFields(fieldList.fields);
      setLabels(labelList.labels);
    } catch {
      setError('تعذر تحميل التعريفات.');
      setTypes([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Runs one definition change.
   *
   * Reports whether it worked, because the caller uses that to decide whether to
   * clear its form. Clearing unconditionally throws away what the user typed on
   * exactly the occasions they need it back — a rejected name, a rank already
   * taken — leaving an error message about a value no longer on screen.
   *
   * @returns {Promise<boolean>} true when the change was accepted.
   */
  async function run(action, success) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      if (success) setNotice(success);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!types) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.metadata" />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {/* ── Types ── */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-text">أنواع الوثائق</h3>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                api.metadata.createType({
                  name: typeForm.name.trim(),
                  description: typeForm.description.trim() || null,
                }),
              'أُضيف النوع.',
            ).then((ok) => ok && setTypeForm({ name: '', description: '' }));
          }}
          className="mb-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        >
          <TextField
            label="نوع جديد"
            value={typeForm.name}
            onChange={(event) => setTypeForm({ ...typeForm, name: event.target.value })}
          />
          <TextField
            label="الوصف (اختياري)"
            value={typeForm.description}
            onChange={(event) => setTypeForm({ ...typeForm, description: event.target.value })}
          />
          <div className="flex items-end">
            <Button type="submit" icon={Plus} disabled={busy || !typeForm.name.trim()}>
              إضافة
            </Button>
          </div>
        </form>

        {types.length === 0 ? (
          <EmptyState icon={SlidersHorizontal} title="لا توجد أنواع بعد" />
        ) : (
          <ul className="divide-y divide-border/50 rounded-lg border border-border">
            {types.map((type) => (
              <li key={type.typeId} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  {/* `gap`, not a margin: `.num` sets `direction: ltr` on the
                      count, which flips where its `ms-*` would land. */}
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm ${type.isActive ? 'text-text' : 'text-text-muted line-through'}`}>
                      {type.name}
                    </span>
                    <span className="num text-[11px] text-text-muted">
                      {fields.filter((f) => f.typeId === type.typeId).length} حقل
                    </span>
                  </span>
                  {type.description ? (
                    <span className="block text-[11px] text-text-muted">{type.description}</span>
                  ) : null}
                </span>
                <ExpandableActions
                  onEdit={() =>
                    setEditingType({
                      typeId: type.typeId,
                      name: type.name,
                      description: type.description ?? '',
                      sortOrder: String(type.sortOrder ?? ''),
                    })
                  }
                  onToggleActive={() =>
                    run(
                      () => api.metadata.setTypeActive(type.typeId, !type.isActive),
                      type.isActive ? 'عُطّل النوع.' : 'فُعّل النوع.',
                    )
                  }
                  isActive={type.isActive}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Fields ── */}
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold text-text">
          الحقول
          <HelpTip
            label="شرح الحقول"
            text={'الحقل المرتبط بنوع يظهر لوثائق ذلك النوع وحدها. الحقل بلا نوع يظهر لكل الوثائق. '
              + 'نوع البيانات لا يمكن تغييره بعد الإنشاء، لأن القيم المحفوظة تُخزَّن بحسبه.'}
          />
        </h3>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                api.metadata.createField({
                  name: fieldForm.name.trim(),
                  dataType: fieldForm.dataType,
                  typeId: fieldForm.typeId ? Number(fieldForm.typeId) : null,
                  isRequired: fieldForm.isRequired,
                  isSearchable: fieldForm.isSearchable,
                  choices: NEEDS_CHOICES.has(fieldForm.dataType)
                    ? fieldForm.choices.split(/[,،]/).map((choice) => choice.trim()).filter(Boolean)
                    : [],
                }),
              'أُضيف الحقل.',
            ).then(
              (ok) =>
                ok
                && setFieldForm({
                  name: '',
                  dataType: 'text',
                  typeId: '',
                  isRequired: false,
                  isSearchable: true,
                  choices: '',
                }),
            );
          }}
          className="mb-3 space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="اسم الحقل"
              value={fieldForm.name}
              onChange={(event) => setFieldForm({ ...fieldForm, name: event.target.value })}
            />
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">نوع البيانات</span>
              <select
                value={fieldForm.dataType}
                onChange={(event) => setFieldForm({ ...fieldForm, dataType: event.target.value })}
                className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm"
              >
                {DATA_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">يخص النوع</span>
              <select
                value={fieldForm.typeId}
                onChange={(event) => setFieldForm({ ...fieldForm, typeId: event.target.value })}
                className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm"
              >
                <option value="">كل الأنواع</option>
                {types.filter((type) => type.isActive).map((type) => (
                  <option key={type.typeId} value={type.typeId}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Only for the two kinds that cannot be created without them — the
              server refuses `choices_required` otherwise. */}
          {NEEDS_CHOICES.has(fieldForm.dataType) ? (
            <TextField
              label="الخيارات"
              hint="افصل بينها بفواصل، مثل: مسودة, معتمد, ملغى"
              value={fieldForm.choices}
              onChange={(event) => setFieldForm({ ...fieldForm, choices: event.target.value })}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm text-text">
              <input
                type="checkbox"
                checked={fieldForm.isRequired}
                onChange={(event) => setFieldForm({ ...fieldForm, isRequired: event.target.checked })}
              />
              إلزامي
            </label>
            <label className="flex items-center gap-1.5 text-sm text-text">
              <input
                type="checkbox"
                checked={fieldForm.isSearchable}
                onChange={(event) => setFieldForm({ ...fieldForm, isSearchable: event.target.checked })}
              />
              قابل للبحث
            </label>
            <Button
              type="submit"
              icon={Plus}
              disabled={
                busy
                || !fieldForm.name.trim()
                || (NEEDS_CHOICES.has(fieldForm.dataType) && !fieldForm.choices.trim())
              }
            >
              إضافة الحقل
            </Button>
          </div>
        </form>

        {fields.length === 0 ? (
          <EmptyState icon={SlidersHorizontal} title="لا توجد حقول بعد" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                  <th className="px-3 py-2 text-right font-semibold">الاسم</th>
                  <th className="px-3 py-2 text-right font-semibold">النوع</th>
                  <th className="px-3 py-2 text-right font-semibold">يخص</th>
                  <th className="px-3 py-2 text-right font-semibold">خصائص</th>
                  <th className="px-3 py-2 text-center font-semibold">الحالة</th>
                  <th className="px-3 py-2 text-center font-semibold">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {fields.map((field) => (
                  <tr key={field.fieldId} className="hover:bg-surface-muted/30">
                    <td className={`px-3 py-2 text-right ${field.isActive ? 'text-text' : 'text-text-muted line-through'}`}>
                      {field.name}
                      {field.choices?.length ? (
                        <span className="block text-[11px] text-text-muted">
                          {field.choices.map((choice) => choice.label).join('، ')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right text-text-muted">
                      {DATA_TYPES.find((option) => option.value === field.dataType)?.label ?? field.dataType}
                    </td>
                    <td className="px-3 py-2 text-right text-text-muted">
                      {field.typeName ?? 'كل الأنواع'}
                    </td>
                    <td className="px-3 py-2 text-right text-[11px] text-text-muted">
                      {[field.isRequired ? 'إلزامي' : null, field.isSearchable ? 'قابل للبحث' : null]
                        .filter(Boolean)
                        .join('، ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {field.isActive ? (
                        <span className="text-xs text-green-600">نشط</span>
                      ) : (
                        <span className="text-xs text-text-muted">معطّل</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-center">
                        <ExpandableActions
                          onEdit={() =>
                            setEditingField({
                              fieldId: field.fieldId,
                              name: field.name,
                              dataType: field.dataType,
                              typeName: field.typeName ?? 'كل الأنواع',
                              isRequired: field.isRequired,
                              isSearchable: field.isSearchable,
                              sortOrder: String(field.sortOrder ?? ''),
                              choices: NEEDS_CHOICES.has(field.dataType)
                                ? (field.choices ?? []).filter((c) => c.isActive !== false).map((c) => c.label).join('، ')
                                : '',
                            })
                          }
                          onToggleActive={() =>
                            run(
                              () => api.metadata.setFieldActive(field.fieldId, !field.isActive),
                              field.isActive ? 'عُطّل الحقل.' : 'فُعّل الحقل.',
                            )
                          }
                          isActive={field.isActive}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Sensitivity labels ── */}
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold text-text">
          درجات السرية
          <HelpTip
            label="شرح درجات السرية"
            text={'وسم تصنيفي يظهر على الوثيقة. لا يمنع أحداً من القراءة — المنع يأتي من صلاحيات '
              + 'المجلد. الرتبة رقم فريد يرتّب الدرجات من الأدنى إلى الأعلى.'}
          />
        </h3>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                api.metadata.createLabel({
                  name: labelForm.name.trim(),
                  severityRank: Number(labelForm.severityRank),
                  // Normalised: the server takes `#RRGGBB` and nothing else, so
                  // a typed `2563eb` or `#25e` is fixed here rather than refused.
                  colour: normaliseHex(labelForm.colour),
                }),
              'أُضيفت الدرجة.',
            ).then((ok) => ok && setLabelForm({ name: '', severityRank: '', colour: '' }));
          }}
          className="mb-3 space-y-3"
        >
          {/* The colour picker needs a row of its own — squeezed into the field
              grid it had nowhere to put its palette. */}
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <TextField
              label="درجة جديدة"
              value={labelForm.name}
              onChange={(event) => setLabelForm({ ...labelForm, name: event.target.value })}
            />
            <TextField
              label="الرتبة"
              dir="ltr"
              inputMode="numeric"
              hint="رقم فريد، الأدنى أولاً"
              value={labelForm.severityRank}
              onChange={(event) => setLabelForm({ ...labelForm, severityRank: event.target.value })}
            />
          </div>

          <ColourField
            value={labelForm.colour}
            preview={labelForm.name.trim()}
            onChange={(colour) => setLabelForm({ ...labelForm, colour })}
          />

          <Button
            type="submit"
            icon={Plus}
            disabled={
              busy
              || !labelForm.name.trim()
              || !/^-?\d+$/.test(labelForm.severityRank.trim())
              // A colour that will not normalise is refused here rather than by
              // the server, which answers only `invalid_colour`.
              || (labelForm.colour.trim() !== '' && normaliseHex(labelForm.colour) === null)
            }
          >
            إضافة
          </Button>
        </form>

        {labels.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="لا توجد درجات سرية بعد" />
        ) : (
          <ul className="divide-y divide-border/50 rounded-lg border border-border">
            {labels.map((label) => (
              <li key={label.labelId} className="flex items-center gap-2 px-3 py-2">
                <span
                  aria-hidden="true"
                  className={`h-3 w-3 shrink-0 rounded-full border border-border ${label.isActive === false ? 'opacity-40' : ''}`}
                  style={label.colour ? { backgroundColor: label.colour } : undefined}
                />
                <span className={`flex-1 flex items-center gap-2 text-sm ${label.isActive === false ? 'text-text-muted line-through' : 'text-text'}`}>
                  {label.name}
                  {label.isActive === false ? (
                    <span className="rounded bg-text-muted/10 px-1 py-0.5 text-[10px] no-underline" style={{ textDecoration: 'none' }}>
                      معطّلة
                    </span>
                  ) : null}
                </span>
                <span className="num text-xs text-text-muted">رتبة {label.severityRank}</span>
                <ExpandableActions
                  onEdit={() =>
                    setEditingLabel({
                      labelId: label.labelId,
                      name: label.name,
                      severityRank: String(label.severityRank),
                      colour: label.colour ?? '',
                    })
                  }
                  onToggleActive={() =>
                    run(
                      () => api.metadata.setLabelActive(label.labelId, !label.isActive),
                      label.isActive !== false ? 'عُطّلت الدرجة.' : 'فُعّلت الدرجة.',
                    )
                  }
                  isActive={label.isActive !== false}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Edit dialogs ── */}

      {/* TypeDialog: name, description, sort order. Data-type and its fields are
          immutable and shown outside the dialog to explain why. */}
      <Modal
        open={Boolean(editingType)}
        onClose={() => setEditingType(null)}
        title="تعديل نوع الوثيقة"
        icon={SlidersHorizontal}
        size="md"
        footer={
          <>
            <Button
              icon={Save}
              disabled={busy || !editingType?.name.trim()}
              onClick={async () => {
                const ok = await run(
                  () =>
                    api.metadata.updateType(editingType.typeId, {
                      name: editingType.name.trim(),
                      description: editingType.description.trim() || null,
                      sortOrder: editingType.sortOrder !== '' ? Number(editingType.sortOrder) : undefined,
                    }),
                  'حُفظ النوع.',
                );
                if (ok) setEditingType(null);
              }}
            >
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setEditingType(null)} disabled={busy}>
              إلغاء
            </Button>
          </>
        }
      >
        {editingType ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="الاسم"
              value={editingType.name}
              onChange={(event) => setEditingType({ ...editingType, name: event.target.value })}
            />
            <TextField
              label="الوصف (اختياري)"
              value={editingType.description}
              onChange={(event) =>
                setEditingType({ ...editingType, description: event.target.value })
              }
            />
            <TextField
              label="الترتيب"
              dir="ltr"
              inputMode="numeric"
              hint="الأدنى أولاً"
              value={editingType.sortOrder}
              onChange={(event) =>
                setEditingType({ ...editingType, sortOrder: event.target.value })
              }
            />
          </div>
        ) : null}
      </Modal>

      {/* FieldDialog: read-only data type + scope hint, then the editable knobs. */}
      <Modal
        open={Boolean(editingField)}
        onClose={() => setEditingField(null)}
        title="تعديل الحقل"
        icon={SlidersHorizontal}
        size="md"
        footer={
          <>
            <Button
              icon={Save}
              disabled={busy || !editingField?.name.trim()}
              onClick={async () => {
                const body = {
                  name: editingField.name.trim(),
                  isRequired: editingField.isRequired,
                  isSearchable: editingField.isSearchable,
                  sortOrder: editingField.sortOrder !== '' ? Number(editingField.sortOrder) : undefined,
                };
                if (NEEDS_CHOICES.has(editingField.dataType)) {
                  // Arabic or Latin comma as separator; trim each token.
                  body.choices = editingField.choices
                    .split(/[,،]/)
                    .map((c) => c.trim())
                    .filter(Boolean);
                }
                const ok = await run(() => api.metadata.updateField(editingField.fieldId, body), 'حُفظ الحقل.');
                if (ok) setEditingField(null);
              }}
            >
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setEditingField(null)} disabled={busy}>
              إلغاء
            </Button>
          </>
        }
      >
        {editingField ? (
          <div className="space-y-3">
            {/* The data type and scope are frozen once a field is created because
                stored values are encoded by type. Showing them read-only explains
                the constraint without a separate help topic. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-xs font-medium text-text-muted">نوع البيانات</span>
                <span className="text-sm text-text-muted">
                  {DATA_TYPES.find((d) => d.value === editingField.dataType)?.label ?? editingField.dataType}
                </span>
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium text-text-muted">يخص</span>
                <span className="text-sm text-text-muted">{editingField.typeName}</span>
              </div>
            </div>
            <p className="text-[11px] text-text-muted">
              نوع البيانات ونطاقه لا يتغيّران بعد الإنشاء، لأن القيم المحفوظة تُخزَّن بحسبهما.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="الاسم"
                value={editingField.name}
                onChange={(event) => setEditingField({ ...editingField, name: event.target.value })}
              />
              <TextField
                label="الترتيب"
                dir="ltr"
                inputMode="numeric"
                hint="الأدنى أولاً"
                value={editingField.sortOrder}
                onChange={(event) =>
                  setEditingField({ ...editingField, sortOrder: event.target.value })
                }
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-1.5 text-sm text-text">
                <input
                  type="checkbox"
                  checked={editingField.isRequired}
                  onChange={(event) =>
                    setEditingField({ ...editingField, isRequired: event.target.checked })
                  }
                />
                إلزامي
              </label>
              <label className="flex items-center gap-1.5 text-sm text-text">
                <input
                  type="checkbox"
                  checked={editingField.isSearchable}
                  onChange={(event) =>
                    setEditingField({ ...editingField, isSearchable: event.target.checked })
                  }
                />
                قابل للبحث
              </label>
            </div>
            {NEEDS_CHOICES.has(editingField.dataType) ? (
              <TextField
                label="الخيارات"
                hint="الخيار الذي تحذفه من القائمة يُعطَّل ولا يُحذف: الوثائق التي اختارته تحتفظ به."
                value={editingField.choices}
                onChange={(event) =>
                  setEditingField({ ...editingField, choices: event.target.value })
                }
              />
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* LabelDialog: name, severity rank (numeric ltr), colour picker. */}
      <Modal
        open={Boolean(editingLabel)}
        onClose={() => setEditingLabel(null)}
        title="تعديل درجة السرية"
        icon={Shield}
        size="md"
        footer={
          <>
            <Button
              icon={Save}
              disabled={
                busy
                || !editingLabel?.name.trim()
                || !/^-?\d+$/.test(editingLabel?.severityRank?.trim() ?? '')
                || (editingLabel?.colour.trim() !== '' && normaliseHex(editingLabel?.colour) === null)
              }
              onClick={async () => {
                const ok = await run(
                  () =>
                    api.metadata.updateLabel(editingLabel.labelId, {
                      name: editingLabel.name.trim(),
                      severityRank: Number(editingLabel.severityRank),
                      colour: editingLabel.colour.trim() ? normaliseHex(editingLabel.colour) : undefined,
                    }),
                  'حُفظت الدرجة.',
                );
                if (ok) setEditingLabel(null);
              }}
            >
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setEditingLabel(null)} disabled={busy}>
              إلغاء
            </Button>
          </>
        }
      >
        {editingLabel ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <TextField
                label="الاسم"
                value={editingLabel.name}
                onChange={(event) =>
                  setEditingLabel({ ...editingLabel, name: event.target.value })
                }
              />
              <TextField
                label="الرتبة"
                dir="ltr"
                inputMode="numeric"
                hint="رقم فريد، الأدنى أولاً"
                value={editingLabel.severityRank}
                onChange={(event) =>
                  setEditingLabel({ ...editingLabel, severityRank: event.target.value })
                }
              />
            </div>
            <ColourField
              value={editingLabel.colour}
              preview={editingLabel.name.trim()}
              onChange={(colour) => setEditingLabel({ ...editingLabel, colour })}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

// ── Audit log ────────────────────────────────────────────────────────────

/**
 * Who did what, when, from where.
 *
 * The trail has been recorded since Tier 1 and the route to read it has existed
 * just as long — `GET /api/admin/audit`, filters, keyset paging and all. Nothing
 * ever called it, so the one question an audited document system is guaranteed
 * to be asked had no answer in the interface. This is that answer.
 *
 * Action names are shown raw. They are stable identifiers like
 * `document.downloaded`, they are what the filter matches on, and inventing
 * Arabic for a list the server extends independently would go stale silently —
 * so the label carries the English and the help explains the vocabulary once.
 */
function AuditTab() {
  const [entries, setEntries] = useState(null);
  const [actions, setActions] = useState([]);
  const [auditUsers, setAuditUsers] = useState([]);
  const [filters, setFilters] = useState({ action: '', from: '', to: '', actor: '' });
  const [cursor, setCursor] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /** @param {boolean} append Continue the current page rather than restarting. */
  const fetchPage = useCallback(
    async (active, next = null, append = false) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (active.action) params.set('action', active.action);
        if (active.actor) params.set('actor', active.actor);

        /*
         * Both bounds carry a time, and both are local.
         *
         * The server hands each to `new Date()`, and a bare "2026-08-01" is
         * parsed as UTC midnight while "2026-08-01T00:00:00" is parsed as local
         * — so sending the bare date for `from` and a timed value for `to` would
         * silently drop the first hours of the opening day for anyone east of
         * UTC. At UTC+3 that is everything logged before 03:00.
         *
         * `to` runs to the end of its day rather than its first instant, or
         * "to: today" would return nothing that happened today.
         */
        if (active.from) params.set('from', `${active.from}T00:00:00`);
        if (active.to) params.set('to', `${active.to}T23:59:59.999`);

        if (next) params.set('cursor', next);

        const page = await api.admin.audit(params.toString());
        setEntries((current) => (append && current ? [...current, ...page.entries] : page.entries));
        setCursor(page.nextCursor ?? null);
      } catch {
        setError('تعذر تحميل سجل التدقيق.');
        if (!append) setEntries([]);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    // The action list comes from the rows that exist, so the filter never offers
    // a value that can only return nothing. Users are loaded once to populate
    // the actor filter — the full list without pagination or inactive flag so
    // the select covers everyone who may ever have acted.
    api.admin
      .auditActions()
      .then((result) => setActions(result.actions ?? []))
      .catch(() => setActions([]));
    api.admin
      .users('', { includeInactive: true })
      .then((list) => setAuditUsers(Array.isArray(list) ? list : []))
      .catch(() => setAuditUsers([]));
    fetchPage({ action: '', from: '', to: '', actor: '' });
  }, [fetchPage]);

  function apply(event) {
    event.preventDefault();
    setCursor(null);
    fetchPage(filters);
  }

  if (!entries) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.audit" />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="p-4">
        <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1 text-sm font-medium text-text">
              الإجراء
              <HelpTip
                label="شرح مرشّح الإجراء"
                text={'أسماء الإجراءات معرّفات ثابتة بالإنجليزية يستعملها النظام والسجل معاً، مثل '
                  + 'document.downloaded للتنزيل و acl.entry_set لتغيير صلاحية. '
                  + 'القائمة تعرض ما هو مسجَّل فعلاً فقط.'}
              />
            </span>
            <select
              value={filters.action}
              onChange={(event) => setFilters({ ...filters, action: event.target.value })}
              dir="ltr"
              className="w-56 rounded-lg border border-border bg-control px-2 py-2 text-sm"
            >
              <option value="">كل الإجراءات</option>
              {actions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">من تاريخ</span>
            <input
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
              className="rounded-lg border border-border bg-control px-2 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">إلى تاريخ</span>
            <input
              type="date"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
              className="rounded-lg border border-border bg-control px-2 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">المنفّذ</span>
            <select
              value={filters.actor}
              onChange={(event) => setFilters({ ...filters, actor: event.target.value })}
              className="w-48 rounded-lg border border-border bg-control px-2 py-2 text-sm"
            >
              <option value="">كل المستخدمين</option>
              {auditUsers.map((u) => (
                <option key={u.userId} value={String(u.userId)}>
                  {u.displayName} ({u.username})
                </option>
              ))}
            </select>
          </label>

          <Button type="submit" disabled={busy}>
            تصفية
          </Button>
          {filters.action || filters.from || filters.to || filters.actor ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const cleared = { action: '', from: '', to: '', actor: '' };
                setFilters(cleared);
                setCursor(null);
                fetchPage(cleared);
              }}
            >
              مسح المرشّحات
            </Button>
          ) : null}
        </form>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="لا توجد سجلات مطابقة"
          hint="جرّب توسيع المدة أو اختيار «كل الإجراءات»."
        />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                    <th className="px-4 py-3 text-right font-semibold">الوقت</th>
                    <th className="px-4 py-3 text-right font-semibold">المنفّذ</th>
                    <th className="px-4 py-3 text-right font-semibold">الإجراء</th>
                    <th className="px-4 py-3 text-right font-semibold">الهدف</th>
                    <th className="px-4 py-3 text-right font-semibold">التفاصيل</th>
                    <th className="px-4 py-3 text-left font-semibold">العنوان</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {entries.map((entry) => (
                    <tr key={entry.auditId} className="hover:bg-surface-muted/30">
                      <td
                        className="num whitespace-nowrap px-4 py-3 text-right text-text-muted"
                        title={formatDateTime(entry.occurredAt)}
                      >
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-text">{entry.actor}</td>
                      <td className="px-4 py-3 text-right text-text-muted" dir="ltr">
                        {entry.action}
                      </td>
                      <td className="px-4 py-3 text-right text-text-muted">
                        {entry.folderName ?? (entry.targetType ? `${entry.targetType} ${entry.targetId ?? ''}` : '—')}
                      </td>
                      <td className="max-w-xs truncate px-4 py-3 text-right text-text-muted" title={entry.detail ?? ''}>
                        {entry.detail ?? '—'}
                      </td>
                      <td className="num px-4 py-3 text-left text-text-muted" dir="ltr">
                        {entry.ipAddress ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Keyset paging, so a long trail is walked rather than counted. */}
          {cursor ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => fetchPage(filters, cursor, true)}
              >
                {busy ? 'جارٍ التحميل…' : 'المزيد'}
              </Button>
            </div>
          ) : (
            <p className="text-center text-xs text-text-muted">نهاية السجل المطابق.</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Diagnostics ──────────────────────────────────────────────────────────

/**
 * Why search cannot find things, in one place.
 *
 * "unindexed" is the OCR work list: documents stored and browsable whose
 * contents nothing can search.
 */
/**
 * What the sweep did, and — when it did nothing — why.
 *
 * This replaced a raw JSON dump. "purged: 0" was not merely ugly: it is the same
 * output whether the bin is empty, everything is still inside its grace period,
 * or the content is already gone, and an operator reading a zero could not tell
 * which. Every branch below ends in something the reader can act on or wait for.
 */
function PurgeSummary({ result }) {
  const documents = result?.documents ?? {};
  const uploads = result?.uploads ?? {};
  const bin = result?.bin ?? null;
  const dryRun = documents.dryRun === true;
  const purged = Number(documents.purged ?? 0);
  const failed = Number(documents.failed ?? 0);
  const removedFiles = Number(uploads.temp ?? 0) + Number(uploads.staging ?? 0);

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface-muted/40 p-3 text-xs leading-relaxed">
      {purged > 0 ? (
        <p className="font-medium text-text">
          {dryRun ? 'سيُمحى ' : 'مُحي '}
          <span className="num">{purged}</span> ملفاً
          {documents.bytes ? <> بحجم {formatBytes(Number(documents.bytes))}</> : null}
          {dryRun ? ' عند التشغيل الفعلي.' : '.'}
        </p>
      ) : (
        <p className="font-medium text-text">لم يكن هناك ما يُمحى.</p>
      )}

      {/* The reason, which is the part a bare zero could never give. */}
      {bin && purged === 0 ? (
        <ul className="space-y-1 text-text-muted">
          {bin.waiting > 0 ? (
            <li>
              • <span className="num">{bin.waiting}</span> وثيقة في سلة المحذوفات ما زالت ضمن مهلة
              الاسترجاع (<span className="num">{bin.graceDays}</span> يوماً) ويمكن استعادتها
              {bin.nextEligibleAt ? <> — أقربها يصبح قابلاً للمحو في {formatDateTime(bin.nextEligibleAt)}</> : null}.
            </li>
          ) : null}
          {bin.tombstones > 0 ? (
            <li>
              • <span className="num">{bin.tombstones}</span> وثيقة مُحي محتواها بالفعل: يبقى سجلها
              للمراجعة فقط، ولا تمنع حذف المجلد.
            </li>
          ) : null}
          {bin.waiting === 0 && bin.tombstones === 0 ? <li>• سلة المحذوفات فارغة.</li> : null}
        </ul>
      ) : null}

      {!dryRun && removedFiles > 0 ? (
        <p className="text-text-muted">
          • أُزيلت <span className="num">{removedFiles}</span> من ملفات الرفع المتوقفة.
        </p>
      ) : null}

      {failed > 0 ? (
        <p className="font-medium text-red-600">
          • تعذّر محو <span className="num">{failed}</span> ملفاً — راجع سجل الخادم.
        </p>
      ) : null}
    </div>
  );
}

function DiagnosticsTab() {
  const [stats, setStats] = useState(null);
  const [mail, setMail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [reindexed, setReindexed] = useState(null);
  const [failures, setFailures] = useState([]);
  const { confirm } = useDialogs();
  const [waiting, setWaiting] = useState([]);
  const [renditions, setRenditions] = useState(null);

  const load = useCallback(async () => {
    try {
      // Fetched together: a diagnostics screen that loads in four stages shows
      // three different half-truths on the way.
      const [s, m, f, r] = await Promise.all([
        api.admin.extractionStats(),
        api.admin.mailStatus(),
        api.admin.extractionFailures().catch(() => ({ failures: [], waiting: [] })),
        api.admin.renditionStatus().catch(() => null),
      ]);
      setStats(s);
      setMail(m);
      setFailures(f.failures ?? []);
      setWaiting(f.waiting ?? []);
      setRenditions(r);
    } catch {
      setError('تعذر تحميل بيانات التشخيص.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Whether a queue still has work genuinely moving through it.
   *
   * `running` alone is not enough on either side. A job sits in `pending` for up
   * to a full worker poll before it is claimed, so ignoring pending would
   * announce completion before anything had started — and a job abandoned by a
   * dead worker sits in `running` forever, so counting it would mean the
   * opposite: a screen that claims work is in progress and never stops. Stuck
   * jobs are subtracted; they have their own alert, and they are not progress.
   */
  const movingJobs = (queue, stuckJobs = 0) =>
    Math.max(0, (queue?.pending ?? 0) + (queue?.running ?? 0) - stuckJobs);

  /*
   * Deliberately separate. These are independent queues with independent
   * workers, and merging them meant a stuck *thumbnail* left the *reindex*
   * banner saying "جارٍ المعالجة" indefinitely — reporting on work the operator
   * had not asked about and could not see, about a document that was in fact
   * fully indexed.
   */
  const extractionBusy = movingJobs(stats?.queue, stats?.worker?.stuckJobs ?? 0);
  const renditionsBusy = movingJobs(renditions?.queue, renditions?.stuckJobs ?? 0);
  const inFlight = extractionBusy > 0 || renditionsBusy > 0;

  /**
   * Refreshes itself while work is in flight.
   *
   * ─── Why this had to exist ──────────────────────────────────────────────
   *
   * Reindexing reported "1 document requeued" and then never said another
   * word. The one refresh it did run fired milliseconds after the POST — long
   * before the worker's next poll — so it re-rendered the state from *before*
   * the work, and nothing ever fetched again. An operator had no way to tell a
   * job still running from one that had finished, or from one that had failed
   * again for the same reason as last time. The honest answer to "is it done?"
   * was to reload the page and guess.
   *
   * The effect re-runs after every refresh (setStats always yields a new
   * object), which is what chains one poll to the next, and it stops as soon as
   * both queues read zero — so an idle diagnostics screen makes no requests at
   * all.
   */
  useEffect(() => {
    if (!inFlight) return undefined;
    // Slower than the eye wants and faster than the worker's own poll, which is
    // what actually bounds how quickly anything can change.
    const timer = setTimeout(load, 4000);
    return () => clearTimeout(timer);
  }, [inFlight, load, stats, renditions]);

  async function reindex() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.admin.reindex();
      setReindexed(result.requeued);
      await load();
    } catch {
      setError('تعذرت إعادة الفهرسة.');
    } finally {
      setBusy(false);
    }
  }

  if (!stats) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.diagnostics" />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="مفهرسة" value={stats.documents.extracted} />
        <Stat label="عبر OCR" value={stats.documents.ocr} />
        <Stat label="غير مفهرسة" value={stats.documents.unindexed} tone="warn" />
        <Stat label="فشل الاستخراج" value={stats.documents.failed} tone="bad" />
        <Stat
          label="قيد الانتظار"
          value={stats.documents.pending}
          tone={stats.documents.pending > 0 ? 'warn' : undefined}
        />
      </div>

      <QueueHealth
        title="طابور فهرسة النصوص"
        queue={stats.queue}
        stuckJobs={stats.worker?.stuckJobs ?? 0}
        worker={stats.worker}
        failures={failures}
        waiting={waiting}
        live={extractionBusy > 0}
      />

      {renditions ? (
        <QueueHealth
          title="طابور المعاينات والصور المصغّرة"
          queue={renditions.queue}
          stuckJobs={renditions.stuckJobs ?? 0}
          failures={renditions.failures}
          live={renditionsBusy > 0}
        />
      ) : null}

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">المسح الضوئي للنصوص (OCR)</h3>
          {/*
            Failed and skipped jobs are terminal by design, which is right while
            the cause is the document and wrong when the cause was the server —
            an OCR engine installed later, a parser since fixed. Without this the
            only remedy is deleting and re-uploading each file, losing its
            version history.
          */}
          <Button
            variant="secondary"
            onClick={reindex}
            disabled={busy}
            className="!px-2 !py-1 text-xs"
          >
            إعادة فهرسة غير المفهرَس
          </Button>
        </div>
        {/*
          Three outcomes, because "requeued N documents" answers a different
          question from the one being asked. Requeueing is instant and says
          nothing about whether the work succeeded; what an operator needs is
          when it is over, and whether anything is still broken.
        */}
        {/* extractionBusy, not inFlight: this banner is about text indexing.
            A thumbnail still rendering has nothing to do with it. */}
        {reindexed === null ? null : reindexed === 0 ? (
          <Alert tone="success">لا توجد وثائق تحتاج إلى إعادة الفهرسة.</Alert>
        ) : extractionBusy > 0 ? (
          <Alert tone="warning">
            أُعيدت {reindexed} وثيقة إلى قائمة الفهرسة — جارٍ المعالجة الآن. تتحدّث هذه
            الصفحة تلقائياً عند الانتهاء.
          </Alert>
        ) : (
          <Alert tone="success">
            اكتملت معالجة الوثائق المُعاد فهرستها.
            {failures.length > 0
              ? ' لا تزال بعض الوثائق غير مفهرَسة — راجع القائمة أعلاه، والسبب مذكور تحت كل وثيقة.'
              : ' جميع الوثائق مفهرَسة الآن.'}
          </Alert>
        )}
        {!stats.ocr.enabled ? (
          <Alert tone="warning">
            OCR معطّل. الوثائق الممسوحة ضوئياً تُخزَّن وتُستعرض لكن لا يمكن البحث في محتواها.
          </Alert>
        ) : !stats.ocr.tesseract.available ? (
          <Alert tone="error">OCR مفعّل لكن محرّك Tesseract غير مثبّت على الخادم.</Alert>
        ) : !stats.ocr.arabicAvailable ? (
          <Alert tone="error">
            Tesseract مثبّت لكن بيانات اللغة العربية غير مثبّتة — ستكون النتائج فارغة.
          </Alert>
        ) : (
          <Alert tone="success">OCR جاهز، وبيانات اللغة العربية مثبّتة.</Alert>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-text">البريد</h3>
        {!mail?.configured ? (
          <Alert tone="warning">
            لم يُضبط خادم بريد. روابط إعادة تعيين كلمة المرور تُكتب في سجل النظام بدل إرسالها.
          </Alert>
        ) : mail.ok ? (
          <Alert tone="success">الاتصال بخادم البريد ناجح ({mail.host}).</Alert>
        ) : (
          <Alert tone="error">تعذر الاتصال بخادم البريد: {mail.error}</Alert>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-text">التخزين</h3>
        {/*
          Where "the next cleanup" actually is.

          The recycle bin promises that a purged document is erased "at the next
          cleanup", and until now nothing on any screen said when that was or let
          anyone bring it forward — the only button here previewed the work
          without doing it.
        */}
        <p className="mb-3 text-xs text-text-muted">
          يجري التنظيف تلقائياً كل ساعة ما دام الخادم يعمل: يمحو محتوى الوثائق التي انقضت
          مهلة استرجاعها أو طُلب محوها نهائياً، ويزيل الرفعات المتوقفة. يمكنك تشغيله الآن.
        </p>
        <div className="flex flex-row flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(await api.admin.purge(true));
              } finally {
                setBusy(false);
              }
            }}
          >
            فحص التنظيف (بدون حذف)
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              // Irreversible, so it asks — and says what a dry run is for, since
              // that is the button that should be pressed first.
              const confirmed = await confirm({
                title: 'تشغيل التنظيف الآن',
                message: 'سيُمحى محتوى كل وثيقة انقضت مهلة استرجاعها أو طُلب محوها نهائياً.',
                detail: 'لا يمكن التراجع — تُمحى الملفات من القرص. استخدم «فحص التنظيف» أولاً لمعرفة ما سيُحذف.',
                confirmLabel: 'تشغيل التنظيف',
                variant: 'danger',
              });
              if (!confirmed) return;

              setBusy(true);
              try {
                setResult(await api.admin.purge(false));
              } finally {
                setBusy(false);
              }
            }}
          >
            تشغيل التنظيف الآن
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(await api.admin.manifests());
              } finally {
                setBusy(false);
              }
            }}
          >
            إعادة توليد الفهارس
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              /*
                Not destructive, but not free either: every preview is built
                again, and an Office conversion is seconds of CPU each. So it
                asks, and says what it is for — this is the button that carries a
                corrected renderer to documents that already exist.
              */
              const confirmed = await confirm({
                title: 'إعادة بناء المعاينات',
                message: 'ستُبنى معاينات كل الوثائق من جديد وفق قواعد العرض الحالية.',
                detail:
                  'المعاينة الحالية تبقى معروضة حتى تكتمل الجديدة، والعمل يجري في الخلفية.'
                  + ' استخدمه بعد تغيير في طريقة العرض — مثل المستندات الممسوحة متعددة الصفحات.',
                confirmLabel: 'إعادة البناء',
              });
              if (!confirmed) return;

              setBusy(true);
              try {
                setResult(await api.admin.rebuildPreviews());
              } finally {
                setBusy(false);
              }
            }}
          >
            إعادة بناء المعاينات
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(await api.admin.missingBlobs());
              } finally {
                setBusy(false);
              }
            }}
          >
            فحص سلامة الملفات
          </Button>
        </div>
        {result ? <PurgeSummary result={result} /> : null}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const tones = { warn: 'text-amber-600', bad: 'text-red-600' };
  return (
    <Card className="p-4 text-center">
      <p className={`num text-2xl font-semibold ${tones[tone] ?? 'text-text'}`}>{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </Card>
  );
}

// ── Shared ───────────────────────────────────────────────────────────────

/** Maps the API's machine-readable reasons to something an admin can act on. */
function errorMessage(caught) {
  if (!(caught instanceof ApiError)) return 'تعذر إتمام العملية.';
  return (
    {
      username_taken: 'اسم المستخدم مستخدم بالفعل.',
      name_taken: 'الاسم مستخدم بالفعل.',
      invalid_username: 'اسم المستخدم غير صالح.',
      invalid_name: 'الاسم غير صالح.',
      invalid_bits: 'مجموعة الصلاحيات غير صالحة.',
      weak_password: `كلمة المرور ضعيفة: ${passwordProblemMessages(caught.body ?? caught).join(' ')}`,
      cycle: 'لا يمكن إنشاء حلقة بين المجموعات.',
      last_super_admin: 'لا يمكن تعطيل آخر مدير نظام نشط.',
      cannot_demote_self: 'لا يمكنك إلغاء صفة المدير عن نفسك.',
      system_role: 'لا يمكن تعديل دور نظامي.',
      forbidden: 'لا تملك صلاحية لهذه العملية.',
      not_found: 'العنصر غير موجود.',

      // Metadata definitions. Without these the vocabulary screen answered every
      // rejection with "تعذر إتمام العملية", which does not say what to change.
      invalid_data_type: 'نوع البيانات غير مدعوم.',
      choices_required: 'حقل الاختيار يحتاج قائمة خيارات، افصل بينها بفواصل.',
      invalid_rank: 'الرتبة يجب أن تكون رقماً صحيحاً.',
      rank_taken: 'الرتبة مستخدمة لدرجة أخرى — لكل درجة رتبة فريدة.',
      invalid_colour: 'اللون يجب أن يكون بصيغة ‎#RRGGBB.',

      // Newly surfaced reasons from the broader admin API surface.
      invalid_email: 'البريد الإلكتروني غير صالح.',
      duplicate_choice: 'خياران بالاسم نفسه في القائمة.',
      empty_entry: 'الإدخال لا يمنح ولا يمنع شيئاً.',
      principal_not_found: 'المستخدم أو المجموعة غير موجود.',
      template_in_use: 'للمسار طلبات قائمة؛ لا تُعدَّل خطواته ولا يُحذف حتى تُغلق.',
      unknown_approver: 'أحد المعتمِدين غير موجود.',
      steps_required: 'أضف خطوة واحدة على الأقل.',
      invalid_url: 'العنوان غير صالح.',
      no_events: 'اختر حدثاً واحداً على الأقل.',
      unknown_user: 'المستخدم المختار غير موجود أو معطّل.',
      invalid_value: 'القيمة غير صالحة.',
    }[caught.code] ?? 'تعذر إتمام العملية.'
  );
}
