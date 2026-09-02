/**
 * Every component referenced in JSX is actually in scope.
 *
 * ─── Why the build does not already prove this ──────────────────────────────
 *
 * Vite bundles a reference to an undefined identifier without a word of
 * complaint; it becomes a `ReferenceError` the first time the component renders.
 * So `npm run build` exits 0 on a page that crashes on sight, and the failure
 * surfaces as a blank screen in front of whoever opened that tab.
 *
 * This caught exactly that: a `Tags` icon used in the administration tab list
 * and never imported, on a build that reported success.
 *
 * There is no client test runner in this project, so this reads the sources
 * rather than rendering them. It is deliberately narrow — capitalised names used
 * as elements or passed as `icon` — because that is where the mistake happens
 * and a broader check would need a real parser to stay honest.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src');

/** Names the runtime supplies, which no file needs to import. */
const GLOBALS = new Set([
  'React', 'Math', 'Object', 'Array', 'JSON', 'Number', 'String', 'Boolean', 'Date',
  'Promise', 'Set', 'Map', 'URL', 'URLSearchParams', 'Error', 'Intl', 'AbortController',
  'RegExp', 'Infinity', 'NaN', 'Fragment',
]);

function jsxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsxFiles(full);
    return entry.name.endsWith('.jsx') ? [full] : [];
  });
}

/** Names a file binds: imported, declared, or renamed in a parameter destructuring. */
function boundNames(source) {
  const bound = new Set();

  for (const match of source.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (match[1]) bound.add(match[1]);
    for (const part of (match[2] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) bound.add(name);
    }
  }

  for (const match of source.matchAll(/(?:function|const|let|class)\s+([A-Z]\w*)/g)) {
    bound.add(match[1]);
  }

  /*
   * `function Row({ icon: Icon })` binds `Icon` locally.
   *
   * Matched only inside `({ … })`, so an object literal such as
   * `{ key: 'metadata', icon: Tags }` still counts as a use rather than a
   * declaration — which is the distinction the whole check rests on.
   */
  for (const block of source.matchAll(/\(\s*\{([^)]*)\}\s*\)/g)) {
    for (const match of block[1].matchAll(/\w+:\s*([A-Z]\w*)/g)) bound.add(match[1]);
  }

  return bound;
}

/**
 * Comments stripped.
 *
 * Prose about the code is not the code: a doc block that mentions `<Modal>` or
 * names the component it replaced would otherwise be read as a use, and the
 * check would fail on a file that is perfectly correct. It failed exactly that
 * way on a JSDoc line naming `<ConfirmDialog>`.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Not preceded by a colon, so the `//` in an https:// literal survives and
    // does not swallow the rest of that line.
    .replace(/(^|[^:])\/\/.*/gm, '$1');
}

/** Capitalised names used as an element or handed over as an `icon`. */
function usedNames(source) {
  const code = withoutComments(source);
  const used = new Set([...code.matchAll(/<([A-Z]\w*)[\s/>]/g)].map((match) => match[1]));
  for (const match of code.matchAll(/(?:icon=\{|icon:\s*)([A-Z]\w*)/g)) used.add(match[1]);
  return used;
}

describe('client imports', () => {
  test('every component used in JSX is in scope', () => {
    const problems = [];

    for (const file of jsxFiles(CLIENT)) {
      const source = readFileSync(file, 'utf8');
      const bound = boundNames(source);

      for (const name of usedNames(source)) {
        if (!bound.has(name) && !GLOBALS.has(name)) {
          problems.push(`${path.relative(CLIENT, file)}: ${name}`);
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      `used in JSX but never imported or declared — these crash on render:\n  ${problems.join('\n  ')}`,
    );
  });

  test('the check itself still detects a missing import', () => {
    // A guard that cannot fail is not a guard. If the regexes above are ever
    // loosened into uselessness, this is what says so.
    const broken = "import { Plus } from 'lucide-react';\nconst T = [{ icon: Tags }];\n";
    assert.ok(!boundNames(broken).has('Tags'));
    assert.ok(usedNames(broken).has('Tags'));
  });
});
