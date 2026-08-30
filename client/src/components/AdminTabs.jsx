import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, KeyRound, Webhook, Copy, GitBranch, BarChart3 } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatBytes } from '../format.js';
import { Button, Card, Spinner, Alert, TextField, EmptyState } from './ui.jsx';

/**
 * The administration tabs that came with Tier 2 and 3: API keys, webhooks,
 * approval templates and the reporting dashboard.
 */

// ── API keys ─────────────────────────────────────────────────────────────

export function ApiKeysTab() {
  const [keys, setKeys] = useState(null);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: '', userId: '' });
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
      const result = await api.createApiKey({ name: form.name.trim(), userId: form.userId });
      // Shown once. Only the hash is stored, so it cannot be retrieved later.
      setIssued(result.key);
      setForm({ name: '', userId: '' });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? 'تعذر إنشاء المفتاح.' : 'تعذر إنشاء المفتاح.');
    } finally {
      setBusy(false);
    }
  }

  if (!keys) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="info">
        يعمل المفتاح بصلاحيات المستخدم المرتبط به، لا بصلاحيات منفصلة — لمعرفة ما يصل إليه
        تكامل معيّن، انظر إلى حساب المستخدم نفسه.
      </Alert>

      {issued ? (
        <Alert tone="success">
          <div className="space-y-1">
            <p className="text-xs">المفتاح يُعرض مرة واحدة فقط. انسخه الآن:</p>
            <div className="flex items-center gap-1">
              <code dir="ltr" className="flex-1 truncate rounded bg-surface px-2 py-1 text-[11px]">
                {issued}
              </code>
              <button
                onClick={() => navigator.clipboard?.writeText(issued)}
                aria-label="نسخ"
                className="rounded border border-border p-1 hover:bg-primary/10"
              >
                <Copy size={12} />
              </button>
            </div>
          </div>
        </Alert>
      ) : null}

      <Card className="p-4">
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-3">
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
              <th className="px-4 py-3 text-center font-semibold">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {keys.map((key) => (
              <tr key={key.keyId} className={key.revoked ? 'opacity-50' : ''}>
                <td className="px-4 py-3 text-right font-medium text-text">{key.name}</td>
                <td className="px-4 py-3 text-right" dir="ltr">
                  <code className="text-[11px]">{key.prefix}…</code>
                </td>
                <td className="px-4 py-3 text-right text-text-muted">{key.actsAs}</td>
                <td className="num px-4 py-3 text-left text-text-muted">
                  {key.lastUsedAt ? formatDate(key.lastUsedAt) : '—'}
                </td>
                <td className="px-4 py-3 text-center">
                  {key.revoked ? (
                    <span className="text-xs text-text-muted">مُبطل</span>
                  ) : (
                    <button
                      onClick={async () => {
                        if (!window.confirm(`إبطال المفتاح "${key.name}"؟`)) return;
                        await api.revokeApiKey(key.keyId);
                        await load();
                      }}
                      aria-label="إبطال"
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
        {keys.length === 0 ? <EmptyState icon={KeyRound} title="لا توجد مفاتيح" /> : null}
      </Card>
    </div>
  );
}

// ── Webhooks ─────────────────────────────────────────────────────────────

export function WebhooksTab() {
  const [webhooks, setWebhooks] = useState(null);
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState({ name: '', url: '', events: [] });
  const [secret, setSecret] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
      setError(
        caught instanceof ApiError && caught.code === 'invalid_url'
          ? 'العنوان غير صالح.'
          : caught instanceof ApiError && caught.code === 'no_events'
            ? 'اختر حدثاً واحداً على الأقل.'
            : 'تعذر إنشاء الويب هوك.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!webhooks) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      {secret ? (
        <Alert tone="success">
          <p className="text-xs">
            سر التوقيع يُعرض مرة واحدة — استخدمه للتحقق من صحة الطلبات الواردة:
          </p>
          <code dir="ltr" className="mt-1 block truncate rounded bg-surface px-2 py-1 text-[11px]">
            {secret}
          </code>
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

          <div className="flex flex-wrap gap-3">
            {events.map((name) => (
              <label key={name} className="flex items-center gap-1.5 text-xs text-text" dir="ltr">
                <input
                  type="checkbox"
                  checked={form.events.includes(name)}
                  onChange={() =>
                    setForm({
                      ...form,
                      events: form.events.includes(name)
                        ? form.events.filter((e) => e !== name)
                        : [...form.events, name],
                    })
                  }
                />
                {name}
              </label>
            ))}
          </div>

          <Button type="submit" icon={Plus} disabled={busy}>
            إنشاء
          </Button>
        </form>
      </Card>

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
              <tr key={hook.webhookId}>
                <td className="px-4 py-3 text-right font-medium text-text">
                  {hook.name}
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
                  <button
                    onClick={async () => {
                      if (!window.confirm(`حذف "${hook.name}"؟`)) return;
                      await api.deleteWebhook(hook.webhookId);
                      await load();
                    }}
                    aria-label="حذف"
                    className="rounded border border-border p-1 text-red-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
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

export function ApprovalTemplatesTab() {
  const [templates, setTemplates] = useState(null);
  const [types, setTypes] = useState([]);
  const [principals, setPrincipals] = useState([]);
  const [form, setForm] = useState({ name: '', typeId: '', steps: [{ approverId: '', requireAll: false, slaHours: '' }] });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createApprovalTemplate({
        name: form.name.trim(),
        typeId: form.typeId ? Number(form.typeId) : null,
        steps: form.steps
          .filter((step) => step.approverId)
          .map((step) => ({
            approverId: step.approverId,
            requireAll: step.requireAll,
            slaHours: step.slaHours ? Number(step.slaHours) : null,
          })),
      });
      setForm({ name: '', typeId: '', steps: [{ approverId: '', requireAll: false, slaHours: '' }] });
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'steps_required'
          ? 'أضف خطوة واحدة على الأقل.'
          : caught instanceof ApiError && caught.code === 'name_taken'
            ? 'الاسم مستخدم.'
            : 'تعذر إنشاء المسار.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!templates) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Alert tone="info">
        المسار خطي: تنتقل الوثيقة من خطوة إلى التي تليها، ورفض واحد ينهي الطلب كله.
        اربط المسار بنوع وثيقة ليُقترح تلقائياً.
      </Alert>

      <Card className="p-4">
        <form onSubmit={create} className="space-y-3">
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

          {form.steps.map((step, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-muted/40 p-2">
              <span className="num pb-2 text-xs text-text-muted">{index + 1}.</span>

              <label className="block min-w-[12rem] flex-1">
                <span className="mb-1 block text-xs text-text-muted">المعتمِد</span>
                <select
                  value={step.approverId}
                  onChange={(event) => {
                    const steps = [...form.steps];
                    steps[index] = { ...step, approverId: event.target.value };
                    setForm({ ...form, steps });
                  }}
                  className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm"
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

              <label className="flex items-center gap-1.5 pb-2 text-xs text-text">
                <input
                  type="checkbox"
                  checked={step.requireAll}
                  onChange={(event) => {
                    const steps = [...form.steps];
                    steps[index] = { ...step, requireAll: event.target.checked };
                    setForm({ ...form, steps });
                  }}
                />
                موافقة الجميع
              </label>

              <label className="block w-28">
                <span className="mb-1 block text-xs text-text-muted">مهلة (ساعات)</span>
                <input
                  dir="ltr"
                  value={step.slaHours}
                  onChange={(event) => {
                    const steps = [...form.steps];
                    steps[index] = { ...step, slaHours: event.target.value };
                    setForm({ ...form, steps });
                  }}
                  className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm"
                />
              </label>

              {form.steps.length > 1 ? (
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

          <div className="flex flex-row gap-2">
            <Button type="submit" icon={Plus} disabled={busy}>
              إنشاء المسار
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setForm({ ...form, steps: [...form.steps, { approverId: '', requireAll: false, slaHours: '' }] })
              }
            >
              خطوة إضافية
            </Button>
          </div>
        </form>
      </Card>

      <div className="space-y-2">
        {templates.map((template) => (
          <Card key={template.templateId} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-text">
                  {template.name}
                  {template.typeName ? (
                    <span className="me-2 text-xs text-text-muted">· {template.typeName}</span>
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
              <button
                onClick={async () => {
                  if (!window.confirm(`حذف المسار "${template.name}"؟`)) return;
                  try {
                    await api.deleteApprovalTemplate(template.templateId);
                    await load();
                  } catch {
                    setError('لا يمكن حذف مسار له طلبات قائمة.');
                  }
                }}
                aria-label="حذف"
                className="rounded border border-border p-1 text-red-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 size={14} />
              </button>
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
  if (data.error) return <Alert tone="error">تعذر تحميل التقارير.</Alert>;

  const peak = Math.max(1, ...data.trend.map((point) => point.count));

  return (
    <div className="space-y-4">
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
