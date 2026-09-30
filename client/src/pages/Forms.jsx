/**
 * إنشاء كتاب — making an official letter from an approved Word template.
 *
 * This is the outgoing half of «الوارد والصادر»: the letters we write, as
 * against the ones that arrive and are registered in /correspondence. The two
 * share one tab bar (`MailAreaNav`) so that issuing a reply is one press away
 * from the letter being replied to, instead of a trip back to the tile menu.
 *
 * ─── What this screen is, and what it deliberately is not ───────────────────
 *
 * It is a form over one template: fill the fields, name the letter, choose
 * where it is filed, press once. The merge, the conversion to PDF and the
 * filing all happen on the server in a single request, and the result is an
 * ordinary document — the same document any upload produces, in the same tree,
 * under the same permissions. There is no "letters" store and no second filing
 * path; `scanToPdf.js` states the reason in full, and it holds here: a second
 * way to file a document is a second place for the permission check to be
 * missing.
 *
 * It is not a template editor. Templates are Word files an administrator
 * uploads (الإدارة ← نماذج الكتب); this screen never touches one.
 *
 * ─── Why the date and the author are not fields ─────────────────────────────
 *
 * `#date#` / `#التاريخ#` and `#author#` / `#المنشئ#` (the Arabic names are
 * aliases of the same two built-ins) are filled by the server and stripped from
 * whatever this page sends, so an official letter cannot be dated or signed off
 * in someone else's name from the browser. They arrive marked `builtIn` and are
 * not rendered at all — an input the server ignores is worse than no input.
 *
 * ─── Why the destination is sometimes chosen for you ────────────────────────
 *
 * A template may be assigned to particular folders (الإدارة ← نماذج الكتب), and
 * then a letter from it may be filed into none but those: `generate` refuses
 * `folder_not_allowed` for anything else. The server sends those folders back
 * already narrowed to the ones this person may upload into, so this screen
 * hands that list to the picker and nothing else is offered. When exactly one
 * survives, it is chosen — there is no question left to ask — and the folder
 * remembered from the last letter is ignored, because a remembered folder is a
 * convenience and the assignment is a rule.
 *
 * A template assigned to no folder keeps the old behaviour: any folder the
 * person may upload into, starting from the one they used last.
 *
 * ─── Why the notice on a duplicate or a failed approval stays here ──────────
 *
 * On success the new document is opened, which is what someone pressing
 * «إنشاء الكتاب» wants. But two outcomes carry news worth reading — the bytes
 * matched a letter already in the folder, or the automatic approval did not
 * start — and `DocumentDetail` has no place to show a message handed to it
 * through navigation state. Rather than route a notice into a shared page that
 * would drop it, those two cases stay on this screen with the reason and a link
 * to the letter. Nothing is lost either way: the letter exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, FilePenLine, FileText, LayoutTemplate } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate } from '../format.js';
import { MODULES } from '../navigation.js';
import { Alert, Button, Card, EmptyState, Spinner, TextField } from '../components/ui.jsx';
import FormsFolderPicker from '../components/FormsFolderPicker.jsx';
import MailAreaNav from '../components/MailAreaNav.jsx';
import { useHelpTopic } from '../help/HelpContext.jsx';
import { useAuth } from '../auth.jsx';

/** The registry entry whose name this screen carries, so the two cannot drift. */
const FORMS = MODULES.find((module) => module.key === 'forms');

/*
 * Remembers the last destination, because letters of one kind go one place.
 *
 * Keyed per user: one browser is shared on a counter or a tablet, and the
 * previous person's «الصادر» is not this person's answer — nor necessarily a
 * folder they may file into at all.
 */
const LAST_FOLDER_KEY = 'forms.lastFolder';

function lastFolderKey(userId) {
  return userId ? `${LAST_FOLDER_KEY}:${userId}` : LAST_FOLDER_KEY;
}

function readLastFolder(userId) {
  try {
    return window.localStorage.getItem(lastFolderKey(userId)) ?? '';
  } catch {
    // Storage can be denied outright (private mode, a policy). Forgetting the
    // last folder is a smaller loss than a screen that will not render.
    return '';
  }
}

function rememberLastFolder(userId, folderId) {
  try {
    window.localStorage.setItem(lastFolderKey(userId), String(folderId));
  } catch {
    /* see readLastFolder */
  }
}

/*
 * Every refusal the generate route can answer with, in Arabic.
 *
 * A raw code on screen tells the reader nothing and tells the administrator
 * almost nothing either, so each one is a sentence that names what to do next.
 * The field-level refusals are separate because they must name the field's own
 * Arabic label, which the server sends back in `detail`.
 */
