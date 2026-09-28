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
 * ─── Why the folder list is a rule and not a suggestion ─────────────────────
 *
 * A template used to carry one advisory "default folder": the fill screen
 * proposed it and the person could file the letter anywhere they held «رفع».
 * That is the wrong shape for an official letter. A leave request belongs in
 * the personnel folder and a circular in الصادر, and the institute — not
 * whoever happens to be typing — decides which. So a template now carries a
 * list of folders, and a letter made from it may be filed into none but those:
 * the fill screen offers only the assigned folders the person may upload into,
 * chooses for them when exactly one qualifies, and the server refuses anything
 * else outright.
 *
 * An empty list keeps the old freedom — any folder the person may upload into —
 * so a template nobody has restricted behaves as it always did.
 *
 * The «مجلدات الإيداع» box here is one multi-select: the chosen folders sit in
 * it as chips and the list ticks them off without closing, because "which
 * folders" is one question and the first version asked it once per folder. It
 * offers every folder, not only the ones the administrator may upload into: the
 * list says where letters of this kind belong, and it is the writer's own
 * permission that decides whether they may file one there. An administrator who
 * cannot upload into الصادر must still be able to say that circulars are filed
 * in it.
 *
 * ─── Why a refusal is printed at the bottom of the dialog ───────────────────
 *
 * The dialog's body scrolls; its footer does not. So «حفظ» is pressed from the
 * bottom while the top of the form — where the error banner used to be — is off
 * the screen. A rejected template file therefore looked like a button that does
 * nothing, and the administrator pressed it again. The message now renders last
 * in the body, directly above the footer, and scrolls itself into view; and for
 * a rejected file it leads with «تعذر قبول ملف النموذج:» and prints the server's
 * own reason underneath, since that reason names the offending tag.
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

/** Mirrors config.forms.maxTemplateBytes on the server. */
const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
/** How long the browser may take to hand over the first bytes of the chosen file. */
const FILE_PROBE_MS = 10_000;
/** What the person reads when an upload is stopped, by them or by the clock. */
const ABORTED_MESSAGE =
  'توقف الرفع قبل اكتماله. إن كان الملف على قرص شبكة فانسخه إلى هذا الجهاز أولاً ثم أعد المحاولة.';
/** The server gave up waiting for the file, or the connection fell; the browser reports neither by name. */
const DROPPED_MESSAGE =
  'انقطع الاتصال أثناء رفع الملف ولم يُحفظ النموذج. إن كان الملف على قرص شبكة فانسخه إلى هذا الجهاز ثم أعد المحاولة.';

function withTimeout(promise, ms, code) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Proves the browser can read the file before a single byte is sent.
 *
 * A file chosen from a network share can take seconds to open, or never open
 * at all, and a fetch that is waiting on it looks exactly like a server that
 * hangs. Reading the first four bytes fails fast and says which it was; they
 * also say whether this is a Word package at all (a .docx is a zip, and a zip
 * begins with "PK"), so the obvious mistakes are caught before the upload.
 * Returns an Arabic message, or null when the file is fine.
 */
async function probeFile(file) {
  if (!file) return 'اختر ملف النموذج بصيغة .docx.';
  if (!/\.docx$/i.test(file.name)) return 'الصيغة غير مقبولة: النموذج ملف Word بامتداد .docx.';
  if (file.size > MAX_TEMPLATE_BYTES) return 'الملف أكبر من الحد المسموح به لملفات النماذج.';
  if (file.size < 4) return 'الملف فارغ.';
  try {
    const head = new Uint8Array(await withTimeout(file.slice(0, 4).arrayBuffer(), FILE_PROBE_MS, 'file_unreadable'));
    if (head[0] !== 0x50 || head[1] !== 0x4b) return 'الملف ليس ملف Word سليماً (.docx).';
    return null;
  } catch {
    return 'تعذر قراءة الملف من موقعه. إن كان على قرص شبكة فانسخه إلى هذا الجهاز ثم اختره من جديد.';
  }
}

