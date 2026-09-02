/**
 * Narrowing a listing by what its documents ARE — not by what they say.
 *
 * ─── Parameters, not contents ───────────────────────────────────────────────
 *
 * Every control here filters on something recorded about a document: its type,
 * its label, its tags, who filed it, when, how large it is, what kind of file
 * it holds. None of them read a word of the document itself. That distinction
 * is the point — content search already exists and answers a different
 * question, and it depends on an extraction queue that may not have caught up,
 * whereas these answer immediately and exactly.
 *
 * ─── The vocabulary is fetched, not hardcoded ───────────────────────────────
 *
 * Types, labels and tags are admin-defined; uploaders and file types are simply
 * whatever has been filed. So the options come from the server, already scoped
 * to what the viewer may browse — a dropdown offering a type they cannot see
 * any document of would both leak its existence and return nothing when picked.
 *
 * ─── Why the bar collapses ──────────────────────────────────────────────────
 *
 * Most visits to a folder are not filtered. A permanent row of eight controls
 * above every listing costs vertical space on every visit to serve a minority
 * of them, so it opens on demand — but the count of active filters stays
 * visible on the button, because a filter left on and forgotten is how a folder
 * comes to look empty.
 */

import { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

import { api } from '../api.js';
import { Button } from './ui.jsx';

/** Byte thresholds people actually think in. */
const SIZE_STEPS = [
  { label: 'أي حجم', min: '', max: '' },
  { label: 'أقل من ١ ميغابايت', min: '', max: String(1024 * 1024) },
  { label: '١ – ١٠ ميغابايت', min: String(1024 * 1024), max: String(10 * 1024 * 1024) },
  { label: 'أكبر من ١٠ ميغابايت', min: String(10 * 1024 * 1024), max: '' },
];

/** A short Arabic name for the file types that actually turn up. */
const FILE_TYPE_NAMES = {
  'application/pdf': 'PDF',
  'image/jpeg': 'صورة JPEG',
  'image/png': 'صورة PNG',
  'image/tiff': 'صورة TIFF',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'text/plain': 'نص',
};

const fileTypeName = (mime) => FILE_TYPE_NAMES[mime] ?? mime;

/** A labelled select, matching the shared field chrome in ui.jsx. */
function Select({ label, value, onChange, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
          focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        {children}
      </select>
    </label>
  );
}

function DateField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      <input
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="num w-full rounded-lg border border-border bg-control px-3 py-2 text-sm text-text
          focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </label>
  );
}

/**
 * @param {object} props
 * @param {object} props.value    the current filter object
 * @param {(next: object) => void} props.onChange
 * @param {string} [props.folderId] scopes the offered vocabulary to one subtree
 */
export default function FilterBar({ value, onChange, folderId }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .filterOptions(folderId)
      .then((result) => {
        if (!cancelled) setOptions(result);
      })
      // A failure here disables the controls rather than the listing: the
      // documents are still there and still readable without the filter bar.
      .catch(() => {
        if (!cancelled) setOptions({ types: [], labels: [], tags: [], creators: [], fileTypes: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  const active = useMemo(
    () =>
      Object.entries(value ?? {}).filter(
        ([, entry]) => entry !== null && entry !== undefined && entry !== '',
      ),
    [value],
  );

  const set = (key, next) => onChange({ ...value, [key]: next });

  const sizeIndex = SIZE_STEPS.findIndex(
    (step) => step.min === (value?.minBytes ?? '') && step.max === (value?.maxBytes ?? ''),
  );

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={open ? 'primary' : 'secondary'}
          icon={SlidersHorizontal}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
        >
          تصفية
          {/* Kept visible while the panel is shut, so a filter left on is never
              mistaken for an empty folder. */}
          {active.length > 0 ? (
            <span className="num mr-1 rounded-full bg-white/20 px-1.5 text-xs">{active.length}</span>
          ) : null}
        </Button>

        {active.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange({})}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-text-muted
              transition-colors hover:bg-surface-muted hover:text-text"
          >
            <X size={14} />
            مسح التصفية
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3 grid gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="النوع" value={value?.typeId} onChange={(next) => set('typeId', next)}>
            <option value="">كل الأنواع</option>
            {(options?.types ?? []).map((type) => (
              <option key={type.typeId} value={type.typeId}>
                {type.name} ({type.total})
              </option>
            ))}
          </Select>

          <Select label="التصنيف" value={value?.labelId} onChange={(next) => set('labelId', next)}>
            <option value="">كل التصنيفات</option>
            {(options?.labels ?? []).map((label) => (
              <option key={label.labelId} value={label.labelId}>
                {label.name} ({label.total})
              </option>
            ))}
          </Select>

          <Select label="رفعها" value={value?.createdBy} onChange={(next) => set('createdBy', next)}>
            <option value="">أي شخص</option>
            {(options?.creators ?? []).map((creator) => (
              <option key={creator.userId} value={creator.userId}>
                {creator.name} ({creator.total})
              </option>
            ))}
          </Select>

          {/* Offered from the stored names rather than as free text: tags are
              saved without Arabic normalisation, so a typed "مُراجعة" would not
              match a stored "مراجعة" and the filter would silently find nothing. */}
          <Select label="الوسم" value={value?.tags} onChange={(next) => set('tags', next)}>
            <option value="">أي وسم</option>
            {(options?.tags ?? []).map((tag) => (
              <option key={tag.tagId} value={tag.name}>
                {tag.name} ({tag.total})
              </option>
            ))}
          </Select>

          <Select
            label="نوع الملف"
            value={value?.mimeTypes}
            onChange={(next) => set('mimeTypes', next)}
          >
            <option value="">أي نوع ملف</option>
            {(options?.fileTypes ?? []).map((type) => (
              <option key={type.mimeType} value={type.mimeType}>
                {fileTypeName(type.mimeType)} ({type.total})
              </option>
            ))}
          </Select>

          <Select
            label="الحجم"
            value={sizeIndex > 0 ? String(sizeIndex) : ''}
            onChange={(next) => {
              const step = SIZE_STEPS[Number(next) || 0];
              onChange({ ...value, minBytes: step.min || null, maxBytes: step.max || null });
            }}
          >
            {SIZE_STEPS.map((step, index) => (
              <option key={step.label} value={index === 0 ? '' : index}>
                {step.label}
              </option>
            ))}
          </Select>

          <DateField
            label="أُضيفت من"
            value={value?.createdFrom}
            onChange={(next) => set('createdFrom', next)}
          />
          <DateField
            label="أُضيفت حتى"
            value={value?.createdTo}
            onChange={(next) => set('createdTo', next)}
          />

          <DateField
            label="عُدّلت من"
            value={value?.updatedFrom}
            onChange={(next) => set('updatedFrom', next)}
          />
          <DateField
            label="عُدّلت حتى"
            value={value?.updatedTo}
            onChange={(next) => set('updatedTo', next)}
          />

          <Select
            label="عدد الملفات"
            value={value?.multiFile}
            onChange={(next) => set('multiFile', next)}
          >
            {/* Three states, not a checkbox: "either" is a real answer and is
                not the same as "only single-file documents". */}
            <option value="">الكل</option>
            <option value="true">وثائق متعددة الملفات</option>
            <option value="false">وثائق بملف واحد</option>
          </Select>
        </div>
      ) : null}
    </div>
  );
}
