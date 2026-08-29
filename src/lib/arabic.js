/**
 * Arabic text normalization.
 *
 * This is the single highest-value function in the search stack. Arabic
 * administrative text is written inconsistently by different typists, scanners and
 * PDF producers — the *same word* routinely appears in several spellings. Without
 * normalization, a user searching مكتبه never finds a document containing مكتبة.
 *
 * The rule that makes it work: normalizeArabic() MUST be applied in exactly two
 * places, and both, or search silently under-returns —
 *
 *   1. at index time, before storing extracted text in documents.content_text_norm
 *   2. at query time, before passing the user's terms to CONTAINS() / FREETEXT()
 *
 * Never normalize the *display* text. Titles and content shown to users keep their
 * original spelling; only the search columns hold the normalized form.
 */

/** Tashkeel (harakat) — short-vowel and gemination marks. U+064B–U+065F plus the superscript alef. */
const TASHKEEL = /[ً-ٰٟ]/g;

/** Tatweel / kashida — a purely cosmetic elongation of the joining stroke. */
const TATWEEL = /ـ/g;

/** Alef variants: hamza above/below, madda, and the Quranic wasla. */
const ALEF_VARIANTS = /[أإآٱ]/g;

/** Alef maqsura (ى) — very commonly typed where a final yaa (ي) is meant, and vice versa. */
const ALEF_MAQSURA = /ى/g;

/** Taa marbuta (ة) — routinely typed as a plain haa (ه) at the end of a word. */
const TAA_MARBUTA = /ة/g;

/**
 * Zero-width and bidirectional control characters. These are invisible, carry no
 * meaning for search, and are scattered through text extracted from PDFs.
 * ZWNJ, ZWJ, LRM, RLM, LRE/RLE/PDF/LRO/RLO, and the Arabic letter/number marks.
 */
const INVISIBLES = /[​-‏‪-‮؜⁦-⁩﻿]/g;

/** Arabic-Indic digits ٠-٩ (U+0660–0669). */
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;

/** Extended (Persian/Urdu) Arabic-Indic digits ۰-۹ (U+06F0–06F9). */
const EXTENDED_ARABIC_INDIC_DIGITS = /[۰-۹]/g;

const WHITESPACE = /\s+/g;

/**
 * Normalizes Arabic text for indexing and querying.
 *
 * Order matters. Unicode normalization runs first so that presentation forms and
 * decomposed sequences are folded to standard letters before the letter rules see
 * them — otherwise a PDF-extracted ﻻ (U+FEFB) would survive as a distinct character.
 *
 * @param {string} text
 * @returns {string} normalized text, or '' for nullish/blank input
 */
export function normalizeArabic(text) {
  if (text === null || text === undefined) return '';
  const input = String(text);
  if (input === '') return '';

  return (
    input
      // NFKC folds Arabic presentation forms (ﺍ ﻻ ﻢ …) back to standard letters.
      // Badly-extracted PDFs are full of them, and they never match typed input.
      .normalize('NFKC')
      .replace(INVISIBLES, '')
      .replace(TASHKEEL, '')
      .replace(TATWEEL, '')
      // أ إ آ ٱ → ا   ("إدارة" vs "ادارة" — both are typed, constantly)
      .replace(ALEF_VARIANTS, 'ا')
      // ى → ي   ("المستشفى" vs "المستشفي")
      .replace(ALEF_MAQSURA, 'ي')
      // ة → ه   ("مكتبة" vs "مكتبه", "فاطمة" vs "فاطمه")
      .replace(TAA_MARBUTA, 'ه')
      // ٢٠٢٦ → 2026. Reference numbers and dates are typed both ways; without this a
      // user searching a Latin-digit reference misses every document that used Arabic digits.
      .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(EXTENDED_ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
      .toLowerCase()
      .replace(WHITESPACE, ' ')
      .trim()
  );
}

/** True when the string contains at least one character in an Arabic Unicode block. */
export function containsArabic(text) {
  if (!text) return false;
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(String(text));
}

/**
 * Prepares a user's raw search input for SQL Server CONTAINS().
 *
 * Normalizes each term, then wraps it in double quotes so the full-text engine
 * treats it as a phrase and never as an operator. Embedded quotes are doubled,
 * which is the escape CONTAINS() expects — this is what stops a search box from
 * becoming a full-text injection point.
 *
 * @param {string} rawQuery user input
 * @param {{ prefix?: boolean, operator?: 'AND' | 'OR' }} [options]
 *        prefix   — match terms as prefixes ("عقد*"), for search-as-you-type
 *        operator — how to combine multiple terms (default AND)
 * @returns {string|null} a CONTAINS() expression, or null when there is nothing to search
 */
export function buildContainsExpression(rawQuery, options = {}) {
  const { prefix = false, operator = 'AND' } = options;

  const terms = normalizeArabic(rawQuery)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // Strip characters that carry meaning to the full-text parser. Anything left is
    // quoted, but removing these first avoids empty or degenerate terms.
    .map((t) => t.replace(/["'()*~&|]/g, ''))
    .filter((t) => t.length > 0);

  if (terms.length === 0) return null;

  const quoted = terms.map((t) => {
    const escaped = t.replace(/"/g, '""');
    return prefix ? `"${escaped}*"` : `"${escaped}"`;
  });

  return quoted.join(` ${operator} `);
}
