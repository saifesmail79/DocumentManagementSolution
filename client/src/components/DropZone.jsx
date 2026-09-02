import { useCallback, useRef, useState } from 'react';
import { UploadCloud, Files } from 'lucide-react';

/**
 * Drag-and-drop upload target for files.
 *
 * ─── Why the counter ────────────────────────────────────────────────────────
 *
 * dragenter and dragleave fire for every child element the pointer crosses, so
 * a naive boolean flickers off the moment the cursor passes over the icon
 * inside the zone. Counting enters minus leaves is the standard fix and the
 * reason this is a component rather than four lines inline.
 *
 * ─── Folders are refused, on purpose ────────────────────────────────────────
 *
 * This used to walk a dropped directory and recreate its structure. It was
 * removed with the "رفع مجلد" button: selecting the files inside a folder does
 * the same filing in one step, and the tree walk was a second upload path with
 * its own limits, its own error handling and its own way of being wrong.
 *
 * The entries are still read — but only to notice that a directory was dropped
 * and say so, rather than accepting the drop and silently filing nothing. A
 * dropped directory contributes no File to dataTransfer.files, so without this
 * check the drop would look accepted and produce no document at all.
 */
export default function DropZone({ onFiles, disabled, children }) {
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

      if (directories.length > 0) {
        setNote('لا يمكن رفع المجلدات — افتح المجلد واسحب ملفاته.');
      }

      const files = plainFiles.filter((file) => !(file.size === 0 && file.type === ''));
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles, reset],
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
          <p className="text-sm font-medium text-primary">أفلت الملفات هنا</p>
          <p className="flex items-center gap-1 text-xs text-primary/80">
            <Files size={12} />
            عند إفلات أكثر من ملف يُسأل: وثائق منفصلة أم وثيقة واحدة
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

