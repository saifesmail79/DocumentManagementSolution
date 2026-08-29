import { useCallback, useEffect, useState } from 'react';
import { Users, UsersRound, KeyRound, Plus, Lock, Unlock, ShieldCheck, RotateCcw, Trash2 } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatDate } from '../format.js';
import { Button, Card, Spinner, Alert, TextField, EmptyState } from '../components/ui.jsx';

/**
 * Administration: users, groups and roles.
 *
 * Every route behind this is super-admin gated on the server. This page checks
 * the same flag only to decide what to render — a non-admin who reaches the URL
 * gets 403s from the API regardless of what is drawn.
 */
const TABS = [
  { key: 'users', label: 'المستخدمون', icon: Users },
  { key: 'groups', label: 'المجموعات', icon: UsersRound },
  { key: 'roles', label: 'الأدوار', icon: KeyRound },
];

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState('users');

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
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '' });

  const load = useCallback(async () => {
    try {
      setUsers(await api.admin.users());
    } catch {
      setError('تعذر تحميل المستخدمين.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(fn, successNotice) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      await load();
      if (successNotice) setNotice(successNotice(result));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.createUser(form);
      setCreating(false);
      setForm({ username: '', displayName: '' });
      await load();
      // Shown once. It is never retrievable again, which is why it is displayed
      // this prominently rather than in a toast that can be missed.
      setNotice(`أُنشئ المستخدم ${result.username}. كلمة المرور المؤقتة: ${result.password}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!users) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="flex flex-row gap-2">
        <Button icon={Plus} onClick={() => setCreating((v) => !v)} disabled={busy}>
          مستخدم جديد
        </Button>
      </div>

      {creating ? (
        <Card className="p-4">
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="اسم المستخدم"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              dir="ltr"
              hint="أحرف لاتينية وأرقام ونقطة وشرطة فقط"
              required
            />
            <TextField
              label="الاسم المعروض"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <div className="sm:col-span-2 flex flex-row gap-2">
              <Button type="submit" disabled={busy}>
                إنشاء
              </Button>
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                إلغاء
              </Button>
              <span className="self-center text-xs text-text-muted">
                ستُولَّد كلمة مرور مؤقتة تُعرض مرة واحدة.
              </span>
            </div>
          </form>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <th className="px-4 py-3 text-right font-semibold">الاسم</th>
                <th className="px-4 py-3 text-right font-semibold">اسم المستخدم</th>
                <th className="px-4 py-3 text-center font-semibold">الحالة</th>
                <th className="px-4 py-3 text-left font-semibold">آخر دخول</th>
                <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {users.map((item) => (
                <tr key={item.userId} className="hover:bg-surface-muted/30">
                  <td className="px-4 py-3 text-right font-medium text-text">
                    {item.displayName}
                    {item.isSuperAdmin ? (
                      <span className="me-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                        مدير
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right" dir="ltr">
                    {item.username}
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
                    <div className="flex flex-wrap items-center justify-center gap-1">
                      <SmallButton
                        onClick={() =>
                          act(
                            () => api.admin.resetPassword(item.userId),
                            (r) => `كلمة المرور المؤقتة لـ ${item.username}: ${r.password}`,
                          )
                        }
                        icon={RotateCcw}
                        label="إعادة تعيين كلمة المرور"
                        disabled={busy}
                      />
                      {item.isLocked ? (
                        <SmallButton
                          onClick={() => act(() => api.admin.unlock(item.userId))}
                          icon={Unlock}
                          label="فك القفل"
                          disabled={busy}
                        />
                      ) : null}
                      <SmallButton
                        onClick={() => act(() => api.admin.setActive(item.userId, !item.isActive))}
                        icon={item.isActive ? Lock : Unlock}
                        label={item.isActive ? 'تعطيل' : 'تفعيل'}
                        disabled={busy}
                        danger={item.isActive}
                      />
                      <SmallButton
                        onClick={() => act(() => api.admin.setSuperAdmin(item.userId, !item.isSuperAdmin))}
                        icon={ShieldCheck}
                        label={item.isSuperAdmin ? 'إلغاء صفة المدير' : 'جعله مديراً'}
                        disabled={busy}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Groups ───────────────────────────────────────────────────────────────

function GroupsTab() {
  const [groups, setGroups] = useState(null);
  const [selected, setSelected] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGroups((await api.admin.groups()).groups);
    } catch {
      setError('تعذر تحميل المجموعات.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openGroup = useCallback(async (group) => {
    setSelected(group);
    setError(null);
    try {
      setMembers((await api.admin.groupMembers(group.groupId)).members);
    } catch {
      setError('تعذر تحميل الأعضاء.');
    }
  }, []);

  async function createGroup(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.admin.createGroup({ name: name.trim() });
      setName('');
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function search(value) {
    setQuery(value);
    if (!value.trim()) return setCandidates([]);
    try {
      setCandidates((await api.admin.principals(value)).principals);
    } catch {
      setCandidates([]);
    }
  }

  async function add(principalId) {
    setBusy(true);
    setError(null);
    try {
      await api.admin.addMember(selected.groupId, principalId);
      setQuery('');
      setCandidates([]);
      await openGroup(selected);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!groups) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <form onSubmit={createGroup} className="flex flex-row items-end gap-2">
        <TextField
          label="مجموعة جديدة"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" icon={Plus} disabled={busy || !name.trim()}>
          إنشاء
        </Button>
      </form>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border/50">
            {groups.map((group) => (
              <li key={group.groupId}>
                <button
                  onClick={() => openGroup(group)}
                  className={`flex w-full items-center justify-between px-4 py-2.5 text-right text-sm transition-colors ${
                    selected?.groupId === group.groupId
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-surface-muted/40'
                  }`}
                >
                  <span className="font-medium">{group.name}</span>
                  <span className="num text-xs text-text-muted">{group.memberCount} عضو</span>
                </button>
              </li>
            ))}
          </ul>
          {groups.length === 0 ? (
            <EmptyState icon={UsersRound} title="لا توجد مجموعات بعد" />
          ) : null}
        </Card>

        {selected ? (
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-text">أعضاء: {selected.name}</h3>

            <TextField
              label="إضافة عضو"
              value={query}
              onChange={(event) => search(event.target.value)}
              placeholder="ابحث عن مستخدم أو مجموعة"
            />

            {candidates.length > 0 ? (
              <ul className="mt-2 max-h-40 overflow-y-auto rounded border border-border">
                {candidates.map((candidate) => (
                  <li key={candidate.principalId}>
                    <button
                      onClick={() => add(candidate.principalId)}
                      className="w-full px-3 py-1.5 text-right text-sm hover:bg-primary/10"
                    >
                      {candidate.displayName}
                      <span className="me-2 text-xs text-text-muted">
                        {candidate.type === 'group' ? 'مجموعة' : candidate.username}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <ul className="mt-3 divide-y divide-border/50">
              {members.map((member) => (
                <li key={member.principalId} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    {member.displayName}
                    <span className="me-2 text-xs text-text-muted">
                      {member.type === 'group' ? 'مجموعة' : 'مستخدم'}
                    </span>
                  </span>
                  <button
                    onClick={async () => {
                      await api.admin.removeMember(selected.groupId, member.principalId);
                      await openGroup(selected);
                      await load();
                    }}
                    aria-label="إزالة"
                    className="rounded border border-border p-1 text-red-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {members.length === 0 ? <p className="mt-3 text-sm text-text-muted">لا أعضاء.</p> : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}

// ── Roles ────────────────────────────────────────────────────────────────

const VERBS = [
  { bit: 1, label: 'استعراض' },
  { bit: 2, label: 'قراءة' },
  { bit: 4, label: 'رفع' },
  { bit: 8, label: 'تعديل البيانات' },
  { bit: 16, label: 'حذف' },
  { bit: 32, label: 'إدارة الصلاحيات' },
];

function RolesTab() {
  const [roles, setRoles] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', bits: 3 });
  const [busy, setBusy] = useState(false);

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

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.admin.createRole({ name: form.name.trim(), permissionBits: form.bits });
      setForm({ name: '', bits: 3 });
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!roles) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="info">
        الدور قالب: تُنسخ صلاحياته عند المنح ولا تتغير المنوحات السابقة إذا عُدّل لاحقاً.
      </Alert>

      <Card className="p-4">
        <form onSubmit={create} className="space-y-3">
          <TextField
            label="دور جديد"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            className="max-w-xs"
          />
          <div className="flex flex-wrap gap-3">
            {VERBS.map((verb) => (
              <label key={verb.bit} className="flex items-center gap-1.5 text-sm text-text">
                <input
                  type="checkbox"
                  checked={(form.bits & verb.bit) !== 0}
                  onChange={() => setForm({ ...form, bits: form.bits ^ verb.bit })}
                />
                {verb.label}
              </label>
            ))}
          </div>
          <Button type="submit" icon={Plus} disabled={busy || !form.name.trim() || form.bits === 0}>
            إنشاء الدور
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3 text-right font-semibold">الاسم</th>
              <th className="px-4 py-3 text-right font-semibold">الصلاحيات</th>
              <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {roles.map((role) => (
              <tr key={role.roleId} className="hover:bg-surface-muted/30">
                <td className="px-4 py-3 text-right font-medium text-text">
                  {role.name}
                  {role.isSystem ? (
                    <span className="me-2 text-[11px] text-text-muted">(نظامي)</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right text-text-muted">
                  {VERBS.filter((v) => (role.permissionBits & v.bit) !== 0)
                    .map((v) => v.label)
                    .join('، ') || '—'}
                </td>
                <td className="px-4 py-3 text-center">
                  {role.isSystem ? (
                    <span className="text-xs text-text-muted">—</span>
                  ) : (
                    <button
                      onClick={async () => {
                        if (!window.confirm(`حذف الدور ${role.name}؟`)) return;
                        await api.admin.deleteRole(role.roleId);
                        await load();
                      }}
                      aria-label="حذف"
                      className="rounded border border-border p-1 text-red-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {roles.length === 0 ? <EmptyState icon={KeyRound} title="لا توجد أدوار بعد" /> : null}
      </Card>
    </div>
  );
}

// ── Shared ───────────────────────────────────────────────────────────────

function SmallButton({ icon: Icon, label, danger, ...props }) {
  return (
    <button
      title={label}
      aria-label={label}
      className={`rounded border border-border p-1.5 transition-colors ${
        danger
          ? 'text-red-400 hover:bg-red-50 hover:text-red-600'
          : 'text-text-muted hover:bg-primary/10 hover:text-primary'
      } disabled:opacity-40`}
      {...props}
    >
      <Icon size={14} />
    </button>
  );
}

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
      weak_password: `كلمة المرور ضعيفة: ${(caught.problems ?? []).join(' ')}`,
      cycle: 'لا يمكن إنشاء حلقة بين المجموعات.',
      last_super_admin: 'لا يمكن تعطيل آخر مدير نظام نشط.',
      cannot_demote_self: 'لا يمكنك إلغاء صفة المدير عن نفسك.',
      system_role: 'لا يمكن تعديل دور نظامي.',
      forbidden: 'لا تملك صلاحية لهذه العملية.',
      not_found: 'العنصر غير موجود.',
    }[caught.code] ?? 'تعذر إتمام العملية.'
  );
}
