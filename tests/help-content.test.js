/**
 * The help registry covers every screen and every setting.
 *
 * ─── Why this is a test and not a review habit ──────────────────────────────
 *
 * Help rots silently. Nothing breaks when a tab is added and its topic is not,
 * or when a new setting appears in `EDITABLE` with no explanation beside it —
 * the button still opens, the row still renders, and the gap is only found by a
 * user who needed the answer. These assertions are what turn "someone will
 * notice" into a failing run.
 *
 * The tab list is read out of the page's own source rather than restated here,
 * because a copy of it in this file would be one more thing to forget.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A relative specifier, not a joined absolute path: on Windows the latter
// reaches the ESM loader as the scheme "c:" and is rejected outright.
const { HELP_TOPICS, SETTING_HELP, MISSING_TOPICS, topicForPath } = await import(
  '../client/src/help/content.js'
);

/**
 * The tab keys a module actually offers, read from the navigation registry.
 *
 * Scraped rather than imported: the registry pulls in lucide-react and so React,
 * which a plain node test has no business loading to answer a question about a
 * list of strings.
 *
 * It reads the registry rather than the page because that is now where the tabs
 * are declared — and because the registry is also what the tile menu renders, so
 * this checks the launcher and the page together. A tab present in one and
 * missing from the other is no longer a thing that can happen.
 */
async function tabKeys(literalName) {
  const source = await readFile(path.join(ROOT, 'client/src/navigation.js'), 'utf8');
  const block = source.match(new RegExp('export const ' + literalName + ' = \\[([\\s\\S]*?)\\n\\];'));
  assert.ok(block, `could not find ${literalName} in client/src/navigation.js`);

  const keys = [...block[1].matchAll(/key: '([^']+)'/g)].map((match) => match[1]);
  assert.ok(keys.length > 0, `found no tab keys in ${literalName}`);
  return keys;
}

describe('help content', () => {
  test('every route resolves to a topic that exists', () => {
    assert.deepEqual(MISSING_TOPICS, [], 'a route points at a help topic that was never written');
  });

  test('an unknown path still opens onto something', () => {
    // The button must never open an empty panel, so the fallback has to resolve.
    assert.ok(HELP_TOPICS[topicForPath('/some/route/added/later')]);
  });

  test('every administration tab has its own topic', async () => {
    const missing = (await tabKeys('ADMIN_TABS')).filter(
      (key) => !HELP_TOPICS[`admin.${key}`],
    );

    assert.deepEqual(missing, [], `administration tabs with no help: ${missing.join(', ')}`);
  });

  test('every editable setting has help, and none describes a setting that is gone', async () => {
    const { EDITABLE } = await import('../src/modules/settings/service.js');

    const settings = Object.keys(EDITABLE).sort();
    const documented = Object.keys(SETTING_HELP).sort();

    assert.deepEqual(
      documented,
      settings,
      'the settings panel and its help have drifted apart — a control with no "?" or a "?" with no control',
    );
  });

  test('no topic is a stub', () => {
    for (const [id, topic] of Object.entries(HELP_TOPICS)) {
      assert.ok(topic.title?.trim(), `${id} has no title`);
      assert.ok(topic.summary?.trim(), `${id} has no summary`);

      for (const section of topic.sections ?? []) {
        assert.ok(section.heading?.trim(), `${id} has a section with no heading`);
        assert.ok(section.items?.length, `${id} / ${section.heading} lists nothing`);
        for (const item of section.items) assert.ok(item.trim(), `${id} has an empty item`);
      }

      for (const note of topic.notes ?? []) assert.ok(note.trim(), `${id} has an empty note`);
    }
  });

  test('no setting help is a stub', () => {
    for (const [key, text] of Object.entries(SETTING_HELP)) {
      assert.ok(text.trim().length > 20, `${key} has help too short to say anything`);
    }
  });
});