/** Upload budget: a minute, plus a second per 100 KB, never more than five minutes. */
function uploadBudgetMs(bytes) {
  return Math.min(60_000 + Math.ceil(bytes / 102_400) * 1000, 300_000);
}
import { Modal } from './Modal.jsx';
import TabIntro from './TabIntro.jsx';
import ExpandableActions from './ExpandableActions.jsx';
import { useDialogs } from './DialogProvider.jsx';
import FormsFolderPicker, { folderPaths } from './FormsFolderPicker.jsx';
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
    upload_stalled:
      'توقف وصول الملف إلى الخادم قبل اكتماله. إن كان على قرص شبكة فانسخه إلى هذا الجهاز ثم أعد المحاولة.',
    upload_aborted: 'أُوقف الرفع قبل اكتماله.',
    // A headline that says what happened and what follows, because the server's
    // detail is the useful half: it names the unclosed tag or the part it
    // refused. Printed on its own line under this one.
    template_invalid: 'تعذر قبول ملف النموذج:',
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
  /*
   * The one headline that ends in a colon must not be left dangling.
   *
   * `template_invalid` promises a reason on the next line; a server that sent
   * none (an older build, a refusal with no detail) would otherwise print
   * «تعذر قبول ملف النموذج:» and stop, which reads as a broken message rather
   * than a refusal.
   */
  if (caught.code === 'template_invalid' && !explained) {
    return `${MAP.template_invalid}\nالملف ليس ملف Word سليماً (.docx) أو يحتوي ما لا يُقبل. راجع الملف في Word ثم أعد اختياره.`;
  }
  return (MAP[caught.code] ?? fallback) + explained;
}

/** ` (detail)` when the server named one, so the offending row is identifiable. */
function detailOf(caught) {
  const detail = caught instanceof ApiError ? caught.body?.detail : null;
  return typeof detail === 'string' && detail.trim() ? ` (${detail.trim()})` : '';
}

/*
 * `not_found` while creating a template names a reference, not the template.
 *
 * The server checks the document type, the approval path and every assigned
 * folder in one place and answers `not_found` with a detail; the generic
 * sentence ("the template does not exist — perhaps it was deleted") would send
 * the administrator looking for the wrong thing entirely.
 */
function describeMissingReference(caught) {
  return (
    'أحد الاختيارات لا يشير إلى شيء موجود — نوع الوثيقة أو مسار الاعتماد أو أحد مجلدات الإيداع'
    + `${detailOf(caught)}. صحّح الاختيار وأعد المحاولة.`
  );
}

