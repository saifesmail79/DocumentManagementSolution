/**
 * The tile menu against the routes it claims to open.
 *
 * ─── Why this is worth a test ───────────────────────────────────────────────
 *
 * A tile is a promise about a destination, and a broken one fails in the worst
 * possible way: the tile renders, the description reads correctly, the click
 * navigates, and the router quietly falls through to the catch-all — so the user
 * lands somewhere plausible and never learns that the thing they asked for is
 * not where it said it was. Nothing throws and no build fails.
 *
 * The same holds for the sub-item tiles. Each carries a `?tab=` that the target
 * page validates against its own list; a key that is not in that list is not an
 * error but a silent fall back to the first tab, which looks exactly like the
 * tile going to the wrong place on purpose.
 *
 * So: every destination must be routed, and every tab a tile offers must be a
 * tab the page can actually show.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A relative specifier, not a joined absolute path: on Windows the latter
// reaches the ESM loader as the scheme "c:" and is rejected outright.
const { MODULES, ADMIN_TABS, MY_TABS, visibleModules, moduleForPath, applyOrder, reorder } =
  await import('../client/src/navigation.js');

const appSource = await readFile(path.join(ROOT, 'client/src/App.jsx'), 'utf8');

/** The paths App.jsx actually routes, from its `<Route path="…">` list. */
const routed = [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);

describe('the tile menu', () => {
  test('every module opens a path the router serves', () => {
    const unrouted = MODULES.filter(
      (module) => !routed.some((route) => route === module.to || route.startsWith(`${module.to}/`)),
    ).map((module) => `${module.label} → ${module.to}`);

    assert.deepEqual(unrouted, [], `tiles pointing at paths nothing routes: ${unrouted.join(', ')}`);
  });

  test('the tile menu itself is what the root path serves', () => {
    // The root used to redirect into المجلدات. If it still did, the menu would
    // exist and be unreachable by the one address everybody starts from.
    assert.ok(routed.includes('/'), 'the root path is not routed at all');
    assert.match(
      appSource,
      /<Route path="\/" element=\{<Home \/>\} \/>/,
      'the root path no longer renders the tile menu',
    );
  });

  test('an unknown path falls back to the menu, not into a module', () => {
    assert.match(
      appSource,
      /<Route path="\*" element=\{<Navigate to="\/" replace \/>\} \/>/,
      'a mistyped address should land on the menu, where every module is visible',
    );
  });

  test('every tile says what its module is for', () => {
    // The description is the whole reason a tile is bigger than a menu row.
    const bare = MODULES.filter((module) => !module.description?.trim()).map((m) => m.label);
    assert.deepEqual(bare, [], `tiles with no description: ${bare.join(', ')}`);
  });

  test('a module that expands has something to expand into', () => {
    const empty = MODULES.filter((module) => module.tabs && module.tabs.length === 0);
    assert.deepEqual(empty, [], 'a module declaring tabs but holding none would expand onto nothing');
  });

  test('الإدارة is offered only to administrators', () => {
    const ordinary = visibleModules({ isSuperAdmin: false }).map((module) => module.key);
    const admin = visibleModules({ isSuperAdmin: true }).map((module) => module.key);

    assert.ok(!ordinary.includes('admin'), 'the administration tile must not be offered to everyone');
    assert.ok(admin.includes('admin'));
    // Signed out, or before the session resolves, is not an administrator.
    assert.ok(!visibleModules(null).some((module) => module.key === 'admin'));
  });

  test('the breadcrumb names the module a path belongs to', () => {
    assert.equal(moduleForPath('/folders/12', { isSuperAdmin: false })?.label, 'المجلدات');
    assert.equal(moduleForPath('/admin', { isSuperAdmin: true })?.label, 'الإدارة');
    // Not an administrator, so there is no administration module to name.
    assert.equal(moduleForPath('/admin', { isSuperAdmin: false }), null);
    assert.equal(moduleForPath('/', { isSuperAdmin: true }), null);
  });
});

describe('the tabs a tile links into', () => {
  /**
   * Each page validates the incoming `?tab=` against its own list and falls back
   * to the first entry when it does not match. That fallback is silent by
   * design — a stale bookmark should still open something — which is exactly why
   * the tiles have to be checked here instead.
   */
  const pageTabs = async (relativePath, listName) => {
    const source = await readFile(path.join(ROOT, relativePath), 'utf8');
    assert.match(
      source,
      new RegExp(`${listName} as TABS`),
      `${relativePath} no longer takes its tabs from the registry`,
    );
    return source;
  };

  test('الإدارة renders the tabs the registry declares', async () => {
    const source = await pageTabs('client/src/pages/Admin.jsx', 'ADMIN_TABS');

    // Every key must be handled by the panel switch, or the tile opens a blank.
    const unhandled = ADMIN_TABS.filter((tab) => !source.includes(`'${tab.key}'`)).map((t) => t.key);
    assert.deepEqual(unhandled, [], `administration tabs nothing renders: ${unhandled.join(', ')}`);
  });

  test('مساحتي renders the tabs the registry declares', async () => {
    const source = await pageTabs('client/src/pages/MyDocuments.jsx', 'MY_TABS');

    const unhandled = MY_TABS.filter((tab) => !source.includes(`'${tab.key}'`)).map((t) => t.key);
    assert.deepEqual(unhandled, [], `personal tabs nothing renders: ${unhandled.join(', ')}`);
  });

  test('both pages read the tab from the URL, so a tile can land on one', async () => {
    for (const page of ['client/src/pages/Admin.jsx', 'client/src/pages/MyDocuments.jsx']) {
      const source = await readFile(path.join(ROOT, page), 'utf8');
      assert.match(source, /useSearchParams/, `${page} cannot be opened at a specific tab`);
    }
  });
});

