/**
 * الإدارة ← النماذج — the Word templates official letters are made from.
 *
 * ─── What an administrator does here, and in what order ─────────────────────
 *
 * Upload a .docx whose variable parts are written `{{name}}`; give every
 * placeholder an Arabic label; say who may use it; check the result by previewing
 * it; then activate it. The order matters and the server enforces it: a template
 * cannot be activated while a field is unlabelled, or while the document type it
 * is tied to has required fields no placeholder fills. Both conditions are shown
 * on the row rather than discovered at the moment activation is refused.
 *
 * ─── Why the on/off switch is not here ──────────────────────────────────────
 *
 * `forms.enabled` lives with every other switch in الإدارة ← الإعدادات, as
 * `correspondence.enabled` does. Two controls for one setting is one control too
 * many, and the one nobody uses is the one that goes stale. This tab links to it
 * in prose and disables itself while the module is off.
 *
 * ─── Why the readiness line reports LibreOffice separately ──────────────────
 *
 * The switch being on does not mean a letter can be produced: the merge is a
 * Word file, and turning it into a PDF is LibreOffice's job on the server. A tab
 * that looks ready while every generation would fail is the failure the
 * renditions screen already learned to avoid ("a tool probe alone is a false
 * green light"), so the state of the converter is stated in its own line.
 *
 * ─── Why replacing a file shows a difference ────────────────────────────────
 *
 * Re-uploading a template re-reads its placeholders. Labels for placeholders
 * that survive are kept, new ones arrive labelled with their own name, and the
 * rest are deleted — along with their labels and mappings. That last part is
 * quiet and irreversible, so the server returns what changed and it is printed
 * here instead of leaving the administrator to compare two lists by hand.
 *
 * If the placeholder that disappeared was the only one filling a required field
 * of the template's document type, the server also takes the template offline —
 * otherwise every user who filled it afterwards would be refused for a field the
 * form no longer has. That is the one part of the difference the administrator
 * must not skim past, so it is named on its own line.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  FileUp,
  LayoutTemplate,
  ListChecks,
  Plus,
  Save,
  Users,
} from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatBytes, formatDate } from '../format.js';
import { useTree } from '../TreeContext.jsx';
import { Alert, Button, Card, EmptyState, Spinner, TextField } from './ui.jsx';
import { Modal } from './Modal.jsx';
import TabIntro from './TabIntro.jsx';
import ExpandableActions from './ExpandableActions.jsx';
import { useDialogs } from './DialogProvider.jsx';
import FormsFolderPicker from './FormsFolderPicker.jsx';
import FormsFieldsTable, { unmappedRequiredFields } from './FormsFieldsTable.jsx';
import FormsAccessDialog from './FormsAccessDialog.jsx';

/*
 * Every reason the forms administration routes answer with, in Arabic.
 *
 * Same shape as AdminTabs.jsx's own helper (which is private to that file): one
 * map, one fallback, so a code nobody thought to handle produces the caller's
 * sentence rather than a blank or a raw token. `detail` is appended when the
 * server sent one, because for a rejected template it names the offending tag —
 * which is the whole value of the refusal.
 */
function describeError(caught, fallback) {
  if (!(caught instanceof ApiError)) return fallback;

  const MAP = {
    forms_disabled: 'وحدة النماذج معطّلة. فعّلها من «الإعدادات ← النماذج» ثم أعد المحاولة.',
    forbidden: 'هذه العملية لمديري النظام.',
    not_found: 'النموذج غير موجود — ربما حُذف. حدّث الصفحة.',
    no_file: 'اختر ملف النموذج بصيغة .docx.',
    blocked_extension: 'الصيغة غير مقبولة: النموذج ملف Word بامتداد .docx.',
    too_large: 'الملف أكبر من الحد المسموح به لملفات النماذج.',
    template_invalid: 'ملف النموذج غير سليم أو يحتوي ما لا يُقبل.',
    fields_unlabelled: 'لا يُفعَّل النموذج قبل تسمية كل حقوله بالعربية.',
    type_requires_fields: 'نوع الوثيقة يطلب حقولاً إلزامية لا يملؤها أي حقل في النموذج.',
    field_unmappable: 'أحد الحقول مربوط بحقل لا يقبل الربط (النص والرقم والتاريخ فقط).',
    field_not_in_type: 'أحد الحقول مربوط بحقل لا يتبع نوع الوثيقة ولا هو حقل عام.',
    field_mapped_twice: 'حقلان مربوطان بحقل النوع نفسه. اختر حقلاً مختلفاً لأحدهما.',
    name_taken: 'يوجد نموذج بهذا الاسم.',
    invalid_name: 'الاسم غير صالح.',
    libreoffice_missing: 'LibreOffice غير مثبّت على الخادم، فلا معاينة ولا إنشاء كتب.',
    template_missing: 'ملف النموذج غير موجود على الخادم أو تغيّرت بصمته.',
    conversion_failed: 'تعذر تحويل النموذج إلى PDF. راجع تصميم الملف.',
    busy: 'الخادم مشغول بتحويلات أخرى. أعد المحاولة بعد قليل.',
  };

  const detail = caught.body?.detail;
  const explained = typeof detail === 'string' && detail.trim() ? `\n${detail.trim()}` : '';
  return (MAP[caught.code] ?? fallback) + explained;
}