const GENERATE_ERRORS = {
  forms_disabled: 'وحدة النماذج معطّلة الآن. راجع مدير النظام.',
  template_inactive: 'هذا النموذج معطّل حالياً. اختر نموذجاً آخر أو راجع مدير النظام.',
  not_found: 'النموذج أو المجلد غير موجود، أو لا تملك صلاحية عليه. حدّث الصفحة وأعد المحاولة.',
  forbidden: 'لا تملك صلاحية «رفع» على المجلد المختار. اختر مجلداً آخر أو اطلب الصلاحية.',
  folder_not_allowed: 'هذا النموذج لا يودع في هذا المجلد. اختر مجلداً من القائمة.',
  busy: 'الخادم مشغول بتحويل كتب أخرى. أعد المحاولة بعد قليل.',
  libreoffice_missing:
    'التحويل إلى PDF غير متاح على الخادم (LibreOffice غير مثبّت). راجع مدير النظام قبل إعادة المحاولة.',
  template_missing: 'ملف النموذج غير موجود على الخادم أو تغيّر. راجع مدير النظام.',
  conversion_failed: 'تعذر تحويل النموذج إلى PDF. أبلغ مدير النظام باسم النموذج.',
  render_timeout: 'استغرق التحويل وقتاً أطول من المسموح. أعد المحاولة، وإن تكرر فأبلغ مدير النظام.',
  blocked_extension: 'صيغة PDF غير مسموح بها في إعدادات الرفع. راجع مدير النظام.',
  too_large: 'الكتاب الناتج أكبر من الحد المسموح به للرفع.',
  invalid_title: 'العنوان غير صالح — اكتب عنواناً لا يتجاوز ٥٠٠ حرف.',
  conflict: 'تغيّر شيء أثناء الحفظ. أعد المحاولة.',
  storage_failed: 'تعذر تخزين الكتاب. راجع مدير النظام.',
  fields_unlabelled: 'النموذج غير مكتمل الإعداد. راجع مدير النظام.',
  type_requires_fields: 'النموذج غير مكتمل الإعداد: نوع الوثيقة يطلب حقولاً لا يملؤها النموذج.',
};

/** A field refusal names the field, so its label is read out of `detail`. */
const FIELD_ERRORS = {
  missing_value: (label) => `الحقل «${label}» إلزامي.`,
  required_field: (label) => `الحقل «${label}» إلزامي.`,
  value_too_long: (label) => `القيمة في «${label}» أطول من الحد المسموح به.`,
  invalid_value: (label) => `القيمة في «${label}» غير صالحة. تحقق من صيغتها.`,
  unknown_placeholder: (label) => `الحقل «${label}» لم يعد موجوداً في النموذج. أعد فتح النموذج.`,
  field_unmappable: (label) => `الحقل «${label}» مرتبط بحقل لا يقبل الربط. راجع مدير النظام.`,
  field_not_in_type: (label) => `الحقل «${label}» مرتبط بحقل لا يتبع نوع الوثيقة. راجع مدير النظام.`,
};

function describeGenerateError(caught) {
  if (!(caught instanceof ApiError)) {
    return 'تعذر إنشاء الكتاب. تحقق من الاتصال بالشبكة وأعد المحاولة.';
  }

  const detail = caught.body?.detail;
  const named = FIELD_ERRORS[caught.code];
  if (named) {
    // `detail` is either { placeholder, label } for one field or a plain string
    // naming several; both shapes are handled rather than assumed.
    if (detail && typeof detail === 'object') return named(detail.label || detail.placeholder);
    if (typeof detail === 'string' && detail.trim()) return named(detail.trim());
    return named('المطلوب');
  }

  if (caught.code === 'duplicate') {
    const copies = caught.body?.duplicates ?? [];
    return copies.length
      ? `يوجد كتاب مطابق تماماً في المجلد نفسه: ${copies.map((copy) => copy.title).join('، ')}. `
        + 'غيّر شيئاً في القيم أو أودعه في مجلد آخر.'
      : 'يوجد كتاب مطابق تماماً في المجلد نفسه.';
  }

  return GENERATE_ERRORS[caught.code] ?? 'تعذر إنشاء الكتاب. أعد المحاولة، وإن تكرر فأبلغ مدير النظام.';
}

