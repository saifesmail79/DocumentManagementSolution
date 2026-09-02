import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, BarChart3, GitBranch, KeyRound, Plus, Save, Trash2, Webhook } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatBytes } from '../format.js';
import { Button, Card, Spinner, Alert, TextField, EmptyState, CopyField } from './ui.jsx';
import TabIntro from './TabIntro.jsx';
import HelpTip from './HelpTip.jsx';
import { WEBHOOK_EVENT_HELP, APPROVAL_STEP_HELP } from '../help/content.js';
import { useDialogs } from './DialogProvider.jsx';
import { Modal } from './Modal.jsx';
import ExpandableActions from './ExpandableActions.jsx';

/**
 * The administration tabs that came with Tier 2 and 3: API keys, webhooks,
 * approval templates and the reporting dashboard.
 */

// ── Shared error translation ──────────────────────────────────────────────

/*
 * Maps every server reason code this file handles to its Arabic string.
 *
 * Each tab had its own inline if-chain that covered only the codes it
 * happened to test for, so unknown codes were silently discarded. One
 * central helper that falls through to the supplied fallback is cleaner and
 * makes it impossible to miss a new code by forgetting to update every
 * copy-paste site.
 */
function describeError(caught, fallback) {
  if (!(caught instanceof ApiError)) return fallback;
  const MAP = {
    invalid_name:   'الاسم غير صالح.',
    unknown_user:   'المستخدم المختار غير موجود أو معطّل.',
    invalid_url:    'العنوان غير صالح.',
    no_events:      'اختر حدثاً واحداً على الأقل.',
    name_taken:     'الاسم مستخدم بالفعل.',
    steps_required: 'أضف خطوة واحدة على الأقل.',
    unknown_approver: 'أحد المعتمِدين غير موجود.',
    template_in_use:  'للمسار طلبات قائمة؛ لا تُعدَّل خطواته ولا يُحذف حتى تُغلق.',
    invalid_expiry: 'تاريخ الانتهاء يجب أن يكون في المستقبل.',
    not_found:  'العنصر غير موجود.',
    forbidden:  'لا تملك صلاحية لهذه العملية.',
  };
  return MAP[caught.code] ?? fallback;
}