const BLANK_DRAFT = {
  templateId: null,
  name: '',
  description: '',
  typeId: '',
  approvalTemplateId: '',
  defaultFolderId: '',
  file: null,
};

export default function FormsAdminTab() {
  const { confirm } = useDialogs();
  const { folders } = useTree();

  const [status, setStatus] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [types, setTypes] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [principals, setPrincipals] = useState([]);
  const [customFields, setCustomFields] = useState([]);

  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [diff, setDiff] = useState(null);
  // A preview the browser refused to open in a tab, offered as a link instead.
  const [preview, setPreview] = useState(null);

  const [draft, setDraft] = useState(null);
  const [accessFor, setAccessFor] = useState(null);
  const [fieldsFor, setFieldsFor] = useState(null);

  // One hidden input for every row's «استبدال الملف», with the target chosen
  // just before it is clicked — a file input per template would be dozens of
  // inputs for one that is used at a time.
  const replaceInput = useRef(null);
  const replaceTarget = useRef(null);
  // The blob URL of the last preview, revoked when another replaces it.
  const previewUrl = useRef(null);

  const load = useCallback(async () => {
    try {
      const [moduleStatus, templateList, typeList, approvalList, principalList, fieldList] =
        await Promise.all([
          api.forms.adminStatus(),
          // The template list is gated by the module switch, so while forms are
          // off it answers 409 — and that is a state this tab is written to
          // render (the warning, the readiness card, the disabled buttons), not
          // an error that should replace the whole screen with a red banner.
          api.forms.adminTemplates().catch((caught) => {
            if (caught instanceof ApiError && caught.code === 'forms_disabled') {
              return { templates: [] };
            }
            throw caught;
          }),
          // Inactive types stay visible: a template may be tied to a type that
          // was retired, and hiding it would make the row look unconfigured.
          api.metadata.types(true),
          api.approvalTemplates(),
          api.admin.principals(''),
          api.metadata.fields(),
        ]);

      setStatus(moduleStatus);
      setTemplates(templateList.templates ?? []);
      setTypes(typeList.types ?? []);
      setApprovals(approvalList.templates ?? []);
      setPrincipals(principalList.principals ?? []);
      setCustomFields(fieldList.fields ?? []);
    } catch (caught) {
      setError(describeError(caught, 'تعذر تحميل إعدادات النماذج.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The last preview's blob URL outlives this component only as long as the tab
  // the browser opened it in; nothing else holds it, so it is released here.
  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  const folderNames = useMemo(
    () => new Map((folders ?? []).map((folder) => [String(folder.folderId), folder.name])),
    [folders],
  );

  async function openPreview(template) {
    setError(null);
    try {
      // POST, not a link: the route merges sample values and converts, and
      // producing a PDF is not something a bookmark or a prefetch should do.
      const response = await fetch(api.forms.adminPreviewUrl(template.templateId), {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new ApiError(response.status, body);
      }

      const url = URL.createObjectURL(await response.blob());
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = url;

      // The fetch happens between the click and this line, so a popup blocker
      // may refuse the window. The link is then offered instead of losing the
      // PDF that was just produced.
      const opened = window.open(url, '_blank', 'noopener');
      if (!opened) setPreview({ url, name: template.name });
      else setPreview(null);
    } catch (caught) {
      setError(describeError(caught, 'تعذر إنتاج المعاينة.'));
    }
  }

  async function replaceFile(file) {
    const template = replaceTarget.current;
    if (!file || !template) return;

    setError(null);
    setNotice(null);
    setDiff(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const result = await api.forms.adminReplaceFile(template.templateId, form);
      // `deactivated` names the type's required fields that lost their only
      // placeholder; when it is present the server has already set the template
      // inactive, and that outcome is read off the same alert as the rest of the
      // difference. Accepted from beside the diff as well as inside it, so the
      // alert does not depend on which of the two the route settles on.
      const deactivated = result.diff?.deactivated ?? result.deactivated ?? null;
      setDiff({ name: template.name, ...(result.diff ?? {}), deactivated });
      setNotice(
        deactivated?.length
          ? `استُبدل ملف النموذج «${template.name}»، وعُطّل النموذج حتى تُعاد الحقول.`
          : `استُبدل ملف النموذج «${template.name}».`,
      );
      await load();
    } catch (caught) {
      setError(describeError(caught, 'تعذر استبدال ملف النموذج.'));
    }
  }

  async function toggleActive(template) {
    if (template.isActive) {
      const confirmed = await confirm({
        title: 'تعطيل النموذج',
        message: `تعطيل «${template.name}»`,
        detail: 'لن يظهر النموذج لأحد في شاشة «النماذج». الكتب التي أُنشئت به لا تتأثر.',
        confirmLabel: 'تعطيل',
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    setError(null);
    try {
      await api.forms.adminUpdate(template.templateId, { isActive: !template.isActive });
      setNotice(template.isActive ? `عُطّل «${template.name}».` : `فُعّل «${template.name}».`);
      await load();
    } catch (caught) {
      setError(describeError(caught, 'تعذر تغيير حالة النموذج.'));
    }
  }

  if (error && !templates) return <Alert tone="error">{error}</Alert>;
  if (!status || !templates) return <Spinner />;

  const enabled = status.enabled === true;
  const converter = status.libreOffice === true;

  return (
    <div className="space-y-4">
      <TabIntro topic="admin.forms" />

      {!enabled ? (
        <Alert tone="warning">
          الوحدة معطّلة حالياً. فعّلها من «الإعدادات ← النماذج ← وحدة النماذج»، ثم عد إلى هنا
          لرفع النماذج وتسمية حقولها.
        </Alert>
      ) : null}

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-text">جهوزية التحويل</h3>
        <p className="text-xs leading-relaxed text-text-muted">
          إنشاء الكتاب يمرّ بتحويل ملف Word إلى PDF على الخادم بواسطة LibreOffice.
        </p>
        <p className={`mt-2 text-sm ${converter ? 'text-green-600' : 'text-red-600'}`}>
          {converter
            ? 'LibreOffice متاح على الخادم — التحويل والمعاينة يعملان.'
            : 'LibreOffice غير متاح على الخادم — لا معاينة ولا إنشاء كتب حتى يُثبَّت ويُهيّأ مساره.'}
        </p>
      </Card>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {preview ? (
        <Alert tone="info">
          {`مُنعت النافذة المنبثقة، ومعاينة «${preview.name}» جاهزة: `}
          <a href={preview.url} target="_blank" rel="noreferrer" className="font-medium underline">
            افتح المعاينة
          </a>
        </Alert>
      ) : null}

      {diff ? (
        <Alert tone={diff.removed?.length || diff.deactivated?.length ? 'warning' : 'info'}>
          {`نتيجة استبدال ملف «${diff.name}»:`}
          {'\n'}
          {`حقول جديدة: ${diff.added?.length ? diff.added.join('، ') : 'لا شيء'}`}
          {'\n'}
          {`حقول باقية: ${diff.kept?.length ? diff.kept.join('، ') : 'لا شيء'}`}
          {'\n'}
          {`حقول حُذفت مع تسمياتها وروابطها: ${diff.removed?.length ? diff.removed.join('، ') : 'لا شيء'}`}
          {/* Said last and in full: the template is no longer offered to anyone,
              and the administrator is the only one who will notice. */}
          {diff.deactivated?.length ? (
            <>
              {'\n'}
              {`عُطّل النموذج تلقائياً: نوع الوثيقة يطلب حقولاً إلزامية لم يبقَ في الملف ما يملؤها: ${diff.deactivated.join('، ')}. أضف الحقول إلى الملف أو اربطها من «حقول النموذج»، ثم فعّل النموذج من جديد.`}
            </>
          ) : null}
        </Alert>
      ) : null}

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">النماذج</h3>
          <Button
            icon={Plus}
            disabled={!enabled}
            onClick={() => setDraft({ ...BLANK_DRAFT })}
            className="!px-3 !py-1 text-xs"
          >
            نموذج جديد
          </Button>
        </div>

        {templates.length === 0 ? (
          <EmptyState
            icon={LayoutTemplate}
            title="لا نماذج بعد"
            hint="صمّم الكتاب في Word واكتب كل حقل متغيّر بالشكل {{اسم_الحقل}}، ثم ارفعه هنا بصيغة .docx."
          />
        ) : (
          <ul className="divide-y divide-border/50">
            {templates.map((template) => (
              <TemplateRow
                key={template.templateId}
                template={template}
                types={types}
                approvals={approvals}
                customFields={customFields}
                folderNames={folderNames}
                disabled={!enabled}
                converter={converter}
                onEdit={() =>
                  setDraft({
                    templateId: template.templateId,
                    name: template.name ?? '',
                    description: template.description ?? '',
                    typeId: template.typeId == null ? '' : String(template.typeId),
                    approvalTemplateId:
                      template.approvalTemplateId == null ? '' : String(template.approvalTemplateId),
                    defaultFolderId:
                      template.defaultFolderId == null ? '' : String(template.defaultFolderId),
                    file: null,
                  })
                }
                onToggleActive={() => toggleActive(template)}
                onPreview={() => openPreview(template)}
                onAccess={() => setAccessFor(template)}
                onFields={() => setFieldsFor(template)}
                onReplace={() => {
                  replaceTarget.current = template;
                  replaceInput.current?.click();
                }}
              />
            ))}
          </ul>
        )}

        <input
          ref={replaceInput}
          type="file"
          accept=".docx"
          hidden
          onChange={(event) => {
            replaceFile(event.target.files?.[0]);
            // Reset so the same file can be picked again after a refusal.
            event.target.value = '';
          }}
        />
      </Card>

      <TemplateDialog
        draft={draft}
        types={types}
        approvals={approvals}
        onClose={() => setDraft(null)}
        onSaved={(message) => {
          setNotice(message);
          setDiff(null);
          load();
        }}
      />

      <FormsAccessDialog
        open={accessFor !== null}
        template={accessFor}
        principals={principals}
        onClose={() => setAccessFor(null)}
        onSaved={() => {
          setNotice('حُفظت صلاحيات استخدام النموذج.');
          load();
        }}
      />

      <FormsFieldsTable
        open={fieldsFor !== null}
        template={fieldsFor}
        customFields={customFields}
        onClose={() => setFieldsFor(null)}
        onSaved={() => {
          setNotice('حُفظت حقول النموذج.');
          load();
        }}
      />
    </div>
  );
}

// ── One template's row ───────────────────────────────────────────────────

function TemplateRow({
  template,
  types,
  approvals,
  customFields,
  folderNames,
  disabled,
  converter,
  onEdit,
  onToggleActive,
  onPreview,
  onAccess,
  onFields,
  onReplace,
}) {
  const fields = template.fields ?? [];
  const editable = fields.filter((field) => !field.builtIn);
  const unlabelled =
    Number(template.unlabelled) || editable.filter((field) => !String(field.label ?? '').trim()).length;
  const missing = unmappedRequiredFields(template, customFields);

  const typeName = types.find((type) => Number(type.typeId) === Number(template.typeId))?.name;
  const approvalName = approvals.find(
    (entry) => Number(entry.templateId) === Number(template.approvalTemplateId),
  )?.name;
  const folderName = folderNames.get(String(template.defaultFolderId));
  const access = template.access ?? [];

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-sm font-medium ${
                template.isActive ? 'text-text' : 'text-text-muted line-through'
              }`}
            >
              {template.name}
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 text-[11px] ${
                template.isActive
                  ? 'border-green-200 bg-green-50 text-green-600'
                  : 'border-border bg-surface-muted text-text-muted'
              }`}
            >
              {template.isActive ? 'مفعّل' : 'معطّل'}
            </span>
            {unlabelled > 0 ? (
              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-600">
                <span>حقول بلا تسمية: </span>
                <span className="num">{unlabelled}</span>
              </span>
            ) : null}
          </div>

          {template.description ? (
            <p className="mt-1 text-xs leading-relaxed text-text-muted">{template.description}</p>
          ) : null}

          <p className="mt-1 text-xs text-text-muted">
            {`النوع: ${typeName ?? 'بلا نوع'}`}
            {` · الاعتماد التلقائي: ${approvalName ?? 'لا'}`}
            {` · مجلد افتراضي: ${folderName ?? 'لا'}`}
          </p>

          <p className="mt-0.5 text-xs text-text-muted">
            <span>{`الحقول: `}</span>
            <span className="num">{editable.length}</span>
            <span>{` · ${access.length === 0 ? 'الاستخدام: مديرو النظام فقط' : 'الاستخدام: '}`}</span>
            {access.length ? (
              <span>
                {access
                  .slice(0, 4)
                  .map((entry) => entry.displayName)
                  .join('، ')}
                {access.length > 4 ? (
                  <span className="num">{` +${access.length - 4}`}</span>
                ) : null}
              </span>
            ) : null}
          </p>

          {template.originalFilename ? (
            <p className="mt-0.5 text-xs text-text-muted">
              <span dir="ltr" className="break-all">{template.originalFilename}</span>
              {template.bytes ? <span className="num">{` · ${formatBytes(template.bytes)}`}</span> : null}
              {template.updatedAt ? (
                <span className="num">{` · آخر تحديث ${formatDate(template.updatedAt)}`}</span>
              ) : null}
            </p>
          ) : null}

          {missing.length ? (
            <Alert tone="warning">
              {`نوع الوثيقة يطلب حقولاً إلزامية لا يملؤها أي حقل: ${missing
                .map((field) => field.name)
                .join('، ')}. لا يُفعَّل النموذج ولا يُنشأ به كتاب قبل ربطها.`}
            </Alert>
          ) : null}
        </div>

        {/* Row menu is the standard — no bare icon buttons in an action cell. */}
        <ExpandableActions
          label={`إجراءات النموذج ${template.name}`}
          isActive={template.isActive}
          onEdit={disabled ? undefined : onEdit}
          onToggleActive={disabled ? undefined : onToggleActive}
          customActions={[
            {
              key: 'fields',
              icon: ListChecks,
              title: 'الحقول وتسمياتها',
              disabled,
              onClick: onFields,
            },
            {
              key: 'access',
              icon: Users,
              title: 'من يستخدمه',
              disabled,
              onClick: onAccess,
            },
            {
              key: 'preview',
              icon: Eye,
              title: converter ? 'معاينة بقيم نموذجية' : 'المعاينة تحتاج LibreOffice',
              disabled: disabled || !converter,
              onClick: onPreview,
            },
            {
              key: 'replace',
              icon: FileUp,
              title: 'استبدال ملف النموذج',
              disabled,
              onClick: onReplace,
            },
            {
              key: 'download',
              icon: Download,
              title: 'تنزيل ملف النموذج',
              href: api.forms.adminFileUrl(template.templateId),
            },
          ]}
        />
      </div>
    </li>
  );
}

// ── Creating and editing a template ──────────────────────────────────────

/*
 * One dialog for both, branching on `draft.templateId`.
 *
 * The file is part of creation and not of editing: a new template has no
 * placeholders until one is read out of a document, while replacing the file of
 * an existing template is a separate action with its own consequence (fields
 * disappear) and its own report. Folding both into one form would make that
 * consequence a side effect of pressing «حفظ».
 */
function TemplateDialog({ draft, types, approvals, onClose, onSaved }) {
  const [form, setForm] = useState(BLANK_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    if (!draft) return;
    setForm(draft);
    setError(null);
  }, [draft]);

  const creating = draft !== null && draft.templateId === null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const body = new FormData();
        // Scalars before the file: the server reads one multipart stream in
        // order and cannot see a field that arrives after the file part.
        body.append('name', form.name.trim());
        body.append('description', form.description.trim());
        if (form.typeId) body.append('typeId', form.typeId);
        if (form.approvalTemplateId) body.append('approvalTemplateId', form.approvalTemplateId);
        if (form.defaultFolderId) body.append('defaultFolderId', form.defaultFolderId);
        body.append('file', form.file, form.file.name);

        await api.forms.adminCreate(body);
        onSaved(`أُضيف النموذج «${form.name.trim()}». سمِّ حقوله ثم حدّد من يستخدمه قبل تفعيله.`);
      } else {
        const result = await api.forms.adminUpdate(draft.templateId, {
          name: form.name.trim(),
          description: form.description.trim(),
          typeId: form.typeId ? Number(form.typeId) : null,
          approvalTemplateId: form.approvalTemplateId ? Number(form.approvalTemplateId) : null,
          defaultFolderId: form.defaultFolderId ? String(form.defaultFolderId) : null,
        });

        const cleared = result?.clearedMappings ?? [];
        onSaved(
          cleared.length
            ? `حُفظ النموذج. أُلغي ربط حقول لا تتبع النوع الجديد: ${cleared.join('، ')}.`
            : 'حُفظ النموذج.',
        );
      }
      onClose();
    } catch (caught) {
      setError(describeError(caught, creating ? 'تعذر إضافة النموذج.' : 'تعذر حفظ النموذج.'));
    } finally {
      setBusy(false);
    }
  }

  const complete = form.name.trim().length > 0 && (!creating || form.file);

  return (
    <Modal
      open={draft !== null}
      onClose={onClose}
      title={creating ? 'نموذج جديد' : `تعديل النموذج: ${draft?.name ?? ''}`}
      subtitle={
        creating
          ? 'ملف Word بصيغة .docx، حقوله المتغيّرة مكتوبة بالشكل {{اسم_الحقل}}.'
          : 'تغيير النوع قد يُلغي ربط حقول لا تتبعه؛ يُذكَر ذلك بعد الحفظ.'
      }
      icon={LayoutTemplate}
      size="md"
      footer={
        <>
          <Button icon={Save} onClick={save} disabled={busy || !complete}>
            حفظ
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <TextField
          label="اسم النموذج"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="مثال: كتاب تعميم داخلي"
          maxLength={200}
        />

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">وصف مختصر (اختياري)</span>
          <textarea
            dir="rtl"
            rows={2}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="يظهر تحت اسم النموذج في شاشة «النماذج»"
            className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
              placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">نوع الوثيقة (اختياري)</span>
            <select
              value={form.typeId}
              onChange={(event) => setForm({ ...form, typeId: event.target.value })}
              className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">بدون نوع</option>
              {types.map((type) => (
                <option key={type.typeId} value={type.typeId}>
                  {type.name}
                  {type.isActive === false ? ' (معطّل)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text">مسار اعتماد تلقائي (اختياري)</span>
            <select
              value={form.approvalTemplateId}
              onChange={(event) => setForm({ ...form, approvalTemplateId: event.target.value })}
              className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">لا يبدأ اعتماد تلقائياً</option>
              {/* A retired path is shown, marked: one may still be attached to
                  a template, and hiding it would look like nothing is set. */}
              {approvals.map((entry) => (
                <option key={entry.templateId} value={entry.templateId}>
                  {entry.name}
                  {entry.isActive === false ? ' (معطّل)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <FormsFolderPicker
          label="المجلد الافتراضي للإيداع (اختياري)"
          value={form.defaultFolderId}
          onChange={(next) => setForm({ ...form, defaultFolderId: next })}
          emptyLabel="— بلا مجلد افتراضي —"
          requireUpload={false}
          hint="يُقترح على من يستخدم النموذج، ويبقى بإمكانه اختيار غيره."
        />

        {creating ? (
          <div className="rounded-lg border border-border bg-surface-muted/30 p-3">
            <p className="mb-2 text-sm font-medium text-text">ملف النموذج</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={FileUp}
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="!px-3 !py-1.5 text-xs"
              >
                اختيار ملف .docx
              </Button>
              <span dir="ltr" className="min-w-0 break-all text-xs text-text-muted">
                {form.file?.name ?? 'لم يُختر ملف'}
              </span>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".docx"
              hidden
              onChange={(event) => {
                setForm((current) => ({ ...current, file: event.target.files?.[0] ?? null }));
                event.target.value = '';
              }}
            />
            <p className="mt-2 text-xs text-text-muted">
              تُستخرج الحقول من الملف عند الرفع. الحقلان {'{{date}}'} و{'{{author}}'} يُملآن تلقائياً
              ولا يُطلبان من المستخدم.
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
