/**
 * Word template helpers for the letter formats (النماذج) — pure functions over
 * bytes, with no database and no storage in sight.
 *
 * ─── Why the template is a Word file and not an editor in the browser ───────
 *
 * The institute already designs its letterheads in Word: the logo, the margins,
 * the ministry line, the table of signatures. A visual designer built here
 * would be a worse Word that still had to be taught all of that. So the
 * variable parts are written {{like_this}} in the Word file itself, and this
 * module's only job is to say honestly whether a given .docx can be used, which
 * placeholders it contains, and what it looks like once they are filled.
 *
 * ─── Discovery uses docxtemplater, never a regular expression ───────────────
 *
 * A regex over word/document.xml finds the wrong things and misses the right
 * ones: Word splits a single {{name}} across several <w:r> runs the moment
 * anyone corrects a typo inside it, it stores field codes as text, and it keeps
 * headers and footers in separate parts. docxtemplater's own lexer already
 * solves all three, and InspectModule exposes what it found, so the list of
 * placeholders this file reports is by construction the list the renderer will
 * later substitute. Anything else would let the administrator label a
 * placeholder that never gets filled.
 *
 * ─── Refusals are values, not exceptions ────────────────────────────────────
 *
 * The design sketched these helpers as throwing a typed error. They return
 * `{ ok: false, reason, detail }` instead, because that is what every service
 * in this codebase does with an expected refusal, and an invalid template is
 * entirely expected — it is the normal outcome of a first upload. The callers
 * are services that must turn the refusal into a reason anyway, so a throw
 * would only add a try/catch at every call site. Genuinely unexpected failures
 * (a corrupt zip caught mid-inflate) still surface as `{ ok: false }`, with the
 * library's own explanation carried in `detail`.
 *
 * ─── The archive is walked before anything is inflated ──────────────────────
 *
 * A .docx is a zip, and a zip is a file format its author controls entirely.
 * Entry names are checked against an allow-list and the DECLARED uncompressed
 * sizes are summed before a single part is decompressed, so a small upload that
 * claims to expand to a terabyte is refused rather than expanded. External
 * relationships, DOCTYPE/ENTITY declarations and the INCLUDETEXT/DDE family of
 * field instructions are refused for the same reason: this file is handed to
 * LibreOffice, which will follow every one of them.
 */

/** A placeholder name is an identifier, matched byte for byte by the renderer. */
export const MAX_PLACEHOLDER_LENGTH = 100;

/**
 * Placeholders the server fills and never asks of anyone.
 *
 * The date and the author of an official letter are facts about the act of
 * writing it, not fields a person types. Leaving them writable would mean any
 * user could issue a letter dated last year over somebody else's name.
 */
export const BUILT_IN_PLACEHOLDERS = Object.freeze(['date', 'date_iso', 'date_ar', 'author']);

export function isBuiltIn(placeholder) {
  return BUILT_IN_PLACEHOLDERS.includes(placeholder);
}

/**
 * Prefix characters docxtemplater reads as a module rather than a value: loops,
 * inverted sections, raw XML, closing tags and the paid modules. A template
 * that uses them is not a form with fields, so it is refused outright rather
 * than half-supported.
 */
const MODULE_PREFIXES = ['@', '#', '/', '^', '-', '*', '%', '$', '+', '~', '.', ':', '>', '<', '='];

/** Parts a Word document may contain. Everything else is refused by name. */
const ALLOWED_ENTRY_PREFIXES = ['_rels/', 'docProps/', 'word/', 'customXml/'];
const ALLOWED_ENTRY_NAMES = ['[Content_Types].xml'];

/** A zip bomb is a small file that claims to be an enormous one. */
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_PART_UNCOMPRESSED = 50 * 1024 * 1024;

/**
 * Field instructions that make Word or LibreOffice fetch something else while
 * rendering. A template is a document, not a program.
 */
const FORBIDDEN_FIELDS = ['INCLUDEPICTURE', 'INCLUDETEXT', 'DDEAUTO', 'DDE', 'IMPORT'];

