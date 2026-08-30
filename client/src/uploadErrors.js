import { ApiError } from './api.js';

/**
 * Turns a failed upload into a sentence that says what went wrong.
 *
 * ─── Why this is shared ─────────────────────────────────────────────────────
 *
 * There are three ways to put a file into this system — the file picker, a
 * dropped folder, and the scanner panel — and each had its own handling. Two of
 * them caught the error with a bare `catch {}` and reported the filename with no
 * reason at all; the scanner reported one fixed sentence for every possible
 * failure.
 *
 * That produced the report this was written for: an administrator set the
 * duplicate policy to "block", uploaded a document that was already filed, and
 * saw nothing useful. The server had refused it correctly, with HTTP 409 and the
 * list of documents it collided with. All of that was discarded on arrival.
 *
 * ─── Naming the collision ───────────────────────────────────────────────────
 *
 * For a blocked duplicate, the filename alone is not enough — the next question
 * is always "where is the copy I already have?". The server sends it, so it is
 * shown.
 */
export function describeUploadFailure(caught, filename) {
  const name = filename ? `${filename}: ` : '';

  if (!(caught instanceof ApiError)) {
    // A network failure, or the browser refusing the request. Not the server's
    // answer, so do not dress it up as one.
    return `${name}تعذر الاتصال بالخادم`;
  }

  const body = caught.body ?? {};

  switch (caught.code) {
    case 'duplicate': {
      // The match is always in the destination folder now, so naming the folder
      // would only repeat where the user already is. Naming the document is the
      // useful half — it is what they open to check before deciding.
      const which = (body.duplicates ?? [])
        .slice(0, 3)
        .map((d) => `«${d.title}»`)
        .join('، ');

      return which
        ? `${name}يوجد الملف نفسه في هذا المجلد بالفعل باسم ${which}، ولم يُرفع مرة أخرى.`
        : `${name}يوجد الملف نفسه في هذا المجلد بالفعل، ولم يُرفع مرة أخرى.`;
    }

    case 'too_large':
      return `${name}حجم الملف يتجاوز الحد المسموح`;

    case 'required_field':
      return `${name}حقول إلزامية ناقصة${body.detail ? ` (${body.detail})` : ''}`;

    case 'invalid_title':
      return `${name}اسم غير صالح`;

    case 'empty_file':
      return `${name}الملف فارغ`;

    case 'no_file':
      return `${name}لم يصل أي ملف`;

    case 'forbidden':
      return `${name}لا تملك صلاحية الرفع في هذا المجلد`;

    case 'not_found':
      return `${name}المجلد غير موجود`;

    case 'storage_failed':
    case 'storage_unavailable':
      return `${name}تعذّر الكتابة إلى وحدة التخزين — راجع مدير النظام`;

    default:
      // An unmapped code is still more use than nothing: it gives the
      // administrator something to search the logs for.
      return `${name}${body.error ?? caught.code ?? 'فشل غير معروف'}`;
  }
}