describe('a saved tile arrangement', () => {
  const three = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

  test('an arrangement is honoured', () => {
    assert.deepEqual(applyOrder(three, ['c', 'a', 'b']).map((m) => m.key), ['c', 'a', 'b']);
  });

  /**
   * The case that decides whether adding a module is safe.
   *
   * Everyone who has ever dragged a tile has a saved order that predates the new
   * module. If an unlisted module were dropped, a new feature would be invisible
   * to exactly the people who use the system enough to have arranged it — and
   * invisible silently, which is how it would stay.
   */
  test('a module the arrangement predates still appears, at the end', () => {
    const withNew = [...three, { key: 'brand-new' }];
    assert.deepEqual(
      applyOrder(withNew, ['c', 'a', 'b']).map((m) => m.key),
      ['c', 'a', 'b', 'brand-new'],
    );
  });

  test('several unlisted modules keep their registry order', () => {
    const more = [{ key: 'a' }, { key: 'x' }, { key: 'b' }, { key: 'y' }];
    assert.deepEqual(applyOrder(more, ['b']).map((m) => m.key), ['b', 'a', 'x', 'y']);
  });

  /**
   * A stale name must not resurrect a tile. Someone who was an administrator,
   * arranged their menu, and then had that taken away still has 'admin' in their
   * saved order — and it must stay gone.
   */
  test('a name with no module is skipped, not restored', () => {
    assert.deepEqual(applyOrder(three, ['admin', 'c', 'gone', 'a']).map((m) => m.key), ['c', 'a', 'b']);
    assert.equal(applyOrder(three, ['admin']).some((m) => m.key === 'admin'), false);
  });

  test('no arrangement, or a broken one, leaves the registry order alone', () => {
    for (const order of [[], null, undefined, 'nonsense', 42, {}]) {
      assert.deepEqual(applyOrder(three, order).map((m) => m.key), ['a', 'b', 'c']);
    }
  });

  test('the arrangement never adds or loses a module', () => {
    const arranged = applyOrder(three, ['c']);
    assert.equal(arranged.length, three.length);
    assert.deepEqual([...arranged].map((m) => m.key).sort(), ['a', 'b', 'c']);
  });

  test('moving a tile produces the keys to save', () => {
    assert.deepEqual(reorder(three, 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(reorder(three, 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(reorder(three, 1, 0), ['b', 'a', 'c']);
  });

  test('a move that goes nowhere changes nothing', () => {
    // The ends, where a keyboard move runs out of room, and where an
    // off-by-one would silently drop or duplicate a tile.
    for (const [from, to] of [[1, 1], [0, -1], [2, 3], [-1, 0], [9, 0]]) {
      assert.deepEqual(reorder(three, from, to), ['a', 'b', 'c'], `${from} -> ${to}`);
    }
  });

  test('what a move produces is what an arrangement consumes', () => {
    // The two functions are one idea, and this is the join between them.
    const moved = reorder(three, 0, 2);
    assert.deepEqual(applyOrder(three, moved).map((m) => m.key), moved);
  });

  test('every real module key survives a round trip', () => {
    const modules = visibleModules({ isSuperAdmin: true });
    const shuffled = [...modules].reverse().map((m) => m.key);
    assert.deepEqual(applyOrder(modules, shuffled).map((m) => m.key), shuffled);
  });
});

/**
 * The boot path, against what the deployment story claims about it.
 *
 * A schema change that ships without its table produces a feature that is
 * present, correct, tested, and silently broken: the routes exist, the client
 * calls them, and every call fails on a table nobody created. It reads as "the
 * new thing does not work" rather than as a system that will not start, which is
 * the most expensive way for this to go wrong and the hardest to diagnose from
 * the outside.
 *
 * Asserted by reading the source because the alternative is booting a real
 * server against a real database inside a unit test — but a scrape is enough to
 * catch the regression that matters: someone removing the call.
 */
describe('starting the application', () => {
  test('brings the schema up to date before serving anything', async () => {
    const server = await readFile(path.join(ROOT, 'src/server.js'), 'utf8');

    assert.match(
      server,
      /runMigrations\(\)/,
      'src/server.js must apply migrations at boot — otherwise new code runs against an old schema',
    );

    // Before the port opens, not after: a request served against a half-applied
    // schema is the thing being prevented.
    const migratesAt = server.indexOf('runMigrations()');
    const listensAt = server.search(/\.listen\(/);
    assert.ok(migratesAt !== -1, 'no migration call found');
    assert.ok(
      listensAt === -1 || migratesAt < listensAt,
      'migrations must run before the server starts listening',
    );
  });

  test('every migration file is registered in the manifest', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(path.join(ROOT, 'src/db/migrations')))
      .filter((name) => /^\d{4}-/.test(name));

    const manifest = await readFile(path.join(ROOT, 'src/db/migrations/index.js'), 'utf8');

    // A migration file that nothing imports is not a schema change; it is a
    // file. Nothing fails, and the table simply never appears.
    const orphans = files.filter((name) => !manifest.includes(name));
    assert.deepEqual(orphans, [], `migration files missing from the manifest: ${orphans.join(', ')}`);
  });
});