/**
 * External relationship types that are safe: nothing fetches them when the
 * document is opened or converted. A hyperlink is a link the reader may click
 * in the PDF; an attached template is a note of which .dotx the document was
 * based on. Every institute letterhead carries a website and a mail address in
 * its footer, so refusing these would refuse the real templates while
 * blocking nothing.
 *
 * Everything else external — an image, an OLE object, a chart, a subdocument,
 * a frame — is content LibreOffice would resolve on load, which is the whole
 * reason external targets are refused.
 */
const HARMLESS_EXTERNAL = new Set(['hyperlink', 'attachedTemplate', 'mailTo']);

/** The type of the first external relationship that is not harmless, or null. */
function forbiddenExternalRelationship(xml) {
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/gi)) {
    const element = match[0];
    if (!/TargetMode\s*=\s*"External"/i.test(element)) continue;
    const type = /\bType\s*=\s*"([^"]*)"/i.exec(element)?.[1] ?? '';
    const kind = type.slice(type.lastIndexOf('/') + 1);
    if (!HARMLESS_EXTERNAL.has(kind)) return kind || 'unknown';
  }
  return null;
}

/**
 * The text of the field instructions in one XML part, and nothing else.
 *
 * An instruction lives in a <w:instrText> run or in the w:instr attribute of a
 * <w:fldSimple>. It never lives in the attributes Word writes by itself
 * (w14:paraId, w14:textId, w:rsidR are random uppercase hex, so «DDE» turns up
 * in them by chance on any long document), in a theme colour (w:fill="DDEBF7"),
 * or in the visible text of a <w:t> (the English word «Important»). Scanning the
 * whole part refused those documents; scanning the instructions refuses only
 * what actually instructs Word to fetch something.
 *
 * Word may split one instruction across several runs, so the runs are joined
 * with no separator: «INCLUDE» + «TEXT» must still read as INCLUDETEXT.
 */
function fieldInstructions(xml) {
  let out = '';
  for (const match of xml.matchAll(
    /<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>|<w:fldSimple\b[^>]*\bw:instr\s*=\s*"([^"]*)"/gi,
  )) {
    out += (match[1] ?? match[2] ?? '').replace(/<[^>]*>/g, '');
  }
  return out.toUpperCase();
}

/**
 * True when the instruction text names this field as a word of its own. The
 * boundary is what keeps FORBIDDEN from reading as DDE and IMPORTANT as IMPORT
 * once a genuine instruction happens to contain either word.
 */
function namesField(instructions, field) {
  return new RegExp(`(^|[^A-Z])${field}([^A-Z]|$)`).test(instructions);
}

const refuse = (detail) => ({ ok: false, reason: 'template_invalid', detail });

/** The zip magic. A .docx that does not start with it is something else. */
export function looksLikeDocx(buffer, filename) {
  const name = String(filename ?? '').toLowerCase();
  if (!name.endsWith('.docx')) {
    return { ok: false, reason: 'blocked_extension', detail: 'يجب أن يكون الملف بامتداد .docx' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { ok: false, reason: 'template_invalid', detail: 'الملف فارغ' };
  }
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) {
    return { ok: false, reason: 'template_invalid', detail: 'الملف ليس مستند Word (docx)' };
  }
  return { ok: true };
}

/** The declared uncompressed size of one entry, without inflating it. */
function declaredSize(entry) {
  const size = entry?._data?.uncompressedSize;
  return Number.isFinite(size) ? Number(size) : 0;
}

function entryText(zip, name) {
  try {
    return zip.file(name)?.asText() ?? null;
  } catch {
    return null;
  }
}

/**
 * Structural validation of the archive. Returns the opened zip so a caller that
 * needs the bytes again does not pay for a second parse.
 */
