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
 *
 * ─── And the names, since the areas landed ──────────────────────────────────
 *
 * The complaint that produced the two areas was «i don't know what to use for
 * what action», and its cause was names rather than routes: «المراسلات» was a
 * tile, an administration tab and a folder at once, and «المتابعة» and «المتابَعة»
 * differed by a single diacritic while meaning unrelated things. A name is a
 * destination too — the reader picks a screen by reading it — so two labels that
 * read the same are the same failure as a tile pointing at an unrouted path, and
 * are checked here for the same reason: nothing throws.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A relative specifier, not a joined absolute path: on Windows the latter
// reaches the ESM loader as the scheme "c:" and is rejected outright.
const {
  AREAS, MODULES, ADMIN_TABS, MY_TABS, CORRESPONDENCE_TABS, MOST_PERMISSIVE_STATUS,
  visibleModules, moduleForPath, applyOrder, reorder, visibleTabs, signInLanding,
  mailActions, homeAreas, breadcrumbFor,
} = await import('../client/src/navigation.js');

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

  /**
   * The breadcrumb says where the reader is, not what they may be offered.
   *
   * النماذج is the first module gated on a capability, and the breadcrumb asked
   * `visibleModules` — which cannot see a capability the shell never fetches — so
   * it matched nothing and the « > النماذج» segment simply vanished from a screen
   * the router had already opened. Any future gated module would lose it too,
   * which is why this pins the rule rather than the one module.
   */
  test('a capability-gated module still names itself in the breadcrumb', () => {
    const gated = MODULES.filter((module) => module.requires);
    assert.ok(gated.length > 0, 'no capability-gated module left to check this rule with');

    for (const module of gated) {
      // An ordinary user, with no capabilities passed at all: the page is open,
      // so the question is only what to call it.
      assert.equal(
        moduleForPath(module.to, { isSuperAdmin: false })?.key,
        module.key,
        `${module.label} loses its breadcrumb segment`,
      );
    }

    // «النماذج» named both this screen and the administration tab that manages
    // its templates; the screen now says what it is for, and so does the trail.
    assert.equal(moduleForPath('/forms', { isSuperAdmin: false })?.label, 'إنشاء كتاب');
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

describe('where signing in lands a person', () => {
  const clerk = { isSuperAdmin: false, mustChangePassword: false };
  const admin = { isSuperAdmin: true, mustChangePassword: false };
  /*
   * `member` is «belongs to a department letters are routed to», and it is part of
   * these fixtures because it decides whether الوارد إليّ exists for that person at
   * all. The mail-room clerk is the case that made it necessary: a registrar in no
   * department, who was being landed on an inbox that could never hold anything.
   */
  const mailRoom = { enabled: true, registrar: true, member: false, queueCount: 0, intakeFolderId: '7' };
  const lettersWaiting = { enabled: true, registrar: false, member: true, queueCount: 2 };
  const nothingWaiting = { enabled: true, registrar: false, member: true, queueCount: 0 };

  /**
   * The first version sent every employee to the mail queue whenever the
   * module was on, letters or not, and it did so from the sign-in page after
   * the tile menu had already painted — overriding a document link the person
   * had opened on purpose. The rule now lives here, and these pin down each
   * side of it.
   */
  test('the mail room starts at its front door, the intake screen', () => {
    assert.equal(signInLanding({ user: clerk, pathname: '/', status: mailRoom }), '/correspondence?tab=intake');
  });

  test('a person with letters waiting starts at their queue', () => {
    assert.equal(signInLanding({ user: clerk, pathname: '/', status: lettersWaiting }), '/correspondence');
  });

  test('nobody is sent to an empty queue', () => {
    assert.equal(signInLanding({ user: clerk, pathname: '/', status: nothingWaiting }), null);
  });

  test('an intake screen with no folder behind it is nobody\'s starting screen', () => {
    // Until the intake folder is configured, تسجيل كتاب is a notice with
    // nothing to press; the mail room keeps the menu, or its queue if letters wait.
    const unconfigured = { ...mailRoom, intakeFolderId: null };
    assert.equal(signInLanding({ user: clerk, pathname: '/', status: unconfigured }), null);
    assert.equal(signInLanding({ user: clerk, pathname: '/', status: { ...unconfigured, queueCount: 1 } }), '/correspondence');
  });

  test('a page asked for by its own URL is the destination, not the queue', () => {
    // A link out of a notification, a bookmark, or a session that expired
    // mid-work: the sign-in form shows at that URL and must return there.
    for (const pathname of ['/documents/123', '/folders/4', '/search?q=x', '/correspondence?tab=register']) {
      assert.equal(signInLanding({ user: clerk, pathname, status: mailRoom }), null, pathname);
    }
  });

  test('administrators and a forced password change keep the menu', () => {
    assert.equal(signInLanding({ user: admin, pathname: '/', status: mailRoom }), null);
    const forced = { ...clerk, mustChangePassword: true };
    assert.equal(signInLanding({ user: forced, pathname: '/', status: mailRoom }), null);
  });

  test('a module that is off, or a status that never came, changes nothing', () => {
    for (const status of [undefined, null, {}, { enabled: false, registrar: true, queueCount: 5 }]) {
      assert.equal(signInLanding({ user: clerk, pathname: '/', status }), null);
    }
  });

  test('the probe status is the one that lands the most people', () => {
    // The sign-in page asks with this first, to learn whether fetching the real
    // status could move anyone; a probe that lands nobody would silence the rule.
    assert.equal(signInLanding({ user: clerk, pathname: '/', status: MOST_PERMISSIVE_STATUS }), '/correspondence?tab=intake');
    assert.equal(signInLanding({ user: admin, pathname: '/', status: MOST_PERMISSIVE_STATUS }), null);
    assert.equal(signInLanding({ user: clerk, pathname: '/x', status: MOST_PERMISSIVE_STATUS }), null);
  });

  test('every landing is a tab the correspondence page can show its person', () => {
    const correspondence = MODULES.find((module) => module.key === 'correspondence');
    for (const status of [mailRoom, lettersWaiting]) {
      const target = signInLanding({ user: clerk, pathname: '/', status });
      const tab = new URL(target, 'http://x').searchParams.get('tab') ?? 'queue';
      const offered = visibleTabs(correspondence, status).map((entry) => entry.key);
      assert.ok(offered.includes(tab), `${target} lands on a tab withheld from that person`);
    }
  });

  test('the sign-in page reads the shared rule and decides before the shell renders', async () => {
    const source = await readFile(path.join(ROOT, 'client/src/pages/Login.jsx'), 'utf8');
    assert.match(source, /signInLanding\(/, 'the page must consume the shared rule');
    assert.match(source, /before:/, 'the landing must be chosen inside signIn, before the shell appears');
    assert.doesNotMatch(source, /status\.registrar|queueCount/, 'the page is restating the rule instead of asking it');
    assert.doesNotMatch(source, /replace: true/, 'the landing must be pushed so رجوع leads to the menu, not into a previous session');
    assert.match(source, /withTimeout\(/, 'a stalled status request must not hold a signed-in person on the form');
    assert.doesNotMatch(
      source,
      /finally\s*\{[^}]*setBusy\(false\)/,
      'the form must stay disabled after a successful sign-in until the shell replaces it',
    );
  });
});

describe('tabs a viewer may actually open', () => {
  const correspondence = MODULES.find((module) => module.key === 'correspondence');

  /**
   * The launcher offered three correspondence tiles to everyone while the page
   * let only the mail room open two of them, so an ordinary clerk pressed السجل
   * and landed on الوارد إليّ — every time, with nothing to say why. A tile is a
   * promise about a destination; one that silently goes elsewhere teaches the
   * reader that the screen is broken rather than that it was never theirs.
   *
   * The rule now lives in the registry and both consume it, so this checks the
   * rule itself: it must actually withhold something, and the right things.
   */
  test('a clerk is offered only the correspondence screen that is theirs', () => {
    const forClerk = visibleTabs(correspondence, { enabled: true, registrar: false, member: true });
    assert.deepEqual(forClerk.map((tab) => tab.key), ['queue']);
  });

  test('the mail room is offered all four', () => {
    const forRegistrar = visibleTabs(correspondence, { enabled: true, registrar: true, member: true });
    assert.deepEqual(
      forRegistrar.map((tab) => tab.key),
      CORRESPONDENCE_TABS.map((tab) => tab.key),
    );
  });

  test('an unanswered status withholds the restricted screens rather than guessing', () => {
    // The status request can fail; showing everyone the register on a network
    // hiccup is the one outcome worse than showing too little. الوارد إليّ is
    // withheld with the rest now: it belongs to department members, and a screen
    // that can never hold anything is no safer a default than the register.
    for (const capabilities of [{}, undefined, { enabled: true }]) {
      assert.deepEqual(visibleTabs(correspondence, capabilities).map((t) => t.key), []);
    }

    // And the one capability that opens it: belonging to a department.
    assert.deepEqual(
      visibleTabs(correspondence, { enabled: true, member: true }).map((t) => t.key),
      ['queue'],
    );
  });

  test('a module whose tabs carry no requirement is unaffected', () => {
    // الإدارة is gated at the module level, not per tab; every tab it has is
    // available to anyone who can see the module at all.
    const admin = MODULES.find((module) => module.key === 'admin');
    assert.equal(visibleTabs(admin, {}).length, ADMIN_TABS.length);

    const my = MODULES.find((module) => module.key === 'my');
    assert.equal(visibleTabs(my, {}).length, MY_TABS.length);
  });

  /**
   * The page must not restate the rule.
   *
   * It had its own copy — `entry.key === 'queue' || status.registrar` — which is
   * exactly how it and the launcher came to disagree. A second copy anywhere is
   * the bug returning.
   */
  test('the correspondence page reads the shared rule rather than its own', async () => {
    const source = await readFile(path.join(ROOT, 'client/src/pages/Correspondence.jsx'), 'utf8');

    assert.match(source, /visibleTabs\(/, 'the page must consume the shared rule');
    assert.doesNotMatch(
      source,
      /status\.registrar/,
      'the page is re-testing the capability itself instead of asking the registry',
    );

    /*
     * And it must not fall back to a screen it names itself.
     *
     * The fallback was `'queue'` — the one screen a mail-room clerk in no
     * department may never open — so the clerk opened the area every morning on
     * an empty inbox belonging to somebody else. The first permitted screen is
     * the only fallback that is right for every viewer.
     */
    assert.doesNotMatch(
      source,
      /:\s*'queue'\s*;/,
      'the page is falling back to a named screen instead of the first one this viewer may open',
    );
    assert.match(source, /permitted\[0\]/, 'the fallback must be the first screen this viewer may open');
  });

  test('the tile menu asks who the viewer is before offering sub-tiles', async () => {
    const source = await readFile(path.join(ROOT, 'client/src/pages/Home.jsx'), 'utf8');

    assert.ok(
      /visibleTabs\(/.test(source) || /homeAreas\(/.test(source),
      'the menu must filter what it offers through the registry, not a list of its own',
    );

    /*
     * The request itself moved. Five surfaces read this status — the menu, the
     * header, the breadcrumb, the folder tree and the mail tab bar — and five
     * separate requests can disagree for a moment, which is how a waiting badge
     * comes to contradict the tab bar beside it. So the menu reads the shared
     * answer, and the provider is what asks.
     */
    assert.match(source, /useMail\(/, 'the menu cannot filter by a capability it never asked for');

    const provider = await readFile(path.join(ROOT, 'client/src/MailContext.jsx'), 'utf8');
    assert.match(
      provider,
      /correspondence\.status\(\)/,
      'somebody has to actually ask the server who this person is to the mail room',
    );
  });
});

/**
 * The names the two areas are told apart by.
 *
 * Diacritics are not a distinction. Arabic writing drops them routinely and a
 * reader scanning a menu reads the skeleton of the word — which is how «المتابعة»
 * (the mail room's open referrals) and «المتابَعة» (documents I watch) came to be
 * the same name on one screen. So labels are compared with their marks stripped,
 * the way the reader compares them.
 */
describe('the names the two areas are told apart by', () => {
  /** The document page's tab labels, read from the page rather than restated. */
  const sectionLabels = async () => {
    const source = await readFile(path.join(ROOT, 'client/src/pages/DocumentDetail.jsx'), 'utf8');
    const block = source.match(/const SECTIONS = \[([\s\S]*?)\n\];/);
    assert.ok(block, 'could not find SECTIONS in DocumentDetail.jsx');

    const labels = [...block[1].matchAll(/label: '([^']+)'/g)].map((match) => ({ label: match[1] }));
    assert.ok(labels.length >= 9, `expected the full document tab set, found ${labels.length}`);
    return labels;
  };

  // Tashkeel (U+064B–U+0652, U+0670) and tatweel (U+0640): decoration over the
  // letters, not part of the word.
  const skeleton = (label) => label.replace(/[\u064B-\u0652\u0670\u0640]/g, '');

  test('no two labels read the same once their diacritics are gone', async () => {
    const named = [];
    const collect = (where, entries) => {
      for (const entry of entries) named.push({ where, label: entry.label });
    };

    collect('AREAS', AREAS);
    /*
     * The correspondence module is left out of the comparison and pinned by the
     * next test instead: its label IS the mail area's, deliberately, because the
     * page is the area and the trail should say that name once rather than twice.
     * Nothing escapes the check — the area label it equals is still compared
     * against every other name here.
     */
    collect('MODULES', MODULES.filter((module) => module.key !== 'correspondence'));
    collect('ADMIN_TABS', ADMIN_TABS);
    collect('CORRESPONDENCE_TABS', CORRESPONDENCE_TABS);
    collect('MY_TABS', MY_TABS);
    collect('تبويبات الوثيقة', await sectionLabels());

    const firstSeen = new Map();
    const collisions = [];
    for (const { where, label } of named) {
      const word = skeleton(label);
      if (firstSeen.has(word)) collisions.push(`«${label}» (${where}) = ${firstSeen.get(word)}`);
      else firstSeen.set(word, `«${label}» (${where})`);
    }

    assert.deepEqual(
      collisions,
      [],
      `two things the reader must tell apart share a name:\n${collisions.join('\n')}`,
    );
  });

  test('the correspondence screen is named after its area on purpose', () => {
    const mail = AREAS.find((area) => area.key === 'mail');
    const correspondence = MODULES.find((module) => module.key === 'correspondence');

    assert.equal(correspondence.area, 'mail');
    assert.equal(correspondence.label, mail.label, 'the page IS the area, so the two names are one name');
    // Which is what allowing the collision buys: the trail says it once.
    assert.deepEqual(breadcrumbFor({ pathname: '/correspondence' }).segments, [mail.label]);
  });
});

describe('every module belongs to an area', () => {
  test('a module names an area that exists', () => {
    // An area nothing declares is never drawn, so the module would vanish from
    // the menu while every one of its routes kept working.
    const keys = new Set(AREAS.map((area) => area.key));
    const orphans = MODULES
      .filter((module) => !keys.has(module.area))
      .map((module) => `${module.label} → ${module.area}`);

    assert.deepEqual(orphans, [], `modules in no area: ${orphans.join(', ')}`);
  });

  test('the areas are distinct, and each says what it is for', () => {
    assert.equal(new Set(AREAS.map((area) => area.key)).size, AREAS.length, 'two areas share a key');
    assert.equal(new Set(AREAS.map((area) => area.label)).size, AREAS.length, 'two areas share a name');

    // The hint under the heading is what the area is for; an area with only an
    // icon and a name is one the reader has to guess at.
    const bare = AREAS.filter((area) => !area.hint?.trim() || !area.icon).map((area) => area.label);
    assert.deepEqual(bare, [], `areas with no hint or icon: ${bare.join(', ')}`);
  });

  test('the mail area holds the letters work and nothing else', () => {
    assert.deepEqual(
      MODULES.filter((module) => module.area === 'mail').map((module) => module.key),
      ['correspondence', 'forms'],
    );
  });

  test('no documents module carries a letters screen', () => {
    // A mail screen reachable from «الوثائق والأرشيف» is exactly the mixing the
    // areas undid, and it reads as the archive owning the register.
    const mailTabs = new Set(CORRESPONDENCE_TABS.map((tab) => tab.key));
    const leaked = MODULES
      .filter((module) => module.area === 'docs')
      .flatMap((module) => (module.tabs ?? [])
        .filter((tab) => mailTabs.has(tab.key))
        .map((tab) => `${module.label} → ${tab.label}`));

    assert.deepEqual(leaked, [], `letters screens inside the documents area: ${leaked.join(', ')}`);
  });
});

describe('where the breadcrumb says the reader is', () => {
  const employee = { isSuperAdmin: false };
  const boss = { isSuperAdmin: true };
  // What the shell hands in: the correspondence status of the person reading.
  const registrar = { enabled: true, registrar: true, member: false };
  const memberOnly = { enabled: true, registrar: false, member: true };

  const trail = (args) => breadcrumbFor(args).segments;

  test('a documents screen reads: area, then screen, then tab', () => {
    assert.deepEqual(trail({ pathname: '/folders/12', user: employee }), ['الوثائق والأرشيف', 'المجلدات']);
    assert.deepEqual(
      trail({ pathname: '/my', search: '?tab=recent', user: employee }),
      ['الوثائق والأرشيف', 'مساحتي', 'المفتوحة مؤخراً'],
    );
  });

  test('a mail screen names the area once, then the screen', () => {
    assert.deepEqual(
      trail({ pathname: '/correspondence', user: employee, capabilities: memberOnly }),
      ['الوارد والصادر', 'الوارد إليّ'],
    );
    assert.deepEqual(
      trail({ pathname: '/correspondence', search: '?tab=intake', user: employee, capabilities: registrar }),
      ['الوارد والصادر', 'تسجيل كتاب'],
    );
    assert.deepEqual(trail({ pathname: '/forms', user: employee }), ['الوارد والصادر', 'إنشاء كتاب']);
  });

  test('a screen this viewer cannot open is named as the one they will land on', () => {
    // The page falls back to the first permitted screen, so a trail still
    // reading «السجل» would be naming somebody else's screen to their face.
    assert.deepEqual(
      trail({ pathname: '/correspondence', search: '?tab=register', user: employee, capabilities: memberOnly }),
      ['الوارد والصادر', 'الوارد إليّ'],
    );
  });

  test('administration is alone in its area, so its name is not said twice', () => {
    assert.deepEqual(
      trail({ pathname: '/admin', search: '?tab=audit', user: boss }),
      ['إدارة النظام', 'سجل التدقيق'],
    );
  });

  test('a page in no module leaves the trail empty rather than guessing an area', () => {
    for (const args of [
      // Not an administrator: there is no administration module to name.
      { pathname: '/admin', user: employee },
      // A document can belong to both areas at once, so the trail claims neither.
      { pathname: '/documents/9', user: employee },
      { pathname: '/', user: boss },
    ]) {
      const where = breadcrumbFor(args);
      assert.equal(where.area, null, args.pathname);
      assert.deepEqual(where.segments, [], args.pathname);
    }
  });

  test('the shell draws its chip and its trail from this one answer', () => {
    // Three places say where the reader is. Asked separately they disagree, and
    // a chip reading «الوارد والصادر» over a trail reading «الوثائق والأرشيف» is
    // worse than neither of them.
    for (const args of [
      { pathname: '/folders/12', user: employee },
      { pathname: '/forms', user: employee },
      { pathname: '/admin', user: boss },
    ]) {
      const where = breadcrumbFor(args);
      assert.equal(where.segments[0], where.area.label, args.pathname);
    }

    assert.match(appSource, /breadcrumbFor\(/, 'the shell must read the shared answer, not build its own');
    assert.match(appSource, /MailProvider/, 'the mail status must be asked once, above every screen that reads it');
  });
});

describe('the home page each person is shown', () => {
  const employee = { isSuperAdmin: false };
  const boss = { isSuperAdmin: true };

  /** The keys of one area's items, or null when the area is not drawn at all. */
  const itemsOf = (areas, key) =>
    areas.find((area) => area.key === key)?.items.map((item) => item.key) ?? null;

  test('the mail room is offered the three screens of the mail room', () => {
    // A registrar in no department: registering, the register, and the referrals
    // to chase. Not الوارد إليّ — nothing can ever be routed to them.
    const areas = homeAreas({ user: employee, mail: { enabled: true, registrar: true, member: false } });
    assert.deepEqual(itemsOf(areas, 'mail'), ['intake', 'register', 'followup']);
  });

  test('a department member is offered their inbox and nothing else', () => {
    const areas = homeAreas({ user: employee, mail: { enabled: true, registrar: false, member: true } });
    assert.deepEqual(itemsOf(areas, 'mail'), ['queue']);
  });

  test('somebody with no mail duties sees no mail heading at all', () => {
    const areas = homeAreas({ user: employee, mail: { enabled: true, registrar: false, member: false } });
    assert.equal(itemsOf(areas, 'mail'), null, 'an empty area must not be drawn');
    assert.ok(itemsOf(areas, 'docs').length > 0, 'the documents area belongs to everyone');
  });

  test('a usable template no longer draws the area while the master switch is off', () => {
    // It used to: «إنشاء كتاب» was treated as a feature that stood on its own.
    // `correspondence.enabled` is now the master switch of the whole area, so
    // with it off the home page is the core document management and nothing of
    // the mail process — which is the isolation the owner asked for.
    const areas = homeAreas({ user: employee, mail: { enabled: false }, formsUsable: true });
    assert.equal(itemsOf(areas, 'mail'), null, 'the master switch is off; there is no mail area');
    assert.ok(itemsOf(areas, 'docs').length > 0, 'the documents area is untouched by the switch');
  });

  test('the master switch off hides «إنشاء كتاب» however usable the template is', () => {
    // Straight at `mailActions`, because this is the rule itself rather than the
    // home page's use of it: no status, a status that answered «off», and a
    // status that failed all come to the same answer — nothing.
    for (const status of [null, undefined, { enabled: false }, { enabled: false, failed: true }]) {
      assert.deepEqual(mailActions(status, true), [], `${JSON.stringify(status)} offered a screen`);
    }

    // And with the master on, the same call does offer it.
    const on = mailActions({ enabled: true, registrar: false, member: false }, true);
    assert.deepEqual(on.map((action) => action.key), ['forms']);
  });

  test('before the status answers, nothing of the area is drawn', () => {
    // null is «not yet», not «no». Guessing either way flashes a heading on and
    // off, or worse, offers a screen and then withdraws it.
    assert.equal(itemsOf(homeAreas({ user: employee, mail: null }), 'mail'), null);
  });

  test('إدارة النظام is only ever an administrator\'s area', () => {
    assert.equal(itemsOf(homeAreas({ user: employee, mail: null }), 'system'), null);
    // Signed out, or before the session resolves, is not an administrator.
    assert.equal(itemsOf(homeAreas({ user: null, mail: null }), 'system'), null);
    assert.deepEqual(itemsOf(homeAreas({ user: boss, mail: null }), 'system'), ['admin']);
  });

  test('the areas keep their fixed order, whatever is in them', () => {
    // Fixed so that a person learns where each kind of work lives once. The mail
    // area offers its screens directly; the other two offer tiles.
    const areas = homeAreas({
      user: boss,
      mail: { enabled: true, registrar: true, member: true },
      formsUsable: true,
    });

    assert.deepEqual(areas.map((area) => area.key), ['docs', 'mail', 'system']);
    assert.deepEqual(areas.map((area) => area.kind), ['tiles', 'actions', 'tiles']);
  });

  /**
   * The case that decides whether the areas were safe to introduce.
   *
   * Everyone who ever dragged a tile has a saved order naming الوارد والصادر and
   * النماذج as tiles of the one flat menu, beside names of modules that are gone.
   * If any of those stale names could displace a documents tile, the people who
   * use the system enough to have arranged it would silently lose part of it.
   */
  test('a saved order from before the areas loses nothing', () => {
    const docsKeys = MODULES
      .filter((module) => module.area === 'docs')
      .map((module) => module.key)
      .sort();

    for (const user of [employee, boss]) {
      for (const order of [
        ['correspondence', 'forms', 'admin', 'gone'],
        ['recycle', 'correspondence', 'folders', 'gone', 'my', 'forms', 'search', 'admin'],
        ['search', 'admin', 'my'],
        [],
      ]) {
        const areas = homeAreas({
          user,
          mail: { enabled: true, registrar: true, member: true },
          formsUsable: true,
          order,
        });

        assert.deepEqual(
          [...itemsOf(areas, 'docs')].sort(),
          docsKeys,
          `saved order ${JSON.stringify(order)} changed what the documents area holds`,
        );
      }
    }
  });

  test('the menu and the area\'s own tab bar offer the same screens', () => {
    // Both read `mailActions`, so this pins the join: the home page's mail block
    // is the area's tab bar, and every entry carries somewhere to go.
    const status = { enabled: true, registrar: true, member: true };
    const areas = homeAreas({ user: employee, mail: status, formsUsable: true });
    const actions = mailActions(status, true);

    assert.deepEqual(itemsOf(areas, 'mail'), actions.map((action) => action.key));
    for (const action of actions) {
      assert.ok(action.to?.startsWith('/'), `${action.label} has nowhere to go`);
      assert.ok(action.label?.trim() && action.description?.trim(), `${action.key} says too little`);
    }
  });
});

describe('findings from the review of the area separation', () => {
  const clerk = { isSuperAdmin: false };

  test('a status that failed keeps the mail section, marked, instead of dropping it', () => {
    // Dropping it would tell a department member on a flaky connection that
    // they have no mail work at all.
    const areas = homeAreas({ user: clerk, mail: { enabled: false, failed: true } });
    const mail = areas.find((area) => area.key === 'mail');
    assert.ok(mail, 'the mail section vanished on a failed request');
    assert.equal(mail.failed, true);
    assert.deepEqual(mail.items, []);
  });

  test('a status that answered «off» still leaves no mail section for someone without a template', () => {
    const areas = homeAreas({ user: clerk, mail: { enabled: false } });
    assert.equal(areas.some((area) => area.key === 'mail'), false);
  });

  test('the «مساحتي» tile describes its tabs by their current names', () => {
    // A hand-typed description kept saying «المتابَع» after the tab became «ما أتابعه».
    const my = MODULES.find((module) => module.key === 'my');
    for (const tab of MY_TABS) {
      assert.ok(my.description.includes(tab.label), `the description does not name «${tab.label}»`);
    }
  });

  test('the shared mail bar always holds the screen it sits on', async () => {
    const source = await readFile(path.join(ROOT, 'client/src/components/MailAreaNav.jsx'), 'utf8');
    assert.match(source, /currentScreen\(active\)/, 'the page being read can be missing from its own bar');
    assert.match(source, /aria-current/, 'the current entry is marked only visually');
  });

  test('the letters-folder notice links to a screen the reader may open', async () => {
    const source = await readFile(path.join(ROOT, 'client/src/pages/Browse.jsx'), 'utf8');
    assert.doesNotMatch(source, /to="\/correspondence"/, 'a hard-coded link lands a forms-only reader on «no screens for you»');
    assert.match(source, /mailScreens\[0\]\.to/);
  });
});
