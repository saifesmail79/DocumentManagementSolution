import { useEffect, useState } from 'react';
import { SlidersHorizontal, X, Plus } from 'lucide-react';

import { api } from '../api.js';
import { Button, Card, TextField } from './ui.jsx';

/**
 * The multi-criteria search form.
 *
 * The field list comes from the server and changes with the selected type, so a
 * deployment that defines its own vocabulary gets its own form with no change
 * here. Each criterion carries the field's data type as `op`, because the server
 * uses it to pick which typed column to compare — a number filter must not
 * become a string comparison on the way through.
 */
export default function SearchCriteria({ value, onChange, onSearch, onClear }) {
  const [types, setTypes] = useState([]);
  const [labels, setLabels] = useState([]);
  const [fields, setFields] = useState([]);

  useEffect(() => {
    Promise.all([api.metadata.types(), api.metadata.labels()])
      .then(([t, l]) => {
        setTypes(t.types);
        setLabels(l.labels);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.metadata
      .fields(value.typeId || undefined)
      .then((result) => setFields(result.fields))
      .catch(() => setFields([]));
  }, [value.typeId]);

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
        بحث متقدّم
      </h3>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">النوع</span>
          <select
            value={value.typeId ?? ''}
            onChange={(event) => set({ typeId: event.target.value, fields: [] })}
            className={selectClass}
          >
            <option value="">أي نوع</option>
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
            value={value.labelId ?? ''}
            onChange={(event) => set({ labelId: event.target.value })}
            className={selectClass}
          >
            <option value="">أي درجة</option>
            {labels.map((label) => (
              <option key={label.labelId} value={label.labelId}>
                {label.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">من تاريخ</span>
          <input
            type="date"
            dir="ltr"
            value={value.createdFrom ?? ''}
            onChange={(event) => set({ createdFrom: event.target.value })}
            className={selectClass}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text">إلى تاريخ</span>
          <input
            type="date"
            dir="ltr"
            value={value.createdTo ?? ''}
            onChange={(event) => set({ createdTo: event.target.value })}
            className={selectClass}
          />
        </label>
      </div>

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