export async function validateDocxArchive(buffer) {
  const { default: PizZip } = await import('pizzip');

  let zip;
  try {
    zip = new PizZip(buffer);
  } catch (error) {
    return refuse(`تعذّر قراءة الملف كأرشيف: ${String(error.message).slice(0, 200)}`);
  }

  const names = Object.keys(zip.files);
  if (names.length === 0) return refuse('الأرشيف فارغ');

  let total = 0;
  for (const name of names) {
    const entry = zip.files[name];
    if (name.includes('..')) return refuse(`اسم غير مقبول داخل الأرشيف: ${name}`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      return refuse(`اسم غير مقبول داخل الأرشيف: ${name}`);
    }

    const allowed =
      ALLOWED_ENTRY_NAMES.includes(name) ||
      ALLOWED_ENTRY_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!allowed) return refuse(`جزء غير متوقع داخل الملف: ${name}`);

    if (name.toLowerCase() === 'word/vbaproject.bin') {
      return refuse('الملف يحتوي وحدات ماكرو (vbaProject.bin)');
    }

    if (entry.dir) continue;

    const size = declaredSize(entry);
    if (size > MAX_PART_UNCOMPRESSED) return refuse(`جزء كبير جدًا داخل الملف: ${name}`);
    total += size;
    if (total > MAX_TOTAL_UNCOMPRESSED) return refuse('حجم الملف بعد فك الضغط كبير جدًا');
  }

  if (!zip.file('word/document.xml')) return refuse('الملف لا يحتوي word/document.xml');

  // Relationships and XML parts, inflated only now that the declared sizes have
  // been found sane.
  for (const name of names) {
    if (zip.files[name].dir) continue;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.xml') && !lower.endsWith('.rels')) continue;

    const text = entryText(zip, name);
    if (text === null) return refuse(`تعذّر قراءة الجزء: ${name}`);

    if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
      return refuse(`الجزء ${name} يحتوي تعريف DOCTYPE أو ENTITY`);
    }

    if (lower.endsWith('.rels')) {
      const external = forbiddenExternalRelationship(text);
      if (external) return refuse(`الجزء ${name} يحتوي علاقة خارجية من نوع ${external}`);
    }

    const isContentPart =
      lower === 'word/document.xml' || /^word\/(header|footer)[0-9]*\.xml$/.test(lower);
    if (isContentPart) {
      const instructions = fieldInstructions(text);
      for (const field of FORBIDDEN_FIELDS) {
        if (namesField(instructions, field)) return refuse(`الجزء ${name} يحتوي حقل ${field}`);
      }
    }
  }

  return { ok: true, zip };
}

/**
 * Compiles the template and reports its placeholders in reading order: the body
 * first, then the headers and footers by name, so the administrator's field
 * list matches the order they are used to seeing on the page.
 */
export async function inspectTemplate(buffer) {
  const structural = await validateDocxArchive(buffer);
  if (!structural.ok) return structural;

  const [{ default: PizZip }, { default: Docxtemplater }, { default: inspectFactory }] =
    await Promise.all([
      import('pizzip'),
      import('docxtemplater'),
      import('docxtemplater/js/inspect-module.js'),
    ]);

  // The CommonJS module exports a FACTORY, not the class — verified in
  // node_modules: `module.exports = function () { return new InspectModule(); }`
  // — so `new` on it would build the wrong object. The guard keeps this working
  // if a later version exports the class itself, as its .d.ts already claims.
  const inspect =
    typeof inspectFactory === 'function' && !inspectFactory.prototype?.getAllTags
      ? inspectFactory()
      : new inspectFactory();

  let structured;
  try {
    const doc = new Docxtemplater(new PizZip(buffer), {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
      // Without this the library prints its multi-error report to stderr, which
      // in a server log reads as a crash rather than as a refused upload.
      errorLogging: false,
      modules: [inspect],
    });

    structured = [];
    for (const file of orderParts(inspect.getTemplatedFiles?.() ?? [], doc)) {
      let tags;
      try {
        tags = inspect.getStructuredTags(file);
      } catch {
        // A templated part with nothing in it was never inspected.
        continue;
      }
      for (const tag of tags) structured.push({ file, value: tag.value, module: tag.module });
    }
  } catch (error) {
    return refuse(explainTemplateError(error));
  }

  const tags = [];
  const seen = new Set();
  for (const tag of structured) {
    if (tag.module) {
      // A loop, an inverted section or raw XML. The field model here is flat.
      return refuse(`الوسم {{${tag.value}}} في ${tag.file} يستخدم تركيبًا غير مدعوم`);
    }
    const name = String(tag.value ?? '');
    const problem = placeholderProblem(name);
    if (problem) return refuse(problem);
    if (seen.has(name)) continue;
    seen.add(name);
    tags.push(name);
  }

  if (tags.length === 0) return refuse('لا يحتوي الملف أي حقل بالشكل {{الاسم}}');

  return { ok: true, tags };
}

