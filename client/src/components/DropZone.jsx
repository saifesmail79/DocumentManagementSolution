import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FolderTree } from 'lucide-react';

/**
 * Drag-and-drop upload target, including whole folders.
 *
 * ─── Why the counter ────────────────────────────────────────────────────────
 *
 * dragenter and dragleave fire for every child element the pointer crosses, so
 * a naive boolean flickers off the moment the cursor passes over the icon
 * inside the zone. Counting enters minus leaves is the standard fix and the
 * reason this is a component rather than four lines inline.
 *
 * ─── Reading a dropped folder ───────────────────────────────────────────────
 *
 * A dropped directory only exists as a DataTransferItem entry, and those are
 * live for exactly one tick — the entry list has to be captured synchronously
 * in the drop handler, before any await. Walking it afterwards is fine; asking
 * for it afterwards returns nothing, which is the bug everyone writes first.
 *
 * The walk yields each file with its relative path, so the caller can recreate
 * the directory structure rather than flattening it into one folder.
 */
export default function DropZone({ onFiles, onTree, disabled, children }) {
  const [active, setActive] = useState(false);
  const [note, setNote] = useState(null);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  const onDragEnter = useCallback(
    (event) => {
      if (disabled) return;
      event.preventDefault();
      depth.current += 1;
      setActive(true);
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (event) => {
      event.preventDefault();
      depth.current -= 1;
      if (depth.current <= 0) reset();
    },
    [reset],
  );

  const onDragOver = useCallback(
    (event) => {
      if (disabled) return;
      // Without preventDefault the browser navigates to the dropped file, which
      // looks like the page crashing.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [disabled],
  );

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      reset();
      if (disabled) return;

      setNote(null);

      // Captured synchronously: these entries are invalid after the first await.
      const entries = [...(event.dataTransfer.items ?? [])]
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean);

      const plainFiles = [...(event.dataTransfer.files ?? [])];

      if (entries.length === 0) {
        if (plainFiles.length > 0) onFiles(plainFiles);
        return;
      }

      const directories = entries.filter((entry) => entry.isDirectory);

      if (directories.length > 0 && onTree) {
        setNote('جارٍ قراءة محتويات المجلد…');
        walkEntries(entries)
          .then((walked) => {
            setNote(null);
            if (walked.length === 0) setNote('المجلد فارغ.');
            else onTree(walked);
          })
          .catch(() => setNote('تعذرت قراءة محتويات المجلد.'));
        return;
      }

      if (directories.length > 0) {
        setNote('لا يمكن رفع المجلدات هنا — اسحب الملفات مباشرة.');
      }

      const files = plainFiles.filter((file) => !(file.size === 0 && file.type === ''));
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles, onTree, reset],
  );

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`relative rounded-xl transition-colors ${active ? 'ring-2 ring-primary ring-offset-2' : ''}`}
    >
      {children}

      {active ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center
            gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px]"
        >
          <UploadCloud size={28} className="text-primary" />
          <p className="text-sm font-medium text-primary">أفلت الملفات أو المجلدات هنا</p>
          <p className="flex items-center gap-1 text-xs text-primary/80">
            <FolderTree size={12} />
            يُحافَظ على هيكل المجلدات
          </p>
        </div>
      ) : null}

      {note ? (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-600">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** Guards against a pathological drop and against a symlink loop. */
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 12;

/**
 * Walks dropped entries into a flat list of `{ file, path }`.
 *
 * `path` is the directory chain relative to the drop, so the caller can
 * recreate it. A file dropped on its own has an empty path.
 */
async function walkEntries(entries) {
  const collected = [];

  async function visit(entry, prefix, level) {
    if (collected.length >= MAX_ENTRIES || level > MAX_DEPTH) return;

    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file) collected.push({ file, path: prefix });
      return;
    }

    if (!entry.isDirectory) return;

    const reader = entry.createReader();
    const nextPrefix = [...prefix, entry.name];

    // readEntries returns at most 100 at a time and signals the end with an
    // empty batch. Reading once — which the obvious implementation does —
    // silently drops everything past the hundredth file.
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) break;
      for (const child of batch) await visit(child, nextPrefix, level + 1);
    }
  }

  for (const entry of entries) await visit(entry, [], 0);
  return collected;
}
