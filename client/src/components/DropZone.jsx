import { useCallback, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';

/**
 * Drag-and-drop upload target.
 *
 * ─── Why the counter ────────────────────────────────────────────────────────
 *
 * dragenter and dragleave fire for every child element the pointer crosses, so
 * a naive boolean flickers off the moment the cursor passes over the icon
 * inside the zone. Counting enters minus leaves is the standard fix and the
 * reason this is a component rather than four lines inline.
 *
 * ─── Directories ────────────────────────────────────────────────────────────
 *
 * A dropped folder arrives as a DataTransferItem with no file behind it.
 * Uploading directory structure is a separate Tier 2 feature, so folders are
 * filtered out here with a clear message rather than failing silently or
 * uploading a zero-byte entry named after the folder.
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

  const onDragLeave = useCallback((event) => {
    event.preventDefault();
    depth.current -= 1;
    if (depth.current <= 0) reset();
  }, [reset]);

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

      const items = [...(event.dataTransfer.items ?? [])];
      const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
      const hadDirectory = entries.some((entry) => entry.isDirectory);

      const files = [...(event.dataTransfer.files ?? [])].filter((file) => {
        // A directory shows up as a File with no type and no size. Not a
        // reliable test on its own, which is why the entry check above runs too.
        return !(hadDirectory && file.size === 0 && file.type === '');
      });

      setNote(hadDirectory ? 'لا يمكن رفع المجلدات — اسحب الملفات مباشرة.' : null);
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
      className={`relative rounded-xl transition-colors ${
        active ? 'ring-2 ring-primary ring-offset-2' : ''
      }`}
    >
      {children}

      {active ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center
            gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px]"
        >
          <UploadCloud size={28} className="text-primary" />
          <p className="text-sm font-medium text-primary">أفلت الملفات هنا للرفع</p>
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
