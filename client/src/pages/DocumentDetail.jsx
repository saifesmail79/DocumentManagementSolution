import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileText, Download, Save, History, Folder, ArrowRight, Eye, EyeOff } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { formatDate, formatBytes } from '../format.js';
import { Button, Card, Spinner, Alert, TextField, ReadOnlyBadge } from '../components/ui.jsx';

/**
 * One document: its metadata, its custom fields, and its version history.
 *
 * The form is built from the field definitions the server returns for the chosen
 * type, so a deployment that defines its own vocabulary gets its own form with
 * no change here.
 */
export default function DocumentDetail() {
  const { documentId } = useParams();
  const navigate = useNavigate();

  const [document, setDocument] = useState(null);
  const [types, setTypes] = useState([]);
  const [labels, setLabels] = useState([]);
  const [fields, setFields] = useState([]);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, typeList, labelList] = await Promise.all([
        api.document(documentId),
        api.metadata.types(),
        api.metadata.labels(),
      ]);

      setDocument(detail);
      setTypes(typeList.types);
      setLabels(labelList.labels);

      setForm({
        title: detail.title,
        typeId: detail.typeId ?? '',
        labelId: detail.sensitivityLabelId ?? '',
        values: Object.fromEntries(detail.fields.map((f) => [f.fieldId, f.value ?? ''])),
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'الوثيقة غير موجودة أو ليس لديك صلاحية لعرضها.'
          : 'تعذر تحميل الوثيقة.',
      );
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  // The applicable field set depends on the chosen type, so it is refetched when
  // the type changes rather than filtered client-side — the server already knows
  // which globals apply.
  useEffect(() => {
    if (!form) return;
    api.metadata
      .fields(form.typeId || undefined)
      .then((result) => setFields(result.fields))
      .catch(() => setFields([]));
  }, [form?.typeId]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      await api.updateMetadata(documentId, {
        title: form.title,
        typeId: form.typeId === '' ? null : Number(form.typeId),
        labelId: form.labelId === '' ? null : Number(form.labelId),
        fields: fields.map((field) => ({
          fieldId: field.fieldId,
          value: form.values[field.fieldId] === '' ? null : form.values[field.fieldId],
        })),
      });
      setSaved(true);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? {
              forbidden: 'لا تملك صلاحية تعديل بيانات هذه الوثيقة.',
              invalid_title: 'العنوان غير صالح.',
              invalid_value: `قيمة غير صالحة للحقل: ${caught.body?.detail ?? ''}`,
              required_field: `حقل مطلوب: ${caught.body?.detail ?? ''}`,
            }[caught.code] ?? 'تعذر حفظ التعديلات.'
          : 'تعذر حفظ التعديلات.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="جارٍ التحميل…" />;
  if (error && !document) return <Alert tone="error">{error}</Alert>;

  const editable = document.canRead;

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate(`/folders/${document.folderId}`)}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-primary"
      >
        {/* RTL: ArrowRight reads as "back". */}
        <ArrowRight size={13} />
        العودة إلى المجلد
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <FileText size={20} className="text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-text">{document.title}</h2>
            <p className="num text-xs text-text-muted">
              الإصدار {document.currentVersion} · {formatDate(document.updatedAt)}
            </p>
          </div>
          {!document.canRead ? <ReadOnlyBadge /> : null}
        </div>

        {document.canRead ? (
          <a
            href={api.contentUrl(documentId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-primary bg-primary px-4 py-2
              text-sm font-medium text-on-primary transition-colors hover:bg-primary-dark"
          >
            <Download size={16} />
            فتح
          </a>
        ) : null}
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="success">تم حفظ التعديلات.</Alert> : null}

      {/*
        Rendered in an iframe rather than by shipping a PDF viewer: every target
        browser has one built in, it honours the Range requests the content route
        already serves, and it keeps ~400KB of viewer out of the bundle for a
        page most visits never open.
      */}
      {document.canRead && isPreviewable(document) ? (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="text-sm font-medium text-text">معاينة</span>
            <button
              onClick={() => setPreview((v) => !v)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-primary"
            >
              {preview ? <EyeOff size={13} /> : <Eye size={13} />}
              {preview ? 'إخفاء' : 'عرض'}
            </button>
          </div>
          {preview ? (
            <iframe
              title={document.title}
              src={api.contentUrl(documentId)}
              className="h-[70vh] w-full border-0 bg-surface-muted"
            />
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold text-text">البيانات الوصفية</h3>

          <form onSubmit={save} className="space-y-3">
            <TextField
              label="العنوان"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              disabled={!editable}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text">النوع</span>
                <select
                  value={form.typeId}
                  onChange={(event) => setForm({ ...form, typeId: event.target.value })}
                  disabled={!editable}
                  className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                    focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">بدون نوع</option>
                  {types.map((type) => (
                    <option key={type.typeId} value={type.typeId}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text">درجة السرية</span>
                <select
                  value={form.labelId}
                  onChange={(event) => setForm({ ...form, labelId: event.target.value })}
                  disabled={!editable}
                  className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
                    focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">غير محددة</option>
                  {labels.map((label) => (
                    <option key={label.labelId} value={label.labelId}>
                      {label.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {fields.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((field) => (
                  <FieldInput
                    key={field.fieldId}
                    field={field}
                    value={form.values[field.fieldId] ?? ''}
                    disabled={!editable}
                    onChange={(value) =>
                      setForm({ ...form, values: { ...form.values, [field.fieldId]: value } })
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">لا توجد حقول إضافية لهذا النوع.</p>
            )}

            {editable ? (
              <Button type="submit" icon={Save} disabled={busy}>
                {busy ? 'جارٍ الحفظ…' : 'حفظ'}
              </Button>
            ) : null}
          </form>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
            <History size={15} className="text-primary" />
            الإصدارات
          </h3>

          {document.versions.length === 0 ? (
            // Version history reveals how often a document changed and who
            // touched it, so browse-only does not receive it.
            <p className="text-xs text-text-muted">
              {document.canRead ? 'لا توجد إصدارات.' : 'يتطلب عرض السجل صلاحية القراءة.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {document.versions.map((version) => (
                <li key={version.version} className="rounded border border-border p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="num font-medium text-text">إصدار {version.version}</span>
                    <span className="num text-text-muted">{formatBytes(version.bytes)}</span>
                  </div>
                  <p className="mt-1 text-text-muted">
                    {version.uploadedBy} · {formatDate(version.uploadedAt)}
                  </p>
                  {version.comment ? <p className="mt-1 text-text">{version.comment}</p> : null}
                  <a
                    href={api.contentUrl(documentId, version.version)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <Download size={11} />
                    فتح هذا الإصدار
                  </a>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() => navigate(`/folders/${document.folderId}`)}
            className="mt-3 flex items-center gap-1 text-xs text-text-muted hover:text-primary"
          >
            <Folder size={12} />
            المجلد
          </button>
        </Card>
      </div>
    </div>
  );
}

/** Renders the input a field's data type calls for. */
function FieldInput({ field, value, disabled, onChange }) {
  const label = (
    <span className="mb-1.5 block text-sm font-medium text-text">
      {field.name}
      {field.isRequired ? <span className="text-red-600"> *</span> : null}
    </span>
  );

  const classes =
    'w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text ' +
    'focus:outline-none focus:ring-2 focus:ring-primary/40';

  if (field.dataType === 'choice') {
    return (
      <label className="block">
        {label}
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={classes}
        >
          <option value="">—</option>
          {field.choices.map((choice) => (
            <option key={choice.choiceId} value={choice.choiceId}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.dataType === 'bool') {
    return (
      <label className="flex items-center gap-2 pt-6 text-sm text-text">
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.name}
      </label>
    );
  }

  if (field.dataType === 'date') {
    return (
      <label className="block">
        {label}
        <input
          type="date"
          // Trimmed to yyyy-MM-dd: a date input rejects a full ISO timestamp.
          value={value ? String(value).slice(0, 10) : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
          dir="ltr"
          className={classes}
        />
      </label>
    );
  }

  return (
    <label className="block">
      {label}
      <input
        // type="text" even for numbers: a number input swallows keystrokes and
        // fights RTL, and the server validates the value anyway.
        type="text"
        inputMode={field.dataType === 'number' ? 'decimal' : undefined}
        dir={field.dataType === 'number' ? 'ltr' : 'rtl'}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={classes}
      />
    </label>
  );
}

/**
 * Whether the browser can render this inline.
 *
 * Deliberately narrow: a type the browser cannot display would either download
 * on open or render as a wall of bytes, and both read as the page being broken.
 * Office preview is a separate Tier 2 feature needing a converter.
 */
function isPreviewable(document) {
  const version = document.versions?.[0];
  const mime = String(version?.mimeType ?? '').toLowerCase();
  return mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
}
