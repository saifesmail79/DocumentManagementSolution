/**
 * The question asked when more than one document is selected at once.
 *
 * ─── Why this is asked at all ───────────────────────────────────────────────
 *
 * Picking several files is ambiguous, and only the person picking them knows
 * which they meant. Five invoices are five documents. Five scans of one
 * contract are one document that came out of the feeder in five pieces. Both
 * arrive as the same thing — a FileList of length five — and guessing wrong is
 * expensive in both directions: five documents that should have been one leave
 * the archive with four orphan pages nobody will ever find, and one document
 * that should have been five buries four of them inside a sixth.
 *
 * So the trigger is purely the COUNT. One file is unambiguous and is filed with
 * no interruption; more than one raises this, once, before anything is sent.
 *
 * ─── Why the title is asked for here ────────────────────────────────────────
 *
 * Filing as one entry needs a title, and there is no good way to derive it. The
 * first filename is a poor guess — "scan_0001.pdf" is not what the document is
 * called — and inventing one silently means the user finds out what their
 * document is named only after it is filed. The field is pre-filled from the
 * first file so pressing straight through still works, and it is only shown for
 * the mode that actually needs it.
 */

import { useEffect, useMemo, useState } from 'react';
import { Files, FileStack, Layers } from 'lucide-react';

import { Modal } from './Modal.jsx';
import { Button, TextField } from './ui.jsx';
import { formatBytes } from '../format.js';

/** Strips the extension, so a filename can seed a document title. */
function titleFrom(filename) {
  const name = String(filename ?? '').trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** One of the two answers, drawn as a large target rather than a radio button. */
function ModeChoice({ active, icon: Icon, heading, detail, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex w-full items-start gap-3 rounded-xl border p-4 text-right transition-colors
        focus:outline-none focus:ring-2 focus:ring-primary/40
        ${
          active
            ? 'border-primary bg-primary/5'
            : 'border-border bg-surface hover:bg-surface-muted/60'
        }`}
    >
      <div
        className={`shrink-0 rounded-lg p-2 ${active ? 'bg-primary/10' : 'bg-surface-muted'}`}
      >
        <Icon size={20} className={active ? 'text-primary' : 'text-text-muted'} />
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-text">{heading}</div>
        <p className="mt-0.5 text-sm text-text-muted">{detail}</p>
      </div>
    </button>
  );
}

export default function BatchFilePrompt({ files, busy = false, onCancel, onConfirm }) {
  const [mode, setMode] = useState('separate');
  const [title, setTitle] = useState('');

  const list = useMemo(() => [...(files ?? [])], [files]);
  const totalBytes = list.reduce((sum, file) => sum + (file.size ?? 0), 0);

  // Re-seeded whenever a new batch arrives, not once on mount: the same prompt
  // instance is reused for the next selection, and a stale title from the
  // previous batch would be the default for this one.
  useEffect(() => {
    setMode('separate');
    setTitle(titleFrom(list[0]?.name));
  }, [list]);

  if (list.length === 0) return null;

  const chosenTitle = title.trim() || titleFrom(list[0]?.name);

  return (
    <Modal
      open
      onClose={busy ? undefined : onCancel}
      icon={Files}
      title={`اخترت ${list.length} ملفات`}
      subtitle="هل هي وثائق منفصلة، أم وثيقة واحدة؟"
      size="md"
      footer={
        <>
          <Button
            onClick={() => onConfirm({ mode, title: mode === 'single' ? chosenTitle : undefined })}
            disabled={busy || (mode === 'single' && !chosenTitle)}
          >
            {busy
              ? 'جارٍ الرفع…'
              : mode === 'single'
                ? 'رفعها كوثيقة واحدة'
                : `رفعها كـ ${list.length} وثائق`}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <ModeChoice
            active={mode === 'separate'}
            icon={FileStack}
            heading={`وثائق منفصلة (${list.length})`}
            detail="كل ملف يصبح وثيقة مستقلة، باسم ملفه، ولها سجل إصدارات خاص بها."
            onSelect={() => setMode('separate')}
          />
          <ModeChoice
            active={mode === 'single'}
            icon={Layers}
            heading="وثيقة واحدة"
            detail="جميع الملفات تُحفظ داخل وثيقة واحدة بالترتيب المعروض، وتُفهرَس معاً للبحث."
            onSelect={() => setMode('single')}
          />
        </div>

        {mode === 'single' ? (
          <TextField
            label="عنوان الوثيقة"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            hint="يظهر هذا العنوان في القوائم والبحث بدلاً من أسماء الملفات."
            disabled={busy}
          />
        ) : null}

        <div className="rounded-xl border border-border bg-surface-muted/40">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              الملفات
            </span>
            <span className="num text-xs text-text-muted">{formatBytes(totalBytes)}</span>
          </div>
          {/* Capped in height rather than in count: a scan batch can be forty
              pages, and a list that says "and 30 more" hides exactly the file
              someone is checking for. */}
          <ul className="max-h-48 divide-y divide-border/50 overflow-y-auto">
            {list.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {/* The reading order the document will keep, shown while it
                      can still be changed by re-selecting in another order. */}
                  {mode === 'single' ? (
                    <span className="num shrink-0 text-xs text-text-muted">{index + 1}.</span>
                  ) : null}
                  <span className="truncate text-text">{file.name}</span>
                </span>
                <span className="num shrink-0 text-xs text-text-muted">
                  {formatBytes(file.size ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
