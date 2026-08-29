import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArabic, containsArabic, buildContainsExpression } from '../src/lib/arabic.js';

test('unifies alef variants', () => {
  assert.equal(normalizeArabic('إدارة'), normalizeArabic('ادارة'));
  assert.equal(normalizeArabic('أحمد'), normalizeArabic('احمد'));
  assert.equal(normalizeArabic('آمال'), normalizeArabic('امال'));
});

test('taa marbuta matches final haa', () => {
  assert.equal(normalizeArabic('مكتبة'), normalizeArabic('مكتبه'));
  assert.equal(normalizeArabic('فاطمة'), normalizeArabic('فاطمه'));
});

test('alef maqsura matches final yaa', () => {
  assert.equal(normalizeArabic('المستشفى'), normalizeArabic('المستشفي'));
});

test('strips tashkeel diacritics', () => {
  assert.equal(normalizeArabic('كِتَابٌ'), normalizeArabic('كتاب'));
  assert.equal(normalizeArabic('مُحَمَّد'), normalizeArabic('محمد'));
});

test('strips tatweel', () => {
  assert.equal(normalizeArabic('عــــقد'), normalizeArabic('عقد'));
});

test('converts Arabic-Indic digits to ASCII', () => {
  assert.equal(normalizeArabic('٢٠٢٦'), '2026');
  assert.equal(normalizeArabic('۲۰۲۶'), '2026');
  assert.equal(normalizeArabic('عقد ٢٠٢٦'), normalizeArabic('عقد 2026'));
});

test('folds presentation forms from PDF extraction', () => {
  // U+FEFB ARABIC LIGATURE LAM WITH ALEF ISOLATED FORM
  assert.equal(normalizeArabic('\uFEFB'), normalizeArabic('لا'));
  // U+FE8D ARABIC LETTER ALEF ISOLATED FORM
  assert.equal(normalizeArabic('\uFE8D'), normalizeArabic('ا'));
});

test('removes invisible bidi and zero-width characters', () => {
  assert.equal(normalizeArabic('عقد\u200Fإيجار'), normalizeArabic('عقدإيجار'));
  assert.equal(normalizeArabic('م\u200Cكتب'), normalizeArabic('مكتب'));
});

test('collapses whitespace and trims', () => {
  assert.equal(normalizeArabic('  عقد   إيجار  '), 'عقد ايجار');
});

test('handles mixed Arabic and Latin', () => {
  assert.equal(normalizeArabic('عقد Contract 2026'), 'عقد contract 2026');
});

test('handles nullish and empty input', () => {
  assert.equal(normalizeArabic(null), '');
  assert.equal(normalizeArabic(undefined), '');
  assert.equal(normalizeArabic(''), '');
});

test('containsArabic detects Arabic script', () => {
  assert.equal(containsArabic('عقد'), true);
  assert.equal(containsArabic('Contract'), false);
  assert.equal(containsArabic('Contract عقد'), true);
  assert.equal(containsArabic(''), false);
});

test('buildContainsExpression quotes and joins terms', () => {
  assert.equal(buildContainsExpression('عقد إيجار'), '"عقد" AND "ايجار"');
  assert.equal(buildContainsExpression('عقد', { prefix: true }), '"عقد*"');
  assert.equal(buildContainsExpression('a b', { operator: 'OR' }), '"a" OR "b"');
});

test('buildContainsExpression neutralises full-text operators', () => {
  const expr = buildContainsExpression('عقد" OR "1"="1');
  assert.ok(!/(^|\s)OR(\s|$)/.test(expr.replace(/"[^"]*"/g, '')), `unexpected operator leaked: ${expr}`);
  assert.equal(buildContainsExpression('*'), null);
  assert.equal(buildContainsExpression('   '), null);
  assert.equal(buildContainsExpression(''), null);
});