export default function Forms() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);

  useHelpTopic('forms');

  useEffect(() => {
    api.forms
      .status()
      // Failing to answer is read as "off": an empty form over a module that is
      // not running is the thing being avoided.
      .then((result) => setStatus(result ?? { enabled: false }))
      .catch(() => setStatus({ enabled: false }));
  }, []);

  if (!status) return <Spinner />;

  if (!status.enabled) {
    return (
      <EmptyState
        icon={LayoutTemplate}
        title="وحدة النماذج غير مفعّلة"
        hint={
          user.isSuperAdmin
            ? 'فعّلها من الإدارة ← الإعدادات (forms.enabled)، ثم ارفع النماذج من الإدارة ← نماذج الكتب.'
            : 'راجع مدير النظام إذا كانت مؤسستكم تعتمد نماذج كتب رسمية.'
        }
      />
    );
  }

  return <Composer ready={status.ready !== false} />;
}

// ── Picking a template, then filling it ──────────────────────────────────

function Composer({ ready }) {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  // The template being filled, loaded in full (with its fields). Null = the list.
  const [open, setOpen] = useState(null);
  const [opening, setOpening] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.forms.templates();
      setTemplates(result.templates ?? []);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'forms_disabled'
          ? 'عُطّلت وحدة النماذج قبل قليل. حدّث الصفحة.'
          : 'تعذر تحميل قائمة النماذج. حدّث الصفحة وحاول مجدداً.',
      );
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function pick(template) {
    setOpening(template.templateId);
    setError(null);
    try {
      const result = await api.forms.template(template.templateId);
      // The list row is kept underneath the detail, and the id is taken from the
      // row that was clicked: the detail payload's own copy is not depended on.
      setOpen({ ...template, ...result.template, templateId: String(template.templateId) });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'template_inactive'
          ? 'عُطّل هذا النموذج. اختر نموذجاً آخر.'
          : 'تعذر فتح النموذج. حدّث الصفحة وحاول مجدداً.',
      );
      await load();
    } finally {
      setOpening(null);
    }
  }

  if (!templates) return <Spinner />;

  if (open) {
    return (
      <FillForm
        template={open}
        ready={ready}
        onBack={() => {
          setOpen(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/*
        The area's own bar, above the screen's name: this page is one action of
        «الوارد والصادر», not a place of its own. It hides itself for a reader
        whose only entry here is this one — a lone tab is a label, not a choice.
      */}
      <MailAreaNav active="forms" />

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-text">
          <FilePenLine size={18} className="text-primary" />
          {FORMS.label}
        </h2>
        <p className="mt-0.5 text-sm text-text-muted">
          من نموذج معتمد: املأ الحقول فيولّد النظام الكتاب ويودعه في مجلده، ثم يُسجَّل صادراً من صفحته.
        </p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {!ready ? (
        <Alert tone="warning">
          التحويل إلى PDF غير متاح على الخادم حالياً (LibreOffice غير مثبّت أو غير مهيّأ)، فلا
          يمكن إنشاء كتاب. أبلغ مدير النظام.
        </Alert>
      ) : null}

      {templates.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="لا نماذج متاحة لك"
          hint="يرفع مدير النظام النماذج من الإدارة ← نماذج الكتب ويحدد من يحق له استخدام كل نموذج."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {templates.map((template) => (
            <Card key={template.templateId} className="flex flex-col gap-2 p-4">
              <div className="flex items-start gap-2">
                <FileText size={16} className="mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">{template.name}</p>
                  {template.typeName ? (
                    <p className="mt-0.5 text-xs text-text-muted">نوع الوثيقة: {template.typeName}</p>
                  ) : null}
                </div>
              </div>
              {template.description ? (
                <p className="text-xs leading-relaxed text-text-muted">{template.description}</p>
              ) : null}
              <div className="mt-auto pt-1">
                <Button
                  disabled={opening !== null}
                  onClick={() => pick(template)}
                  className="!px-3 !py-1.5 text-xs"
                >
                  {opening === template.templateId ? 'جارٍ الفتح…' : 'استخدم هذا النموذج'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── One field's control ──────────────────────────────────────────────────

/*
 * The control follows the field, not the other way round.
 *
 * A placeholder mapped to a date field gets a date input so the value the
 * server stores as a date is one the browser guarantees is a date; a number
 * mapping gets `type="text"` with `inputMode="decimal"`, per the interface
 * standards — `type="number"` silently drops what it cannot parse and hides a
 * mistyped figure instead of showing it. Both are `dir="ltr"` because their
 * contents are Latin digits. Everything else is Arabic prose and stays RTL.
 *
 * `maxLength` comes from the server: a placeholder mapped to a custom field is
 * bounded by that column (1000 characters), an unmapped one by the module's own
 * limit. Enforcing it in the control means the refusal never arrives after the
 * conversion has already run.
 */
function FieldControl({ field, value, onChange, disabled }) {
  const max = Number(field.maxLength) > 0 ? Number(field.maxLength) : null;
  const length = String(value ?? '').length;
  // Silent until it matters: a counter on every field is noise, a counter that
  // appears as the limit approaches is a warning.
  const counting = max !== null && length >= Math.floor(max * 0.8);

  const label = (
    <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text">
      {field.label || field.placeholder}
      {field.required ? <span className="text-red-600">*</span> : null}
      {counting ? (
        <span className="num ms-auto text-xs font-normal text-text-muted">{`${length}/${max}`}</span>
      ) : null}
    </span>
  );

  const shared = {
    value: value ?? '',
    onChange: (event) => onChange(event.target.value),
    disabled,
    ...(max !== null ? { maxLength: max } : {}),
  };

  if (field.multiline) {
    return (
      <label className="block">
        {label}
        <textarea
          dir="rtl"
          rows={4}
          placeholder="اكتب نص هذا الحقل"
          className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
            placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          {...shared}
        />
      </label>
    );
  }

  if (field.dataType === 'date') {
    return (
      <label className="block">
        {label}
        <input
          type="date"
          dir="ltr"
          className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
            focus:outline-none focus:ring-2 focus:ring-primary/40"
          {...shared}
        />
      </label>
    );
  }

  if (field.dataType === 'number') {
    return (
      <label className="block">
        {label}
        {/* type="text" with inputMode, per the interface standards: a number
            input discards what it cannot parse instead of showing it back. */}
        <input
          type="text"
          inputMode="decimal"
          dir="ltr"
          placeholder="0"
          className="num w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
            placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          {...shared}
        />
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input
        dir="rtl"
        placeholder="اكتب نص هذا الحقل"
        className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
          placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
        {...shared}
      />
    </label>
  );
}

// ── Filling one template ─────────────────────────────────────────────────

function FillForm({ template, ready, onBack }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.userId ?? null;

  // Only the fields a person fills. The built-in ones (date, author) are the
  // server's to write and are stripped there too, so there is nothing to show.
  const fields = useMemo(
    () => (template.fields ?? []).filter((field) => !field.builtIn),
    [template.fields],
  );

  /*
   * The folders this template may be filed into, already narrowed by the server
   * to the ones this person may upload into. Empty means "any folder they may
   * upload into", which is what the picker offers on its own.
   */
  const assigned = useMemo(
    () => (template.folders ?? []).map((folder) => String(folder.folderId)),
    [template.folders],
  );
  const restricted = assigned.length > 0;

  const [title, setTitle] = useState(`${template.name} — ${formatDate(new Date())}`);
  /*
   * A seed, not a decision.
   *
   * One assigned folder is the answer, so it is filled in. Several, and the
   * choice is made here — the folder remembered from the last letter is not
   * consulted, because it may not be among them. With none assigned the
   * remembered folder returns, and it may predate a permission change: the
   * picker reconciles whatever it is handed against what it can actually offer
   * (`clearWhenUnavailable`) and clears it if it cannot.
   */
  const [folderId, setFolderId] = useState(() => {
    if (restricted) return assigned.length === 1 ? assigned[0] : '';
    return readLastFolder(userId);
  });
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // A letter that was created but carries news: a duplicate, or an approval
  // that did not start. Holds { message, documentId }.
  const [outcome, setOutcome] = useState(null);
  // Guards against a second submission while the first is in the air, even if
  // the disabled attribute is bypassed (a double Enter on the form).
  const submitting = useRef(false);

  const missing = fields.filter(
    (field) => field.required && !String(values[field.placeholder] ?? '').trim(),
  );
  const blocked = busy || !ready || !title.trim() || !folderId || missing.length > 0;

  async function generate() {
    if (submitting.current || blocked) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setOutcome(null);

    try {
      const result = await api.forms.generate({
        templateId: String(template.templateId),
        folderId: String(folderId),
        title: title.trim(),
        values: Object.fromEntries(
          fields.map((field) => [field.placeholder, String(values[field.placeholder] ?? '')]),
        ),
      });

      // Remembered only for templates that accept any folder; where the
      // assignment decides, a remembered folder would be read back into a
      // screen that never offers it.
      if (!restricted) rememberLastFolder(userId, folderId);

      const notes = [];
      if (result.duplicateOf?.length) {
        notes.push(
          `أُنشئ الكتاب، ويوجد في المجلد نفسه كتاب مطابق تماماً: ${result.duplicateOf
            .map((copy) => copy.title)
            .join('، ')}.`,
        );
      }
      if (result.approval && result.approval.ok === false) {
        notes.push('أُنشئ الكتاب، لكن الاعتماد التلقائي لم يبدأ — ابدأه يدوياً من تبويب «الاعتماد».');
      }

      if (notes.length) {
        // Kept on this screen with a link: DocumentDetail has nowhere to show a
        // message handed over through navigation state.
        setOutcome({ message: notes.join(' '), documentId: String(result.documentId) });
        setBusy(false);
        submitting.current = false;
        return;
      }

      navigate(`/documents/${result.documentId}`);
    } catch (caught) {
      setError(describeGenerateError(caught));
      setBusy(false);
      submitting.current = false;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* RTL: ArrowRight reads as "back". */}
        {/*
          Names where it goes, not the screen it is on: «النماذج» here read as
          the administration tab that manages the templates, and «إنشاء كتاب» is
          what the reader is already doing.
        */}
        <Button variant="secondary" icon={ArrowRight} onClick={onBack} disabled={busy} className="!px-3 !py-1.5 text-xs">
          اختيار نموذج آخر
        </Button>
        <h2 className="text-lg font-semibold text-text">{template.name}</h2>
      </div>

      {template.description ? (
        <p className="text-sm leading-relaxed text-text-muted">{template.description}</p>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      {outcome ? (
        <Alert tone="warning">
          {outcome.message}
          {'\n'}
          <Link to={`/documents/${outcome.documentId}`} className="font-medium underline">
            فتح الكتاب
          </Link>
        </Alert>
      ) : null}

      <Card className="space-y-4 p-4">
        <TextField
          label="عنوان الكتاب"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={500}
          hint="هو عنوان الوثيقة في الأرشيف، وبه تُستدعى في البحث."
          required
        />

        <FormsFolderPicker
          value={folderId}
          onChange={setFolderId}
          disabled={busy}
          // Non-empty: the template's own folders are the whole list.
          only={restricted ? assigned : null}
          // An assigned or remembered folder this person cannot file into is
          // cleared rather than submitted unseen.
          clearWhenUnavailable
          hint={
            restricted
              ? 'هذا النموذج مخصص لمجلدات بعينها، ولا تظهر منها إلا ما تملك فيه صلاحية «رفع».'
              : 'يُودع الكتاب في هذا المجلد، وتظهر المجلدات التي تملك فيها صلاحية «رفع» فقط.'
          }
        />
      </Card>

      {fields.length > 0 ? (
        <Card className="space-y-4 p-4">
          <h3 className="text-sm font-semibold text-text">حقول النموذج</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {fields.map((field) => (
              <div key={field.placeholder} className={field.multiline ? 'md:col-span-2' : ''}>
                <FieldControl
                  field={field}
                  value={values[field.placeholder]}
                  disabled={busy}
                  onChange={(next) => setValues((current) => ({ ...current, [field.placeholder]: next }))}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            التاريخ واسم المنشئ يُملآن تلقائياً حين يستخدمهما النموذج؛ لا يُطلبان هنا.
          </p>
        </Card>
      ) : (
        <Card className="p-4">
          <p className="text-sm text-text-muted">
            هذا النموذج بلا حقول متغيّرة — يُنشأ الكتاب بنصه كما هو، بالتاريخ واسم المنشئ.
          </p>
        </Card>
      )}

      <Card className="space-y-2 p-4">
        {ready ? (
          <>
            <Button onClick={generate} disabled={blocked}>
              {busy ? 'جارٍ التجهيز…' : 'إنشاء الكتاب'}
            </Button>
            {busy ? <Spinner label="جارٍ تجهيز الكتاب… قد يستغرق حتى دقيقة" /> : null}
            {!busy && missing.length ? (
              <p className="text-xs text-amber-600">
                بانتظار الحقول الإلزامية: {missing.map((field) => field.label || field.placeholder).join('، ')}
              </p>
            ) : null}
            {!busy && !folderId ? (
              <p className="text-xs text-amber-600">اختر مجلد الإيداع.</p>
            ) : null}
          </>
        ) : (
          <Alert tone="warning">
            لا يمكن إنشاء الكتاب: التحويل إلى PDF غير متاح على الخادم (LibreOffice غير مثبّت أو غير
            مهيّأ). أبلغ مدير النظام، ولا تُفقد القيم المكتوبة هنا إن بقيت الصفحة مفتوحة.
          </Alert>
        )}
      </Card>
    </div>
  );
}