/** Today as YYYY-MM-DD in the browser's own calendar, for a date input's `min`. */
function localDateString(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// ── API keys ─────────────────────────────────────────────────────────────

export function ApiKeysTab() {
  const { confirm } = useDialogs();
  const [keys, setKeys] = useState(null);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: '', userId: '', expiresAt: '' });
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [keyList, userList] = await Promise.all([api.apiKeys(), api.admin.users()]);
      setKeys(keyList.keys);
      setUsers(userList.filter((u) => u.isActive));
    } catch {
      setError('تعذر تحميل المفاتيح.');
      setKeys([]);
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
      const body = { name: form.name.trim(), userId: form.userId };
      // The Date constructor reads a bare datetime as local time; toISOString()
      // converts it to UTC, so the server's timezone does not affect which
      // calendar day the key expires — the user gets the full day they chose.
      if (form.expiresAt) body.expiresAt = new Date(`${form.expiresAt}T23:59:59.999`).toISOString();
      const result = await api.createApiKey(body);
      // Shown once. Only the hash is stored, so it cannot be retrieved later.
      setIssued(result.key);
      setForm({ name: '', userId: '', expiresAt: '' });
      await load();
    } catch (caught) {
      setError(describeError(caught, 'تعذر إنشاء المفتاح.'));
    } finally {
      setBusy(false);
    }
  }

  if (!keys) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.keys" />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="info">
        يعمل المفتاح بصلاحيات المستخدم المرتبط به، لا بصلاحيات منفصلة — لمعرفة ما يصل إليه
        تكامل معيّن، انظر إلى حساب المستخدم نفسه.
      </Alert>

      {issued ? (
        <Alert tone="success">
          <div className="space-y-1.5">
            <p className="text-xs">المفتاح يُعرض مرة واحدة فقط. انسخه الآن:</p>
            <CopyField value={issued} label="نسخ المفتاح" />
          </div>
        </Alert>
      ) : null}

      <Card className="p-4">
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-4">
          <TextField
            label="اسم المفتاح"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">يعمل بصلاحيات</span>
            <select
              value={form.userId}
              onChange={(event) => setForm({ ...form, userId: event.target.value })}
              required
              className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm"
            >
              <option value="">اختر مستخدماً…</option>
              {users.map((user) => (
                <option key={user.userId} value={user.userId}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>
          {/* Optional expiry — we send an ISO instant (local end-of-day → UTC)
              so the server's timezone does not affect the chosen calendar day.
              min prevents picking a date that is already in the past. It is the
              LOCAL date: toISOString() alone gives the UTC day, which in the
              evening west of Greenwich is already tomorrow and would refuse
              "today". */}
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">ينتهي في</span>
            <input
              type="date"
              value={form.expiresAt}
              min={localDateString()}
              onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              className="rounded-lg border border-border bg-control px-2 py-2 text-sm"
            />
          </label>
          <div className="flex items-end">
            <Button type="submit" icon={Plus} disabled={busy || !form.name.trim() || !form.userId}>
              إنشاء
            </Button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3 text-right font-semibold">الاسم</th>
              <th className="px-4 py-3 text-right font-semibold">البادئة</th>
              <th className="px-4 py-3 text-right font-semibold">يعمل بصلاحيات</th>
              <th className="px-4 py-3 text-left font-semibold">آخر استخدام</th>
              <th className="px-4 py-3 text-left font-semibold">ينتهي</th>
              <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {keys.map((key) => {
              const isExpired = !key.revoked && !!key.expiresAt && new Date(key.expiresAt) < new Date();
              return (
                <tr key={key.keyId} className={key.revoked || isExpired ? 'opacity-60' : ''}>
                  <td className="px-4 py-3 text-right font-medium text-text">{key.name}</td>
                  <td className="px-4 py-3 text-right" dir="ltr">
                    <code className="text-[11px]">{key.prefix}…</code>
                  </td>
                  <td className="px-4 py-3 text-right text-text-muted">{key.actsAs}</td>
                  <td className="num px-4 py-3 text-left text-text-muted">
                    {key.lastUsedAt ? formatDate(key.lastUsedAt) : '—'}
                  </td>
                  <td className="num px-4 py-3 text-left text-text-muted">
                    {key.expiresAt ? formatDate(key.expiresAt) : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {key.revoked ? (
                      <span className="text-xs text-text-muted">مُبطل</span>
                    ) : isExpired ? (
                      <span className="text-xs text-amber-600">منتهٍ</span>
                    ) : (
                      // Row menu is the standard — no bare icon buttons.
                      <ExpandableActions
                        customActions={[
                          {
                            key: 'revoke',
                            icon: Ban,
                            title: 'إبطال',
                            bgClass: 'bg-red-500/10',
                            textClass: 'text-red-600',
                            hoverClass: 'hover:bg-red-500/20',
                            onClick: async () => {
                              const confirmed = await confirm({
                                title: 'إبطال المفتاح',
                                message: `سيتوقف المفتاح "${key.name}" عن العمل فوراً.`,
                                detail: 'أي نظام يستعمل هذا المفتاح سيفقد وصوله حالاً. لا يمكن التراجع — الحل بعدها إصدار مفتاح جديد.',
                                confirmLabel: 'إبطال',
                                variant: 'danger',
                              });
                              if (!confirmed) return;
                              try {
                                await api.revokeApiKey(key.keyId);
                                await load();
                              } catch (caught) {
                                setError(describeError(caught, 'تعذر إبطال المفتاح.'));
                              }
                            },
                          },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {keys.length === 0 ? <EmptyState icon={KeyRound} title="لا توجد مفاتيح" /> : null}
      </Card>
    </div>
  );
}

// ── Webhooks ─────────────────────────────────────────────────────────────

/*
 * The event checkbox grid is used in two places — the create form and the
 * edit dialog — so pulling it into its own component keeps the two grids
 * consistent without copy-pasting the labelling logic.
 */
function EventPicker({ events, selected, onChange }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-text">الأحداث المشترَك بها</legend>
      {/*
        Arabic labels with the identifier beneath, not the bare identifier.

        This rendered `document.version_added` and five siblings as the only
        thing on the checkbox, so choosing which events to receive meant
        reading English dotted names and guessing at the difference between
        "updated" and "version_added" — which is precisely the distinction
        that decides whether a webhook fires on a metadata edit or on new
        content. The name still shows, small, because it is what appears in
        the payload the receiving system has to switch on.
      */}
      <div className="grid gap-2 sm:grid-cols-2">
        {events.map((name) => {
          const described = WEBHOOK_EVENT_HELP[name];
          const checked = selected.includes(name);
          return (
            <label
              key={name}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 transition-colors ${
                checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-surface-muted/40'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checked}
                onChange={() =>
                  onChange(checked ? selected.filter((e) => e !== name) : [...selected, name])
                }
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-text">
                  {described?.label ?? name}
                </span>
                {described ? (
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
                    {described.help}
                  </span>
                ) : null}
                <code dir="ltr" className="mt-0.5 block text-[10px] text-text-muted/70">
                  {name}
                </code>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/*
 * The signing secret stays on the server; editing name, URL or events does
 * not expose or rotate it, and a subtitle says so to prevent confusion.
 */
function WebhookDialog({ open, hook, events, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', url: '', events: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Seed form from the hook being edited each time the dialog opens.
  useEffect(() => {
    if (open && hook) {
      setForm({ name: hook.name, url: hook.url, events: [...hook.events] });
      setError(null);
    }
  }, [open, hook]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateWebhook(hook.webhookId, form);
      onSave();
      onClose();
    } catch (caught) {
      setError(describeError(caught, 'تعذر حفظ الويب هوك.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="تعديل الويب هوك"
      subtitle="سر التوقيع لا يتغيّر بالتعديل."
      icon={Webhook}
      size="md"
      footer={
        <>
          <Button
            icon={Save}
            onClick={save}
            disabled={busy || !form.name.trim() || !form.url.trim() || !form.events.length}
          >
            حفظ
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="الاسم"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <TextField
            label="العنوان"
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
            dir="ltr"
            placeholder="https://…"
          />
        </div>
        <EventPicker
          events={events}
          selected={form.events}
          onChange={(next) => setForm({ ...form, events: next })}
        />
      </div>
    </Modal>
  );
}

export function WebhooksTab() {
  const { confirm } = useDialogs();
  const [webhooks, setWebhooks] = useState(null);
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState({ name: '', url: '', events: [] });
  const [secret, setSecret] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editingHook, setEditingHook] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.webhooks();
      setWebhooks(result.webhooks);
      setEvents(result.events);
    } catch {
      setWebhooks([]);
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
      const result = await api.createWebhook(form);
      setSecret(result.secret);
      setForm({ name: '', url: '', events: [] });
      await load();
    } catch (caught) {
      setError(describeError(caught, 'تعذر إنشاء الويب هوك.'));
    } finally {
      setBusy(false);
    }
  }

  if (!webhooks) return <Spinner />;

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.webhooks" />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {secret ? (
        <Alert tone="success">
          <p className="mb-1.5 text-xs">
            سر التوقيع يُعرض مرة واحدة — استخدمه للتحقق من صحة الطلبات الواردة:
          </p>
          <CopyField value={secret} label="نسخ سر التوقيع" />
        </Alert>
      ) : null}

      <Card className="p-4">
        <form onSubmit={create} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="الاسم"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
            <TextField
              label="العنوان"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
              dir="ltr"
              placeholder="https://…"
              required
            />
          </div>

          <EventPicker
            events={events}
            selected={form.events}
            onChange={(next) => setForm({ ...form, events: next })}
          />

          <Button type="submit" icon={Plus} disabled={busy}>
            إنشاء
          </Button>
        </form>
      </Card>

      <WebhookDialog
        open={Boolean(editingHook)}
        hook={editingHook}
        events={events}
        onClose={() => setEditingHook(null)}
        onSave={load}
      />

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3 text-right font-semibold">الاسم</th>
              <th className="px-4 py-3 text-right font-semibold">العنوان</th>
              <th className="px-4 py-3 text-left font-semibold">نجح</th>
              <th className="px-4 py-3 text-left font-semibold">فشل</th>
              <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {webhooks.map((hook) => (
              <tr key={hook.webhookId} className={!hook.isActive ? 'opacity-60' : ''}>
                <td className="px-4 py-3 text-right font-medium text-text">
                  <span className="flex items-center gap-2">
                    {hook.name}
                    {/* A paused hook is shown muted with a badge so it does
                        not look identical to an active one. */}
                    {!hook.isActive ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        موقوف
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] text-text-muted" dir="ltr">
                    {hook.events.join(', ')}
                  </span>
                </td>
                <td className="max-w-xs truncate px-4 py-3 text-right text-text-muted" dir="ltr">
                  {hook.url}
                </td>
                <td className="num px-4 py-3 text-left text-green-600">{hook.delivered}</td>
                {/* A webhook pointing at a dead host should be visibly failing
                    here rather than retrying quietly forever. */}
                <td className={`num px-4 py-3 text-left ${hook.failed > 0 ? 'text-red-600' : 'text-text-muted'}`}>
                  {hook.failed}
                </td>
                <td className="px-4 py-3 text-center">
                  {/* Row menu is the standard — no bare icon buttons. */}
                  <ExpandableActions
                    isActive={hook.isActive}
                    onEdit={() => setEditingHook(hook)}
                    onToggleActive={async () => {
                      if (hook.isActive) {
                        const confirmed = await confirm({
                          title: 'إيقاف الويب هوك',
                          message: `إيقاف "${hook.name}"`,
                          detail: 'يتوقف إرسال الأحداث إليه فوراً ويبقى سر التوقيع محفوظاً؛ يمكن استئنافه في أي وقت.',
                          confirmLabel: 'إيقاف',
                          variant: 'warning',
                        });
                        if (!confirmed) return;
                      }
                      try {
                        await api.setWebhookActive(hook.webhookId, !hook.isActive);
                        await load();
                      } catch (caught) {
                        setError(describeError(caught, 'تعذر تغيير حالة الويب هوك.'));
                      }
                    }}
                    onDelete={async () => {
                      const confirmed = await confirm({
                        title: 'حذف الويب هوك',
                        message: `سيتوقف إرسال الأحداث إلى "${hook.name}".`,
                        detail: 'سر التوقيع يُفقد معه ولا يمكن استرجاعه.',
                        confirmLabel: 'حذف',
                        variant: 'danger',
                      });
                      if (!confirmed) return;
                      try {
                        await api.deleteWebhook(hook.webhookId);
                        await load();
                      } catch (caught) {
                        setError(describeError(caught, 'تعذر حذف الويب هوك.'));
                      }
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {webhooks.length === 0 ? <EmptyState icon={Webhook} title="لا توجد ويب هوكس" /> : null}
      </Card>
    </div>
  );
}

// ── Approval templates ───────────────────────────────────────────────────

const BLANK_FORM = { name: '', typeId: '', steps: [{ approverId: '', requireAll: false, slaHours: '' }] };

export function ApprovalTemplatesTab() {
  const { confirm } = useDialogs();
  const [templates, setTemplates] = useState(null);
  const [types, setTypes] = useState([]);
  const [principals, setPrincipals] = useState([]);
  const [form, setForm] = useState(BLANK_FORM);
  // The template being edited, or null when the form is in create mode.
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Used to scroll the form card into view when edit mode is entered.
  const formRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [templateList, typeList, principalList] = await Promise.all([
        api.approvalTemplates(),
        api.metadata.types(),
        api.admin.principals(''),
      ]);
      setTemplates(templateList.templates);
      setTypes(typeList.types);
      setPrincipals(principalList.principals);
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit(template) {
    setEditing(template);
    setForm({
      name: template.name,
      typeId: String(template.typeId ?? ''),
      steps: template.steps.map((step) => ({
        approverId: String(step.approverId ?? ''),
        requireAll: step.requireAll,
        slaHours: step.slaHours != null ? String(step.slaHours) : '',
      })),
    });
    // Bring the form into view so the user sees it activate.
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(BLANK_FORM);
    setError(null);
  }

  function buildSteps() {
    return form.steps
      .filter((step) => step.approverId)
      .map((step) => ({
        approverId: step.approverId,
        requireAll: step.requireAll,
        slaHours: step.slaHours ? Number(step.slaHours) : null,
      }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const body = {
          name: form.name.trim(),
          typeId: form.typeId ? Number(form.typeId) : null,
        };
        // Steps are locked while the template has pending requests — the server
        // rejects them and the UI hides the section, so we simply omit them.
        if (!editing.pendingRequests) {
          body.steps = buildSteps();
        }
        await api.updateApprovalTemplate(editing.templateId, body);
        cancelEdit();
      } else {
        await api.createApprovalTemplate({
          name: form.name.trim(),
          typeId: form.typeId ? Number(form.typeId) : null,
          steps: buildSteps(),
        });
        setForm(BLANK_FORM);
      }
      await load();
    } catch (caught) {
      setError(describeError(caught, editing ? 'تعذر حفظ المسار.' : 'تعذر إنشاء المسار.'));
    } finally {
      setBusy(false);
    }
  }

  if (!templates) return <Spinner />;

  const stepsLocked = Boolean(editing?.pendingRequests);

  return (
    <div className="space-y-3">
      <TabIntro topic="admin.approvals" />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="info">
        المسار خطي: تنتقل الوثيقة من خطوة إلى التي تليها، ورفض واحد ينهي الطلب كله.
        اربط المسار بنوع وثيقة ليُقترح تلقائياً.
      </Alert>

      <div ref={formRef}>
        <Card className="p-4">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="اسم المسار"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text">نوع الوثيقة (اختياري)</span>
                <select
                  value={form.typeId}
                  onChange={(event) => setForm({ ...form, typeId: event.target.value })}
                  className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm"
                >
                  <option value="">بدون ربط</option>
                  {types.map((type) => (
                    <option key={type.typeId} value={type.typeId}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/*
              The steps were already buildable, but nothing on screen said so: they
              appeared as unlabelled grey strips and the only way to add one was a
              secondary button at the very bottom, past the submit. Naming the
              section, numbering the steps and putting "add" at the top of the list
              is the difference between a feature that exists and one that is found.
            */}
            <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
              <h4 className="flex items-center gap-1 text-sm font-medium text-text">
                {editing ? (
                  <>تعديل المسار: {editing.name}</>
                ) : (
                  <>
                    خطوات الاعتماد
                    <span className="num text-xs text-text-muted">({form.steps.length})</span>
                  </>
                )}
              </h4>
              {/* The add-step button is hidden while steps are locked, since the
                  section is disabled and adding to it would be misleading. */}
              {!stepsLocked ? (
                <Button
                  type="button"
                  variant="secondary"
                  icon={Plus}
                  className="!px-3 !py-1 text-xs"
                  onClick={() =>
                    setForm({
                      ...form,
                      steps: [...form.steps, { approverId: '', requireAll: false, slaHours: '' }],
                    })
                  }
                >
                  إضافة خطوة
                </Button>
              ) : null}
            </div>

            {stepsLocked ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-600">
                لا تُعدَّل الخطوات ما دام للمسار طلبات قائمة ({editing.pendingRequests}).
              </p>
            ) : (
              <p className="text-xs text-text-muted">
                تسير الوثيقة في الخطوات بالترتيب المعروض. رفض في أي خطوة ينهي الطلب كله.
              </p>
            )}

            {form.steps.map((step, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-muted/40 p-2">
                <span className="num pb-2 text-xs font-medium text-text-muted">{index + 1}.</span>

                <label className="block min-w-[12rem] flex-1">
                  <span className="mb-1 flex items-center gap-1 text-xs text-text-muted">
                    المعتمِد
                    <HelpTip text={APPROVAL_STEP_HELP.approver} label="شرح: المعتمِد" />
                  </span>
                  <select
                    value={step.approverId}
                    disabled={stepsLocked}
                    onChange={(event) => {
                      const steps = [...form.steps];
                      steps[index] = { ...step, approverId: event.target.value };
                      setForm({ ...form, steps });
                    }}
                    className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm disabled:opacity-60"
                  >
                    <option value="">اختر…</option>
                    {principals.map((principal) => (
                      <option key={principal.principalId} value={principal.principalId}>
                        {principal.displayName}
                        {principal.type === 'group' ? ' (مجموعة)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <span className="flex items-center gap-1 pb-2">
                  <label className="flex items-center gap-1.5 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={step.requireAll}
                      disabled={stepsLocked}
                      onChange={(event) => {
                        const steps = [...form.steps];
                        steps[index] = { ...step, requireAll: event.target.checked };
                        setForm({ ...form, steps });
                      }}
                    />
                    موافقة الجميع
                  </label>
                  <HelpTip text={APPROVAL_STEP_HELP.requireAll} label="شرح: موافقة الجميع" />
                </span>

                <label className="block w-28">
                  <span className="mb-1 flex items-center gap-1 text-xs text-text-muted">
                    مهلة (ساعات)
                    <HelpTip text={APPROVAL_STEP_HELP.slaHours} label="شرح: المهلة" />
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    value={step.slaHours}
                    disabled={stepsLocked}
                    onChange={(event) => {
                      const steps = [...form.steps];
                      steps[index] = { ...step, slaHours: event.target.value };
                      setForm({ ...form, steps });
                    }}
                    className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm disabled:opacity-60"
                  />
                </label>

                {/* Remove button hidden when steps are locked, matching the hidden
                    add button above — presenting a disabled remove with no add
                    would suggest a way to shrink the list that isn't really there. */}
                {form.steps.length > 1 && !stepsLocked ? (
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, steps: form.steps.filter((_, n) => n !== index) })}
                    aria-label="إزالة الخطوة"
                    className="rounded border border-border p-2 text-text-muted hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            ))}

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                icon={editing ? Save : Plus}
                disabled={busy || !form.name.trim() || (!stepsLocked && !form.steps.some((step) => step.approverId))}
              >
                {editing ? 'حفظ' : 'إنشاء المسار'}
              </Button>
              {editing ? (
                <Button type="button" variant="secondary" onClick={cancelEdit} disabled={busy}>
                  إلغاء
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      </div>

      <div className="space-y-2">
        {templates.map((template) => (
          <Card
            key={template.templateId}
            className={`p-4 ${!template.isActive ? 'opacity-60' : ''}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                  {template.name}
                  {template.typeName ? (
                    <span className="text-xs text-text-muted">· {template.typeName}</span>
                  ) : null}
                  {/* Inactive templates carry a badge so they don't look
                      identical to active ones that happen to be muted. */}
                  {!template.isActive ? (
                    <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                      معطّل
                    </span>
                  ) : null}
                  {/* Pending request count informs the admin before they try
                      to delete or edit steps. */}
                  {template.pendingRequests > 0 ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      {template.pendingRequests} طلب قائم
                    </span>
                  ) : null}
                </p>
                <ol className="mt-1 space-y-0.5">
                  {template.steps.map((step) => (
                    <li key={step.stepId} className="text-xs text-text-muted">
                      {step.order}. {step.approver}
                      {step.requireAll ? ' — موافقة الجميع' : ''}
                      {step.slaHours ? ` — مهلة ${step.slaHours} ساعة` : ''}
                    </li>
                  ))}
                </ol>
              </div>
              {/* Row menu is the standard — no bare icon buttons. */}
              <ExpandableActions
                isActive={template.isActive}
                canDelete={template.pendingRequests === 0}
                deleteHint="له طلبات قائمة؛ عطّله بدلاً من حذفه"
                onEdit={() => startEdit(template)}
                onToggleActive={async () => {
                  if (template.isActive) {
                    const confirmed = await confirm({
                      title: 'تعطيل مسار الاعتماد',
                      message: `تعطيل "${template.name}"`,
                      detail: 'لن يُقترح المسار تلقائياً ولن يُبدأ به طلب جديد؛ الطلبات القائمة تكمل سيرها.',
                      confirmLabel: 'تعطيل',
                      variant: 'warning',
                    });
                    if (!confirmed) return;
                  }
                  try {
                    await api.setApprovalTemplateActive(template.templateId, !template.isActive);
                    await load();
                  } catch (caught) {
                    setError(describeError(caught, 'تعذر تغيير حالة المسار.'));
                  }
                }}
                onDelete={async () => {
                  const confirmed = await confirm({
                    title: 'حذف مسار الاعتماد',
                    message: `سيُحذف المسار "${template.name}" وخطواته.`,
                    detail: 'الطلبات القائمة على هذا المسار تمنع حذفه حتى تُغلق.',
                    confirmLabel: 'حذف',
                    variant: 'danger',
                  });
                  if (!confirmed) return;
                  try {
                    await api.deleteApprovalTemplate(template.templateId);
                    await load();
                  } catch (caught) {
                    setError(describeError(caught, 'تعذر حذف المسار.'));
                  }
                }}
              />
            </div>
          </Card>
        ))}
        {templates.length === 0 ? <EmptyState icon={GitBranch} title="لا توجد مسارات اعتماد" /> : null}
      </div>
    </div>
  );
}

// ── Reporting dashboard ──────────────────────────────────────────────────

export function ReportsTab() {
  const [data, setData] = useState(null);

  useEffect(() => {
    Promise.all([
      api.reports.overview(),
      api.reports.trend(30),
      api.reports.storage(),
      api.reports.contributors(30),
      api.reports.distribution(),
    ])
      .then(([overview, trend, storage, contributors, distribution]) =>
        setData({ overview, trend: trend.trend, storage: storage.folders, contributors: contributors.contributors, distribution }),
      )
      .catch(() => setData({ error: true }));
  }, []);

  if (!data) return <Spinner />;
  if (data.error) {
    return (
      <div className="space-y-3">
        <TabIntro topic="admin.reports" />
        <Alert tone="error">تعذر تحميل التقارير.</Alert>
      </div>
    );
  }

  const peak = Math.max(1, ...data.trend.map((point) => point.count));

  return (
    <div className="space-y-4">
      <TabIntro topic="admin.reports" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="الوثائق" value={data.overview.documents} />
        <Stat label="الإصدارات" value={data.overview.versions} />
        <Stat label="المساحة" value={formatBytes(data.overview.bytes)} raw />
        <Stat label="المستخدمون النشطون" value={data.overview.activeUsers} />
        <Stat label="جلسات مفتوحة" value={data.overview.liveSessions} />
        <Stat label="اعتمادات معلّقة" value={data.overview.pendingApprovals} />
        <Stat label="تحت حجز قانوني" value={data.overview.onLegalHold} />
        <Stat label="تنتهي خلال ٣٠ يوماً" value={data.overview.expiringSoon} tone="warn" />
      </div>

      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
          <BarChart3 size={15} className="text-primary" />
          الرفع خلال ٣٠ يوماً
        </h3>
        {/* A plain bar row rather than a charting library: one series of thirty
            values does not justify shipping one. */}
        <div className="flex h-24 items-end gap-0.5" dir="ltr">
          {data.trend.map((point) => (
            <div
              key={point.day}
              title={`${point.day}: ${point.count}`}
              style={{ height: `${(point.count / peak) * 100}%` }}
              className="min-h-[2px] flex-1 rounded-t bg-primary/70"
            />
          ))}
        </div>
        {data.trend.length === 0 ? <p className="text-xs text-text-muted">لا توجد بيانات.</p> : null}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-text">المجلدات الأكبر</h3>
          <ul className="space-y-1">
            {data.storage.slice(0, 8).map((folder) => (
              <li key={folder.folderId} className="flex items-center justify-between text-xs">
                <span className="truncate text-text">{folder.name}</span>
                <span className="num text-text-muted">
                  {formatBytes(folder.bytes)} · {folder.documents}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-text">الأكثر نشاطاً</h3>
          <ul className="space-y-1">
            {data.contributors.map((contributor) => (
              <li key={contributor.actor} className="flex items-center justify-between text-xs">
                <span className="truncate text-text">{contributor.actor}</span>
                <span className="num text-text-muted">
                  {contributor.uploads} رفع · {contributor.downloads} فتح
                </span>
              </li>
            ))}
          </ul>
          {data.contributors.length === 0 ? (
            <p className="text-xs text-text-muted">لا توجد بيانات.</p>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-text">حسب النوع</h3>
          <ul className="space-y-1">
            {data.distribution.byType.map((entry) => (
              <li key={entry.name} className="flex items-center justify-between text-xs">
                <span className="truncate text-text">{entry.name}</span>
                <span className="num text-text-muted">{entry.count}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-text">حسب الحالة</h3>
          <ul className="space-y-1">
            {data.distribution.byState.map((entry) => (
              <li key={entry.name} className="flex items-center justify-between text-xs">
                <span className="text-text">{entry.name}</span>
                <span className="num text-text-muted">{entry.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <a
        href={api.exportCsvUrl()}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2
          text-sm text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"
      >
        تصدير البيانات الوصفية (CSV)
      </a>
    </div>
  );
}

function Stat({ label, value, tone, raw }) {
  const tones = { warn: 'text-amber-600', bad: 'text-red-600' };
  return (
    <Card className="p-4 text-center">
      <p className={`text-2xl font-semibold ${raw ? '' : 'num'} ${tones[tone] ?? 'text-text'}`}>{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </Card>
  );
}
