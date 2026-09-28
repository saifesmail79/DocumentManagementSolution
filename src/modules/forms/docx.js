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
 *
 * ─── Arabic templates: the braces Word stores are not the braces Word shows ──
 *
 * MEASURED on a real institute letter (its two fields are «العدد» and
 * «التاريخ»): the person typed {{العدد}} in a right-to-left paragraph and sees
 * {{العدد}} on the screen, but the characters Word actually stored, in logical
 * order, are }}العدد{{ — the braces are mirrored. That is not a mistake and not
 * a corrupt file: in a right-to-left run the bidirectional algorithm displays
 * an opening brace as a closing one and vice versa, so the pair the writer sees
 * around the name is stored the other way round. On top of that Word had split
 * the paragraph into twenty runs, one per typing correction. docxtemplater,
 * which reads the stored order and knows nothing about direction, reported
 * «unclosed tag» and the upload was refused. EVERY Arabic template hits this.
 *
 * So the XML is normalised before the engine ever sees it: within one
 * paragraph, a }} that comes first and is followed by text and then a {{ is a
 * mirrored pair, and the four characters are flipped. Whitespace that sits just
 * inside a tag is moved just outside it in the same way, so {{ name }} — an
 * accidental space, which the tag name rules would otherwise refuse — becomes
 * ␣{{name}}␣ and is accepted as «name».
 *
 * Two decisions hold this together. The transform only PERMUTES characters, so
 * every run keeps its exact length and the text can be written back into the
 * same runs by position — a rewrite that re-flowed the runs would lose the
 * formatting, the revision marks and the language attributes Word keeps there.
 * And the stored blob keeps the original bytes: normalisation runs on the
 * in-memory zip on every inspect and every merge, so the administrator can
 * still download the file they uploaded and open it in Word unchanged.
 */

/**
 * The library's English explanation, on the server log and nowhere else.
 *
 * The logger is reached through a dynamic import because this file is otherwise
 * a set of pure functions over bytes — importing the logger statically would
 * pull the whole configuration in behind it, and a helper that cannot be called
 * without a database connection string is no longer pure. The call is
 * deliberately not awaited: nothing about a refusal waits on a log line.
 */
function logEnglish(detail) {
  import('../../lib/logger.js')
    .then(({ moduleLogger }) =>
      moduleLogger('forms').debug(detail, 'docxtemplater refused a template'),
    )
    .catch(() => {});
}

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
    // The braces are straightened on a throwaway copy of the zip before the
    // lexer sees them; the stored bytes stay exactly as they were uploaded.
    const zip = new PizZip(buffer);
    normaliseTemplateZip(zip);

    const doc = new Docxtemplater(zip, {
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

/**
 * What to do about each way docxtemplater can refuse a file, in Arabic.
 *
 * The library's own explanations are English sentences about lexers and tags
 * («The tag beginning with "{{oops" is unclosed»). The person reading them is
 * an administrator who wrote a letterhead in Word, so what reaches them is an
 * Arabic sentence that names the text at fault and says what to change. The
 * English is kept — at debug level, on the server — because it is what a
 * support question is answered from.
 */
const RTL_BRACE_NOTE =
  ' وداخل النص العربي تظهر الأقواس معكوسة على الشاشة (}}الاسم{{) وهذا مقبول، فاكتبها كما تراها.';

const ONE_FIELD_PER_LINE = 'اكتب كل حقل بالشكل {{الاسم}} كاملًا في سطر واحد.';

const TEMPLATE_ERROR_MESSAGES = Object.freeze({
  unclosed_tag: (what) =>
    `الحقل الذي يبدأ بـ «{{${what}» لم يُغلق بـ }} في السطر نفسه. ${ONE_FIELD_PER_LINE}${RTL_BRACE_NOTE}`,
  unopened_tag: (what) =>
    `الحقل الذي ينتهي بـ «${what}}}» لم يُفتح بـ {{ في السطر نفسه. ${ONE_FIELD_PER_LINE}${RTL_BRACE_NOTE}`,
  duplicate_open_tag: (what) =>
    `الحقل «${what}» يحمل أقواس فتح زائدة. ${ONE_FIELD_PER_LINE}`,
  duplicate_close_tag: (what) =>
    `الحقل «${what}» يحمل أقواس إغلاق زائدة. ${ONE_FIELD_PER_LINE}`,
  closing_tag_does_not_match_opening_tag: (what) =>
    `الحقل «${what}» أُغلق بوسم يحمل اسمًا آخر. ${ONE_FIELD_PER_LINE}`,
  unbalanced_loop_tags: () =>
    `الملف يستخدم وسوم تكرار غير متوازنة، وهي صيغة غير مدعومة هنا. ${ONE_FIELD_PER_LINE}`,
  malformed_xml: () =>
    'تعذّر قراءة محتوى الملف: يبدو أن المستند تالف. افتحه في Word واحفظه من جديد بصيغة .docx ثم أعد المحاولة.',
  file_has_invalid_xml: () =>
    'محتوى المستند غير سليم: يبدو أن الملف تالف. افتحه في Word واحفظه من جديد بصيغة .docx ثم أعد المحاولة.',
  invalid_xml_characters: (what) =>
    `الحقل «${what}» يحتوي محارف لا يقبلها مستند Word.`,
});

/** The offending text an entry names, short enough to read in one line. */
function offendingText(entry) {
  const raw =
    entry?.properties?.xtag ??
    entry?.properties?.openingtag ??
    entry?.properties?.explanation ??
    entry?.message ??
    '';
  // The braces are stripped off the ends because the sentence puts them back
  // itself: the library hands over «{oops» for an unclosed {{oops.
  const text = String(raw).replace(/\s+/g, ' ').replace(/^[{}]+|[{}]+$/g, '').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** One Arabic sentence for one of the library's errors. */
function explainOne(entry) {
  const id = entry?.properties?.id;
  const message = TEMPLATE_ERROR_MESSAGES[id];
  if (message) return message(offendingText(entry));
  return `تعذّر قراءة حقول الملف. ${ONE_FIELD_PER_LINE}${RTL_BRACE_NOTE}`;
}

/**
 * Every refusal the engine reports, as Arabic sentences. Two at most: a broken
 * template usually breaks the same way in several places, and a wall of text is
 * read as a crash rather than as something to fix.
 */
function explainTemplateError(error) {
  const errors = error?.properties?.errors;
  const entries = Array.isArray(errors) && errors.length > 0 ? errors : [error];

  logEnglish({
    ids: entries.map((entry) => entry?.properties?.id ?? null),
    explanations: entries
      .map((entry) => entry?.properties?.explanation ?? entry?.message ?? String(entry))
      .slice(0, 10),
  });

  const said = [];
  for (const entry of entries) {
    const sentence = explainOne(entry);
    if (!said.includes(sentence)) said.push(sentence);
    if (said.length === 2) break;
  }
  return said.join(' ');
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
    // The same normalisation as on inspection, for the same reason, and on the
    // same terms: a throwaway zip built from the untouched stored bytes.
    const zip = new PizZip(buffer);
    normaliseTemplateZip(zip);

    const doc = new Docxtemplater(zip, {
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

// ── Normalising the braces before the engine reads them ──────────────────
//
// See the note at the top of this file: in a right-to-left paragraph Word
// stores the braces of {{name}} mirrored, and it splits one field across many
// runs. Both are repaired here, on the in-memory zip only.

/**
 * The parts docxtemplater substitutes into: the body, every header and footer,
 * and the notes. A field in any other part would not be filled, so normalising
 * it would only hide the fact.
 */
const TEMPLATED_PART = /^word\/(document\d*|header\d+|footer\d+|footnotes|endnotes)\.xml$/i;

/** The text of a <w:t> run, with the offsets of its inner text. */
const RUN_TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/**
 * The inner ranges of the paragraphs in one part, innermost only.
 *
 * A paragraph can contain another paragraph — a text box inside a drawing is
 * the everyday case — and the two are different paragraphs on the page, so the
 * text of the inner one must not be concatenated with the text of the outer.
 * Counting children while the outer paragraph is open is what keeps them apart.
 */
function paragraphRanges(xml) {
  const boundary = /<w:p(?=[\s/>])[^>]*>|<\/w:p>/g;
  const open = [];
  const ranges = [];
  let match;
  while ((match = boundary.exec(xml)) !== null) {
    if (match[0] === '</w:p>') {
      const started = open.pop();
      if (!started) continue;
      if (started.children === 0) ranges.push([started.start, match.index]);
      if (open.length > 0) open[open.length - 1].children += 1;
    } else if (!match[0].endsWith('/>')) {
      open.push({ start: match.index + match[0].length, children: 0 });
    }
  }
  return ranges;
}

/** Every `{{` and `}}` in the text, in order, as { at, open }. */
function braceTokens(text) {
  const tokens = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    const pair = text[i] + text[i + 1];
    if (pair === '{{') {
      tokens.push({ at: i, open: true });
      i += 1;
    } else if (pair === '}}') {
      tokens.push({ at: i, open: false });
      i += 1;
    }
  }
  return tokens;
}

const flip = (text, at, char) => text.slice(0, at) + char + char + text.slice(at + 2);

/**
 * Flips the mirrored pairs of one paragraph's text. Same length out as in.
 *
 * The scan is left to right and a proper pair is consumed as a pair, so a
 * paragraph that carries both {{a}} and }}b{{ is read correctly. A `}}` that
 * comes first is only treated as mirrored when a `{{` follows it with real text
 * and no other brace in between; anything else is left exactly as it is, so a
 * genuinely broken template still produces the engine's own error rather than a
 * silently different one.
 *
 * The trade, stated: a paragraph that prints a literal }} of its own before a
 * real field is misread, and the upload is refused with a message naming the
 * wrong fragment. That is a letter about braces; mirrored fields are every
 * Arabic letter there is.
 */
function repairMirroredBraces(text) {
  let out = text;
  const tokens = braceTokens(out);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.open) {
      if (next && !next.open) i += 1; // a proper {{…}} pair
      continue;
    }
    if (!next || !next.open) continue;
    const between = out.slice(token.at + 2, next.at);
    if (between.trim() === '' || /[{}]/.test(between)) continue;
    out = flip(out, token.at, '{');
    out = flip(out, next.at, '}');
    i += 1;
  }
  return out;
}

/**
 * Moves whitespace from just inside a tag to just outside it: {{ name }} becomes
 * ␣{{name}}␣. The space stays on the page — it was typed — but it stops being
 * part of the field's name, which is matched byte for byte.
 */
function moveWhitespaceOutside(text) {
  let out = text;
  // The rotation permutes characters inside one tag's own span, so every other
  // token keeps the offset it had: the list is computed once and stays valid.
  const tokens = braceTokens(out);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (!tokens[i].open || tokens[i + 1].open) continue;
    const start = tokens[i].at;
    const end = tokens[i + 1].at;
    const inner = out.slice(start + 2, end);
    const lead = /^\s*/.exec(inner)[0];
    const trail = lead.length === inner.length ? '' : /\s*$/.exec(inner)[0];
    i += 1;
    if (lead === '' && trail === '') continue;
    const core = inner.slice(lead.length, inner.length - trail.length);
    out = `${out.slice(0, start)}${lead}{{${core}}}${trail}${out.slice(end + 2)}`;
  }
  return out;
}

/** Both repairs, in order. The result always has the length of the input. */
export function normaliseParagraphText(text) {
  return moveWhitespaceOutside(repairMirroredBraces(text));
}

/**
 * Rewrites one XML part, paragraph by paragraph.
 *
 * The concatenated raw text of the paragraph's <w:t> runs is what the engine
 * effectively reads, so that is what is normalised; the result is sliced back
 * into the same runs by position, which is sound only because the transform
 * preserves length. Entity references (&amp;, &#10;) survive untouched: they
 * contain no braces and no whitespace, so nothing moves across them.
 */
function normalisePartXml(xml) {
  const edits = [];

  for (const [start, end] of paragraphRanges(xml)) {
    const paragraph = xml.slice(start, end);
    const runs = [];
    RUN_TEXT.lastIndex = 0;
    let match;
    while ((match = RUN_TEXT.exec(paragraph)) !== null) {
      const openLength = match[0].length - match[1].length - '</w:t>'.length;
      runs.push({ at: start + match.index + openLength, text: match[1] });
    }
    if (runs.length === 0) continue;

    const joined = runs.map((run) => run.text).join('');
    if (!joined.includes('{{') && !joined.includes('}}')) continue;

    const normalised = normaliseParagraphText(joined);
    if (normalised === joined) continue;

    let cursor = 0;
    for (const run of runs) {
      const slice = normalised.slice(cursor, cursor + run.text.length);
      cursor += run.text.length;
      if (slice !== run.text) edits.push({ at: run.at, length: run.text.length, text: slice });
    }
  }

  if (edits.length === 0) return null;

  edits.sort((a, b) => a.at - b.at);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += xml.slice(cursor, edit.at) + edit.text;
    cursor = edit.at + edit.length;
  }
  return out + xml.slice(cursor);
}

/**
 * Normalises every templated part of an opened zip, in place, and reports which
 * parts it changed. The caller's zip is a throwaway built from the stored bytes;
 * the stored bytes themselves are never touched.
 */
export function normaliseTemplateZip(zip) {
  const changed = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !TEMPLATED_PART.test(name)) continue;
    let xml;
    try {
      xml = zip.file(name)?.asText();
    } catch {
      continue;
    }
    if (typeof xml !== 'string') continue;

    const next = normalisePartXml(xml);
    if (next === null) continue;

    zip.remove(name);
    zip.file(name, next, { createFolders: true });
    changed.push(name);
  }
  return changed;
}