/** word/document.xml first, then the remaining templated parts by name. */
function orderParts(files, doc) {
  const unique = [...new Set(files.length > 0 ? files : (doc?.templatedFiles ?? []))];
  const body = unique.filter((file) => file === 'word/document.xml');
  const rest = unique.filter((file) => file !== 'word/document.xml').sort();
  return [...body, ...rest];
}

/** The library's own explanation of every bad tag, flattened into one line. */
function explainTemplateError(error) {
  const errors = error?.properties?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((entry) => entry?.properties?.explanation ?? entry?.message ?? String(entry))
      .slice(0, 10)
      .join('؛ ');
  }
  return String(error?.properties?.explanation ?? error?.message ?? error).slice(0, 300);
}

/** Why this placeholder cannot be used, or null when it is fine. */
export function placeholderProblem(name) {
  if (name === '') return 'يوجد وسم فارغ {{}}';
  if (name !== name.trim()) return `الوسم {{${name}}} يبدأ أو ينتهي بمسافة`;
  if (name.length > MAX_PLACEHOLDER_LENGTH) {
    return `اسم الوسم أطول من ${MAX_PLACEHOLDER_LENGTH} حرفًا: ${name.slice(0, 40)}…`;
  }
  if (MODULE_PREFIXES.includes(name[0])) {
    return `الوسم {{${name}}} يبدأ بحرف محجوز (${name[0]})`;
  }
  if (/[\r\n\t]/.test(name)) return `الوسم {{${name}}} يحتوي سطرًا جديدًا`;
  return null;
}

/**
 * The values the server supplies for the built-in placeholders.
 *
 * Latin digits in {{date}} deliberately: an Iraqi official letter is dated
 * 27/09/2026, not with Arabic-Indic digits. The long Arabic form is offered
 * separately, for a template that wants the month spelled out.
 */
export function builtInValues({ displayName, now = new Date() }) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(now.getDate());
  const month = pad(now.getMonth() + 1);
  const year = now.getFullYear();

  let long;
  try {
    long = new Intl.DateTimeFormat('ar-IQ', { dateStyle: 'long' }).format(now);
  } catch {
    long = `${day}/${month}/${year}`;
  }

  return {
    date: `${day}/${month}/${year}`,
    date_iso: `${year}-${month}-${day}`,
    date_ar: long,
    author: String(displayName ?? ''),
  };
}

/**
 * Fills the template.
 *
 * `nullGetter` returns empty rather than the tag's own text, because a letter
 * that prints {{subject}} on the page in front of a minister is worse than one
 * with a blank line where an optional field was left out.
 */
export async function mergeDocx(buffer, values) {
  const [{ default: PizZip }, { default: Docxtemplater }] = await Promise.all([
    import('pizzip'),
    import('docxtemplater'),
  ]);

  try {
    const doc = new Docxtemplater(new PizZip(buffer), {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
      errorLogging: false,
    });
    doc.render(values ?? {});
    const merged = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { ok: true, buffer: Buffer.isBuffer(merged) ? merged : Buffer.from(merged) };
  } catch (error) {
    return refuse(explainTemplateError(error));
  }
}
