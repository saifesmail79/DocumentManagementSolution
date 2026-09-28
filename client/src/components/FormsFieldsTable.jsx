/**
 * The placeholders of one template, and what each one means.
 *
 * ─── Why the placeholders are read-only here ────────────────────────────────
 *
 * They come from the Word file. The server discovers them by compiling the
 * template with docxtemplater, so what is listed is exactly what the merge will
 * look for — including tags in headers and footers, and excluding text that
 * only looks like a tag. Letting an administrator rename one here would produce
 * a label for a placeholder that does not exist in the document and no label
 * for the one that does. A placeholder changes by editing the Word file and
 * replacing it.
 *
 * What is editable is everything the filling screen needs and the document
 * cannot say: the Arabic label, whether the field takes several lines, whether
 * it is required, and which custom field of the document type (if any) the
 * value is also stored in.
 *
 * ─── Why a label is required before publishing ──────────────────────────────
 *
 * The default label is the placeholder itself, which is perfectly good when the
 * placeholder is Arabic and useless when it is `ref_no`. The server refuses to
 * activate a template with an unlabelled field, so the count is shown here and
 * on the template's row rather than discovered at activation.
 *
 * ─── Why only text, number and date fields can be mapped ───────────────────
 *
 * A mapped value is written into `dbo.document_field_values`, and only those
 * three data types accept a free-text answer unambiguously. A choice or a user
 * field needs an id, not a typed string, so offering them would be offering a
 * mapping the server refuses. Mapped text is capped at 1000 characters because
 * that is the column's width — stated on the screen so it is not learned from
 * a refusal.
 */

import { useEffect, useMemo, useState } from 'react';
import { ListChecks, Save } from 'lucide-react';

import { api, ApiError } from '../api.js';
import { Alert, Button } from './ui.jsx';
import { Modal } from './Modal.jsx';

/** Data types whose value a typed string can become without further choice. */
const MAPPABLE = ['text', 'number', 'date'];

/** The custom fields this template's type may map to: its own, plus the global ones. */
export function mappableFields(template, customFields) {
  const typeId = template?.typeId == null ? null : Number(template.typeId);
  return (customFields ?? []).filter(
    (field) =>
      MAPPABLE.includes(field.dataType)
      && (field.typeId === null || (typeId !== null && Number(field.typeId) === typeId)),
  );
}

/**
 * Required fields of the template's type that no placeholder fills.
 *
 * These block both activation and generation — `createDocument` refuses a
 * document of a type whose required fields are missing — so they are named
 * before either is attempted.
 */
export function unmappedRequiredFields(template, customFields) {
  const typeId = template?.typeId == null ? null : Number(template.typeId);
  if (typeId === null) return [];

  const mapped = new Set(
    (template.fields ?? [])
      .filter((field) => field.fieldId != null)
      .map((field) => Number(field.fieldId)),
  );

  return (customFields ?? []).filter(
    (field) =>
      field.isRequired
      && (field.typeId === null || Number(field.typeId) === typeId)
      && !mapped.has(Number(field.fieldId)),
  );
}

