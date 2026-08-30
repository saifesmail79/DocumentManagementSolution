import { Alert } from './ui.jsx';

/**
 * Whether this document's contents can be searched, and why not when they can't.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Text extraction happens on a queue after the upload responds. When it fails —
 * an unreadable file, a missing OCR engine, a worker that died — the outcome was
 * written to a database table and shown to nobody. The document appeared in
 * listings, opened normally, and looked in every respect like one that had been
 * indexed. Searching inside it simply never found anything, and there was no way
 * for the person who filed it to discover that.
 *
 * Four of the five states are worth saying out loud. The fifth, a document
 * indexed exactly as it should be, renders nothing: a banner shown on every
 * document is a banner nobody reads.
 */

/** documents.extraction_status — mirrors DOC_EXTRACTION in the extraction worker. */
export const EXTRACTION = Object.freeze({
  PENDING: 0,
  EXTRACTED: 1,
  UNSUPPORTED: 2,
  FAILED: 3,
  OCR_EXTRACTED: 4,
});

export default function SearchabilityNotice({ status, reason }) {
  const state = Number(status ?? EXTRACTION.PENDING);

  if (state === EXTRACTION.EXTRACTED) return null;

  if (state === EXTRACTION.PENDING) {
    return (
      <Alert tone="warning">
        جارٍ فهرسة محتوى هذه الوثيقة — لن تظهر في نتائج البحث بالمحتوى حتى تكتمل الفهرسة.
        البحث بالعنوان يعمل الآن.
      </Alert>
    );
  }

  if (state === EXTRACTION.UNSUPPORTED) {
    return (
      <Alert tone="warning">
        لا يمكن استخراج نص من هذا الملف، لذلك لا يمكن البحث في محتواه — البحث بالعنوان
        والبيانات الوصفية يعمل كالمعتاد.
        {reason ? <span className="mt-1 block text-xs opacity-80">السبب: {reason}</span> : null}
      </Alert>
    );
  }

  if (state === EXTRACTION.FAILED) {
    return (
      <Alert tone="error">
        فشلت فهرسة محتوى هذه الوثيقة، ولن تظهر في نتائج البحث بالمحتوى. أبلغ مدير النظام —
        يمكنه إعادة الفهرسة بعد معالجة السبب.
        {reason ? (
          // The raw reason, deliberately. It is what the administrator needs in
          // order to act, and paraphrasing it would lose the only detail that
          // distinguishes "install this tool" from "this file is corrupt".
          <span className="mt-1 block text-xs opacity-80" dir="ltr">
            {reason}
          </span>
        ) : null}
      </Alert>
    );
  }

  if (state === EXTRACTION.OCR_EXTRACTED) {
    return (
      <Alert tone="info">
        قُرئ محتوى هذه الوثيقة بالتعرّف الضوئي على النصوص (OCR)، فقد لا يكون البحث فيها
        دقيقاً تماماً.
      </Alert>
    );
  }

  return null;
}
