import { useEffect, useState } from 'react';
import { SlidersHorizontal, X, Plus } from 'lucide-react';

import { api } from '../api.js';
import { Button, Card, TextField } from './ui.jsx';

/**
 * Criteria against the admin-defined metadata fields.
 *
 * The field list comes from the server and changes with the selected type, so a
 * deployment that defines its own vocabulary gets its own form with no change
 * here. Each criterion carries the field's data type as `op`, because the server
 * uses it to pick which typed column to compare — a number filter must not
 * become a string comparison on the way through.
 *
 * ─── Scope ──────────────────────────────────────────────────────────────────
 *
 * Custom fields only. Type, label and the date ranges used to live here too and
 * now belong to the filter bar, which asks the same questions on the folder
 * listing. Keeping both would have meant two controls for one filter, on one
 * screen, with only one of them reaching the server.
 */
export default function SearchCriteria({ value, onChange, onSearch, onClear, typeId = null }) {
  const [fields, setFields] = useState([]);

  // Which custom fields exist depends on the chosen document type, and the type
  // is chosen in the filter bar — so it arrives as a prop rather than being
  // asked for twice. Two controls for one question is how the two copies come
  // to disagree, and only one of them can be the one the server is told about.
  useEffect(() => {
    api.metadata
      .fields(typeId || undefined)
      .then((result) => setFields(result.fields))
      .catch(() => setFields([]));
  }, [typeId]);

  const set = (patch) => onChange({ ...value, ...patch });

  function setCriterion(index, patch) {
    const next = [...(value.fields ?? [])];
    next[index] = { ...next[index], ...patch };
    set({ fields: next });
  }

  function addCriterion() {
    set({ fields: [...(value.fields ?? []), { fieldId: '', op: 'text', value: '' }] });
  }

  function removeCriterion(index) {
    set({ fields: (value.fields ?? []).filter((_, n) => n !== index) });
  }

  return (
    <Card className="p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <SlidersHorizontal size={15} className="text-primary" />
        قيود على الحقول الوصفية
      </h3>

      {(value.fields ?? []).length > 0 ? (
        <div className="mt-3 space-y-2">
          {value.fields.map((criterion, index) => {
            const definition = fields.find((f) => String(f.fieldId) === String(criterion.fieldId));
            return (
              <div key={index} className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-muted/40 p-2">
                <label className="block min-w-[10rem] flex-1">
                  <span className="mb-1 block text-xs text-text-muted">الحقل</span>
                  <select
                    value={criterion.fieldId}
                    onChange={(event) => {
                      const picked = fields.find((f) => String(f.fieldId) === event.target.value);
                      // The data type travels with the criterion so the server
                      // compares the right column rather than guessing.
                      setCriterion(index, {
                        fieldId: event.target.value,
                        op: picked?.dataType ?? 'text',
                        value: '',
                        min: '',
                        max: '',
                      });
                    }}
                    className={selectClass}
                  >
                    <option value="">اختر حقلاً</option>
                    {fields.map((field) => (
                      <option key={field.fieldId} value={field.fieldId}>
                        {field.name}
                      </option>
                    ))}
                  </select>
                </label>

                <CriterionValue
                  definition={definition}
                  criterion={criterion}
                  onChange={(patch) => setCriterion(index, patch)}
                />

                <button
                  onClick={() => removeCriterion(index)}
                  aria-label="إزالة الشرط"
                  className="rounded border border-border p-2 text-text-muted hover:bg-red-50 hover:text-red-600"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 flex flex-row flex-wrap items-center gap-2">
        <Button onClick={onSearch}>بحث</Button>
        <Button variant="secondary" icon={Plus} onClick={addCriterion}>
          شرط حقل
        </Button>
        <Button variant="secondary" onClick={onClear}>
          مسح
        </Button>
      </div>
    </Card>
  );
}

const selectClass =
  'w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/40';

/** The input a criterion needs depends on the field's type. */
function CriterionValue({ definition, criterion, onChange }) {
  if (!definition) return null;

  if (definition.dataType === 'number' || definition.dataType === 'date') {
    const type = definition.dataType === 'date' ? 'date' : 'text';
    return (
      <>
        <label className="block w-32">
          <span className="mb-1 block text-xs text-text-muted">من</span>
          <input
            type={type}
            dir="ltr"
            value={criterion.min ?? ''}
            onChange={(event) => onChange({ min: event.target.value })}
            className={selectClass}
          />
        </label>
        <label className="block w-32">
          <span className="mb-1 block text-xs text-text-muted">إلى</span>
          <input
            type={type}
            dir="ltr"
            value={criterion.max ?? ''}
            onChange={(event) => onChange({ max: event.target.value })}
            className={selectClass}
          />
        </label>
      </>
    );
  }

  if (definition.dataType === 'choice' || definition.dataType === 'multiselect') {
    return (
      <label className="block min-w-[10rem] flex-1">
        <span className="mb-1 block text-xs text-text-muted">القيمة</span>
        <select
          value={criterion.value ?? ''}
          onChange={(event) => onChange({ value: event.target.value })}
          className={selectClass}
        >
          <option value="">—</option>
          {definition.choices.map((choice) => (
            <option key={choice.choiceId} value={choice.choiceId}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (definition.dataType === 'bool') {
    return (
      <label className="block w-32">
        <span className="mb-1 block text-xs text-text-muted">القيمة</span>
        <select
          value={criterion.value ?? ''}
          onChange={(event) => onChange({ value: event.target.value })}
          className={selectClass}
        >
          <option value="">—</option>
          <option value="true">نعم</option>
          <option value="false">لا</option>
        </select>
      </label>
    );
  }

  return (
    <TextField
      label="القيمة"
      value={criterion.value ?? ''}
      onChange={(event) => onChange({ value: event.target.value })}
      className="min-w-[10rem] flex-1"
    />
  );
}