export default function FormsFieldsTable({ open, template, customFields, onClose, onSaved }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Seeded from the template each time the dialog opens, so a cancelled edit
  // leaves nothing behind.
  useEffect(() => {
    if (!open || !template) return;
    setRows(
      (template.fields ?? []).map((field, index) => ({
        placeholder: field.placeholder,
        label: field.label ?? '',
        multiline: Boolean(field.multiline),
        required: Boolean(field.required),
        builtIn: Boolean(field.builtIn),
        fieldId: field.fieldId == null ? '' : String(field.fieldId),
        sortOrder: field.sortOrder == null ? index : Number(field.sortOrder),
      })),
    );
    setError(null);
  }, [open, template]);

  const options = useMemo(() => mappableFields(template, customFields), [template, customFields]);
  const missing = useMemo(
    () =>
      unmappedRequiredFields(
        {
          ...template,
          fields: rows.map((row) => ({ fieldId: row.fieldId ? Number(row.fieldId) : null })),
        },
        customFields,
      ),
    [template, rows, customFields],
  );

  const editable = rows.filter((row) => !row.builtIn);
  const unlabelled = editable.filter((row) => !row.label.trim());

  /*
   * A custom field holds one value per document, so it can carry one
   * placeholder, not two. The server refuses the second with
   * `field_mapped_twice` and refuses the whole save with it, so a field already
   * claimed by another row is not offered here — the state that cannot be saved
   * is easier to prevent than to explain.
   */
  const claimed = useMemo(
    () => new Set(rows.filter((row) => row.fieldId).map((row) => String(row.fieldId))),
    [rows],
  );

  function update(placeholder, patch) {
    setRows((current) =>
      current.map((row) => (row.placeholder === placeholder ? { ...row, ...patch } : row)),
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Built-in rows are the server's own and are not sent back: their label,
      // flags and mapping are not an administrator's to set.
      await api.forms.adminSetFields(
        template.templateId,
        editable.map((row, index) => ({
          placeholder: row.placeholder,
          label: row.label.trim(),
          multiline: row.multiline,
          required: row.required,
          fieldId: row.fieldId ? Number(row.fieldId) : null,
          sortOrder: index,
        })),
      );
      onSaved();
      onClose();
    } catch (caught) {
      setError(describeFieldsError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`حقول النموذج: ${template?.name ?? ''}`}
      subtitle="الأسماء بين علامتَي # تأتي من ملف Word ولا تُعدَّل من هنا."
      icon={ListChecks}
      size="lg"
      footer={
        <>
          <Button icon={Save} onClick={save} disabled={busy}>
            حفظ الحقول
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        {unlabelled.length ? (
          <Alert tone="warning">
            {`حقول بلا تسمية عربية: ${unlabelled.map((row) => row.placeholder).join('، ')}. `}
            لا يُفعَّل النموذج حتى تُسمّى كلها.
          </Alert>
        ) : null}

        {missing.length ? (
          <Alert tone="warning">
            {`نوع الوثيقة يطلب حقولاً إلزامية لا يملؤها أي حقل في النموذج: ${missing
              .map((field) => field.name)
              .join('، ')}. `}
            اربط حقلاً بكل واحد منها، أو أزل الإلزام من إدارة أنواع الوثائق.
          </Alert>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-text-muted">
            لا حقول في هذا النموذج — لا يحتوي ملف Word على أي اسم بين علامتَي #.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-muted">
                  <th className="px-2 py-2 text-right font-medium">الحقل في الملف</th>
                  <th className="px-2 py-2 text-right font-medium">التسمية العربية</th>
                  <th className="px-2 py-2 text-center font-medium">عدة أسطر</th>
                  <th className="px-2 py-2 text-center font-medium">إلزامي</th>
                  <th className="px-2 py-2 text-right font-medium">يُحفظ في حقل النوع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {rows.map((row) => (
                  <tr key={row.placeholder}>
                    <td className="px-2 py-2 text-left align-top">
                      {/*
                        Printed in the form it is typed in — `#name#`. A template
                        written with the older braces stores the same bare name,
                        so one display form is right for both.
                      */}
                      <code dir="ltr" className="text-[12px] text-text">{`#${row.placeholder}#`}</code>
                      {row.builtIn ? (
                        <span className="ms-2 rounded border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] text-text-muted">
                          تلقائي
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 align-top">
                      {row.builtIn ? (
                        <span className="text-xs text-text-muted">يملؤه النظام</span>
                      ) : (
                        <input
                          dir="rtl"
                          value={row.label}
                          onChange={(event) => update(row.placeholder, { label: event.target.value })}
                          placeholder={row.placeholder}
                          maxLength={200}
                          className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm text-text
                            placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                      )}
                    </td>
                    <td className="px-2 py-2 text-center align-top">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        disabled={row.builtIn}
                        checked={row.multiline}
                        onChange={(event) => update(row.placeholder, { multiline: event.target.checked })}
                        aria-label={`عدة أسطر: ${row.placeholder}`}
                      />
                    </td>
                    <td className="px-2 py-2 text-center align-top">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        disabled={row.builtIn}
                        checked={row.required}
                        onChange={(event) => update(row.placeholder, { required: event.target.checked })}
                        aria-label={`إلزامي: ${row.placeholder}`}
                      />
                    </td>
                    <td className="px-2 py-2 align-top">
                      {row.builtIn ? (
                        <span className="text-xs text-text-muted">—</span>
                      ) : (
                        <select
                          value={row.fieldId}
                          onChange={(event) => update(row.placeholder, { fieldId: event.target.value })}
                          className="w-full rounded-lg border border-border bg-control px-2 py-1.5 text-sm text-text
                            focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                          <option value="">— لا يُحفظ بياناً —</option>
                          {options
                            // Its own choice always stays, or the select would
                            // show a value it does not offer.
                            .filter(
                              (field) =>
                                String(field.fieldId) === String(row.fieldId)
                                || !claimed.has(String(field.fieldId)),
                            )
                            .map((field) => (
                              <option key={field.fieldId} value={field.fieldId}>
                                {field.name}
                                {field.typeId === null ? ' (عام)' : ''}
                              </option>
                            ))}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs leading-relaxed text-text-muted">
          الحقل المربوط بحقل من حقول النوع تُحفظ قيمته بياناً قابلاً للبحث، ولذلك يُحدَّد بألف حرف.
          تُقبل حقول النص والرقم والتاريخ فقط، من حقول هذا النوع أو الحقول العامة. والحقل المستخدم
          في سطر لا يظهر في بقية الأسطر: لكل حقل من حقول النوع قيمة واحدة في الوثيقة.
          {options.length === 0 && template?.typeId == null
            ? ' اربط النموذج بنوع وثيقة أولاً لتظهر حقوله هنا.'
            : ''}
        </p>
      </div>
    </Modal>
  );
}

function describeFieldsError(caught) {
  if (!(caught instanceof ApiError)) return 'تعذر حفظ الحقول. تحقق من الاتصال وأعد المحاولة.';
  const MAP = {
    forms_disabled: 'وحدة النماذج معطّلة. فعّلها من «الإعدادات» ثم أعد المحاولة.',
    not_found: 'النموذج غير موجود — ربما حُذف. حدّث الصفحة.',
    forbidden: 'هذه العملية لمديري النظام.',
    field_unmappable: 'أحد الحقول مربوط بحقل لا يقبل الربط (يُقبل النص والرقم والتاريخ فقط).',
    field_not_in_type: 'أحد الحقول مربوط بحقل لا يتبع نوع الوثيقة المختار ولا هو حقل عام.',
    // The detail names the two placeholders, so the administrator does not have
    // to compare the mapping column row by row.
    field_mapped_twice: 'حقلان مربوطان بحقل النوع نفسه. اختر حقلاً مختلفاً لأحدهما.',
    unknown_placeholder: 'أحد الأسماء لم يعد موجوداً في ملف النموذج. حدّث الصفحة.',
    invalid_value: 'إحدى القيم غير صالحة. راجع التسميات.',
  };
  const detail = typeof caught.body?.detail === 'string' ? ` (${caught.body.detail})` : '';
  return (MAP[caught.code] ?? 'تعذر حفظ الحقول.') + detail;
}