const BLANK_DRAFT = {
  templateId: null,
  name: '',
  description: '',
  typeId: '',
  approvalTemplateId: '',
  // The assigned folders, as id strings; [] means any folder the writer may
  // upload into. `folders` keeps the server's own rows so a folder that lies
  // past the tree endpoint's cap still has a name to print.
  folderIds: [],
  folders: [],
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
  /*
   * The tab's own banner, brought into view for the same reason the dialog's is.
   *
   * «استبدال الملف» and «معاينة» are pressed on a row that may be the twentieth,
   * and their refusal is printed above the list. Scrolled to, it is a refusal;
   * unscrolled, it is a button that did nothing.
   */
  const errorRef = useRef(null);

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

  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  // The last preview's blob URL outlives this component only as long as the tab
  // the browser opened it in; nothing else holds it, so it is released here.
  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  /*
   * Full paths for the dialog's assigned list, from the same builder the picker
   * uses — two folders may both be called «الصادر», and a bare name in a list
   * an administrator is editing would not say which one is in it.
   */
  const folderPathMap = useMemo(() => folderPaths(folders ?? []), [folders]);

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
      const problem = await probeFile(file);
      if (problem) {
        setError(problem);
        return;
      }
      const form = new FormData();
      form.append('file', file, file.name);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), uploadBudgetMs(file.size));
      let result;
      try {
        result = await api.forms.adminReplaceFile(template.templateId, form, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
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
      if (caught?.name === 'AbortError') {
        setError(ABORTED_MESSAGE);
        return;
      }
      if (!(caught instanceof ApiError)) {
        setError(DROPPED_MESSAGE);
        return;
      }
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

      {error ? (
        <div ref={errorRef}>
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
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
                    folderIds: (template.folders ?? []).map((folder) => String(folder.folderId)),
                    folders: template.folders ?? [],
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
        folderPathMap={folderPathMap}
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
  const assigned = template.folders ?? [];
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
            <span>{' · المجلدات: '}</span>
            {/* «أي مجلد» is the honest reading of an empty list: the rule is
                absent, not merely unset. */}
            {assigned.length === 0 ? (
              <span>أي مجلد</span>
            ) : (
              <span>
                {assigned
                  .slice(0, 4)
                  .map((folder) => folder.name)
                  .join('، ')}
                {assigned.length > 4 ? <span className="num">{` +${assigned.length - 4}`}</span> : null}
              </span>
            )}
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
function TemplateDialog({ draft, types, approvals, folderPathMap, onClose, onSaved }) {
  const [form, setForm] = useState(BLANK_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);
  const errorRef = useRef(null);

  useEffect(() => {
    if (!draft) return;
    setForm(draft);
    setError(null);
  }, [draft]);

  /*
   * A refusal is brought to the eye instead of waiting to be found.
   *
   * The dialog's body scrolls and its footer does not, so «حفظ» is pressed from
   * the bottom of a form whose top is off-screen. An Alert rendered up there was
   * invisible: the administrator pressed save, nothing appeared to happen, and
   * they pressed it again. The message now sits at the end of the body, right
   * above the footer where the press happened, and this scrolls it into view for
   * the case where the form is long enough that even that is below the fold.
   */
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const creating = draft !== null && draft.templateId === null;

  /*
   * What each assigned folder's chip says, handed to the picker as `labelFor`.
   *
   * The tree's own path first, then the name the server sent with the template:
   * the tree endpoint caps its result, and a folder past that cap must still
   * print as something an administrator recognises rather than a bare id.
   */
  const labels = useMemo(() => {
    const map = new Map(folderPathMap ?? []);
    for (const folder of form.folders ?? []) {
      const id = String(folder.folderId);
      const base = map.get(id) || folder.path || folder.name || `#${id}`;
      // A deleted folder is still assigned and blocks every save that keeps
      // it; naming it is what lets the administrator remove it.
      map.set(id, folder.isDeleted ? `${base} (محذوف)` : base);
    }
    return map;
  }, [folderPathMap, form.folders]);

  const folderIds = form.folderIds ?? [];

  function setFolderIds(next) {
    setForm((current) => ({ ...current, folderIds: (next ?? []).map(String) }));
  }

  // The upload in flight, so «إيقاف» and closing the dialog can end it.
  const abortRef = useRef(null);

  function stopUpload() {
    abortRef.current?.abort();
  }

  function closeDialog() {
    stopUpload();
    onClose();
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        // Before anything is sent: a file the browser cannot read, from a
        // network share it cannot reach, would otherwise look like a server
        // that never answers.
        const problem = await probeFile(form.file);
        if (problem) {
          setError(problem);
          return;
        }
        const body = new FormData();
        // Scalars before the file: the server reads one multipart stream in
        // order and cannot see a field that arrives after the file part.
        body.append('name', form.name.trim());
        body.append('description', form.description.trim());
        if (form.typeId) body.append('typeId', form.typeId);
        if (form.approvalTemplateId) body.append('approvalTemplateId', form.approvalTemplateId);
        // A whole array as one scalar part, the same idiom the upload routes use
        // for a metadata array — multipart has no repeated-field convention the
        // server reads, and the parts must precede the file either way.
        if (folderIds.length) body.append('folderIds', JSON.stringify(folderIds));
        body.append('file', form.file, form.file.name);

        // Bounded and stoppable: the budget grows with the file, and the
        // «إيقاف» button or closing the dialog aborts it.
        const controller = new AbortController();
        abortRef.current = controller;
        const timer = setTimeout(() => controller.abort(), uploadBudgetMs(form.file.size));
        try {
          await api.forms.adminCreate(body, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
          abortRef.current = null;
        }
        onSaved(`أُضيف النموذج «${form.name.trim()}». سمِّ حقوله ثم حدّد من يستخدمه قبل تفعيله.`);
      } else {
        const result = await api.forms.adminUpdate(draft.templateId, {
          name: form.name.trim(),
          description: form.description.trim(),
          typeId: form.typeId ? Number(form.typeId) : null,
          approvalTemplateId: form.approvalTemplateId ? Number(form.approvalTemplateId) : null,
        });

        /*
         * The folders are their own route, and it is called only when the set
         * actually differs: it replaces the whole set and writes an audit row,
         * and a template saved for a typo should not read as "the folders were
         * changed" in the log.
         */
        const before = [...(draft.folderIds ?? [])].sort().join('\u0000');
        const after = [...folderIds].sort().join('\u0000');
        if (before !== after) {
          try {
            await api.forms.adminSetFolders(draft.templateId, folderIds);
          } catch (caught) {
            // The template itself is already saved. Said plainly, with the
            // dialog left open: pressing «حفظ» again re-sends both, and a
            // closed dialog would hide which half of the save survived.
            setError(
              caught instanceof ApiError && caught.code === 'not_found'
                ? `حُفظت بيانات النموذج، وتعذر حفظ المجلدات: أحد المجلدات المختارة غير موجود أو محذوف${detailOf(caught)}. أزله من القائمة ثم احفظ.`
                : describeError(caught, 'حُفظت بيانات النموذج، وتعذر حفظ مجلدات الإيداع. أعد المحاولة.'),
            );
            return;
          }
        }

        const cleared = result?.clearedMappings ?? [];
        onSaved(
          cleared.length
            ? `حُفظ النموذج. أُلغي ربط حقول لا تتبع النوع الجديد: ${cleared.join('، ')}.`
            : 'حُفظ النموذج.',
        );
      }
      onClose();
    } catch (caught) {
      if (caught?.name === 'AbortError') {
        setError(ABORTED_MESSAGE);
        return;
      }
      if (creating && !(caught instanceof ApiError)) {
        setError(DROPPED_MESSAGE);
        return;
      }
      setError(
        creating && caught instanceof ApiError && caught.code === 'not_found'
          ? describeMissingReference(caught)
          : describeError(caught, creating ? 'تعذر إضافة النموذج.' : 'تعذر حفظ النموذج.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const complete = form.name.trim().length > 0 && (!creating || form.file);

  return (
    <Modal
      open={draft !== null}
      onClose={closeDialog}
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
            {busy && creating ? 'جارٍ رفع الملف…' : 'حفظ'}
          </Button>
          {/* Never disabled: while an upload runs this is the way out of it. */}
          <Button variant="secondary" onClick={busy ? stopUpload : closeDialog}>
            {busy && creating ? 'إيقاف الرفع' : 'إلغاء'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
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

        <div className="rounded-lg border border-border bg-surface-muted/30 p-3">
          <p className="text-xs leading-relaxed text-text-muted">
            لا تودع كتب هذا النموذج إلا في المجلدات المحددة هنا. اتركها فارغة ليودع كل مستخدم كتابه
            في أي مجلد يملك فيه صلاحية «رفع».
          </p>

          <div className="mt-3">
            {/*
              One box for the whole answer: it shows what is chosen and takes the
              next choice in the same place, and the list stays open while several
              folders are ticked. `requireUpload` is off on purpose — see the note
              at the top of this file. `labelFor` names a folder the tree does not
              return (past its cap, or deleted) so no chip reads as a bare id.
            */}
            <FormsFolderPicker
              label="مجلدات الإيداع"
              multiple
              values={folderIds}
              onChangeMany={setFolderIds}
              labelFor={(id) => labels.get(String(id)) ?? null}
              disabled={busy}
              requireUpload={false}
              emptyLabel="— أي مجلد يملك كاتب الكتاب فيه صلاحية «رفع» —"
              hint="تُعرض كل المجلدات: الصلاحية تُمنح للأشخاص، والقائمة هنا تقول أين تودع كتب هذا النموذج."
            />
          </div>
        </div>

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
                // Taken from the event NOW. The state updater runs later, after
                // the input has been reset below, and by then the input holds no
                // file — reading it there is how a chosen file became «لم يُختر ملف».
                const file = event.target.files?.[0] ?? null;
                setForm((current) => ({ ...current, file }));
                event.target.value = '';
              }}
            />
            <p className="mt-2 text-xs text-text-muted">
              تُستخرج الحقول من الملف عند الرفع. الحقلان {'{{date}}'} و{'{{author}}'} يُملآن تلقائياً
              ولا يُطلبان من المستخدم.
            </p>
          </div>
        ) : null}

        {/*
          Last in the body, immediately above the footer: the refusal appears
          where the hand and the eye already are. One Alert, not two — a second
          copy at the top would leave the administrator wondering whether two
          things went wrong.
        */}
        {error ? (
          <div ref={errorRef}>
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
