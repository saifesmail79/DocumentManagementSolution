/**
 * What the application is made of, in one place.
 *
 * ─── Why a registry rather than a list per screen ───────────────────────────
 *
 * The modules are now named in three places that must agree: the tile menu that
 * launches them, the breadcrumb that says where you are, and the pages that own
 * the tabs a tile links into. Kept as three separate arrays they drift — a tab
 * renamed in الإدارة would keep its old name on the tile that opens it, and the
 * tile would still work, which is the kind of wrong nobody reports because
 * nothing breaks.
 *
 * So the tabs live here and the pages import them. A screen and the tile that
 * opens it cannot disagree about what it is called.
 *
 * ─── The two areas ───────────────────────────────────────────────────────────
 *
 * The system is two kinds of work that used to share one flat menu: keeping and
 * finding documents («الوثائق والأرشيف»), and handling official letters that
 * arrive or leave («الوارد والصادر»). Mixed together, nobody could tell which
 * screen was for which job — «المراسلات» was a tile, an administration tab and a
 * folder at once, and «المتابعة» and «المتابَعة» differed by one diacritic while
 * meaning unrelated things. So every module declares its area here, the home
 * page, the breadcrumb and the header all draw the area from this file, and
 * tests/navigation.test.js refuses two labels that read the same.
 */

import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  BookOpen,
  CheckSquare,
  Clock,
  FilePenLine,
  FilePlus,
  FolderTree,
  GitBranch,
  Inbox,
  KeyRound,
  LayoutTemplate,
  Mailbox,
  PenLine,
  ScanSearch,
  ScrollText,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Star,
  Tags,
  Timer,
  Trash2,
  Users,
  UsersRound,
  Webhook,
} from 'lucide-react';

/** The administration screens, in the order they are shown. */
export const ADMIN_TABS = [
  { key: 'users', label: 'المستخدمون', icon: Users },
  { key: 'groups', label: 'المجموعات', icon: UsersRound },
  { key: 'roles', label: 'الأدوار', icon: KeyRound },
  { key: 'permissions', label: 'الصلاحيات', icon: Shield },
  { key: 'metadata', label: 'البيانات الوصفية', icon: Tags },
  { key: 'settings', label: 'الإعدادات', icon: SlidersHorizontal },
  { key: 'approvals', label: 'مسارات الاعتماد', icon: GitBranch },
  { key: 'keys', label: 'مفاتيح API', icon: KeyRound },
  { key: 'webhooks', label: 'الويب هوكس', icon: Webhook },
  { key: 'reports', label: 'التقارير', icon: BarChart3 },
  { key: 'audit', label: 'سجل التدقيق', icon: ScrollText },
  { key: 'diagnostics', label: 'التشخيص', icon: Activity },
  { key: 'classification', label: 'التعرّف التلقائي (تجريبي)', icon: ScanSearch },
  // `group: 'mail'` draws these two apart from the rest, under «الوارد والصادر»:
  // configuring the mail room is configuring the other area, and the labels
  // say what is set up there rather than repeating the area's name.
  { key: 'correspondence', label: 'الأقسام ومجلد الاستلام', icon: Mailbox, group: 'mail' },
  { key: 'forms', label: 'نماذج الكتب', icon: LayoutTemplate, group: 'mail' },
];

/**
 * The correspondence screens.
 *
 * `requires` names a capability the viewer must hold, and it is declared here
 * rather than inside the page because two places consume this list: the page
 * that draws the tabs and the tile menu that launches into them. The page knew
 * the rule and the tile menu did not, so a clerk was offered three tiles and two
 * of them silently dropped them back on the first — a tile promising a
 * destination it cannot open is worse than no tile, because the reader concludes
 * the screen is broken rather than that it was never theirs.
 *
 * «الوارد إليّ» requires `member` — belonging to a department that letters are
 * routed to. Without it the screen can never hold anything, and offering it
 * anyway is how the mail-room clerk came to open every day on an empty inbox.
 *
 * `description` is what the home page prints under each screen, because in the
 * mail area the screens themselves are the choices on offer.
 */
export const CORRESPONDENCE_TABS = [
  {
    key: 'queue',
    label: 'الوارد إليّ',
    icon: Inbox,
    requires: 'member',
    description: 'الكتب المحالة إلى قسمك: تسلّمها، ثم أنجزها.',
  },
  {
    key: 'intake',
    label: 'تسجيل كتاب',
    icon: FilePlus,
    requires: 'registrar',
    description: 'وصل كتاب؟ امسحه أو ارفعه، فيُقيَّد برقم في الدفتر ويُحال إلى الأقسام.',
  },
  {
    key: 'register',
    label: 'السجل',
    icon: BookOpen,
    requires: 'registrar',
    description: 'دفترا الوارد والصادر: ابحث عن أي كتاب واعرف أين وصل.',
  },
  {
    key: 'followup',
    label: 'متابعة الإحالات',
    icon: Timer,
    requires: 'registrar',
    description: 'الإحالات المفتوحة لدى الأقسام، الأقدم أولاً، مع تأشير المتأخّر.',
  },
];

/** The personal views, in the order they are shown. */
export const MY_TABS = [
  { key: 'favourites', label: 'المفضلة', icon: Star },
  { key: 'recent', label: 'المفتوحة مؤخراً', icon: Clock },
  // Not «المتابَعة»: that read as the mail room's «متابعة الإحالات» with one
  // diacritic missing, and the two have nothing to do with each other.
  { key: 'watches', label: 'ما أتابعه', icon: Bell },
  { key: 'approvals', label: 'بانتظار موافقتي', icon: CheckSquare },
];

/**
 * The areas the system is divided into, in the order the home page draws them.
 *
 * The order is fixed rather than arrangeable: the point of the division is that
 * it always has the same shape, so a person learns where each kind of work is
 * once. Tiles can still be arranged inside «الوثائق والأرشيف».
 *
 * Areas are told apart by icon, name and a heading band — never by colour. The
 * only spare colour token sits next to the amber that already means pending,
 * overdue and truncated in this client.
 */
export const AREAS = [
  {
    key: 'docs',
    label: 'الوثائق والأرشيف',
    icon: Archive,
    hint: 'حفظ الوثائق والوصول إليها: المجلدات والبحث ومساحتك والمحذوفات.',
  },
  {
    key: 'mail',
    label: 'الوارد والصادر',
    icon: Mailbox,
    hint:
      'الكتب الرسمية: ما يصل يُسجَّل برقم ويُحال إلى الأقسام، وما يصدر يُنشأ من نموذج ثم يُسجَّل صادراً. '
      + 'التوقيع يجري من صفحة الكتاب نفسه.',
  },
  {
    key: 'system',
    label: 'إدارة النظام',
    icon: Settings,
    hint: 'المستخدمون والصلاحيات والإعدادات ومتابعة حالة النظام — لمديري النظام.',
    superAdmin: true,
  },
];

/**
 * The modules the tile menu offers.
 *
 * `description` is not decoration. A tile is a larger, emptier target than a
 * menu row, and the space it buys is only worth taking if it is used to say what
 * the module is for — otherwise it is the same four words, further apart.
 *
 * `tabs` is what a tile expands to show. A module without any is a single
 * destination and opens on the first click rather than asking for a second.
 */
export const MODULES = [
  {
    key: 'folders',
    area: 'docs',
    to: '/folders',
    label: 'المجلدات',
    icon: FolderTree,
    description: 'تصفّح الأرشيف حسب بنيته، وارفع الوثائق إلى مكانها.',
  },
  {
    key: 'my',
    area: 'docs',
    to: '/my',
    label: 'مساحتي',
    icon: Star,
    // Built from the tabs rather than typed out: a hand copy kept naming
    // «المتابَع» after the tab it described had been renamed «ما أتابعه».
    description: `ما يخصّك: ${MY_TABS.map((tab) => tab.label).join('، ')}.`,
    subgroup: 'ما يخصّني',
    tabs: MY_TABS,
  },
  {
    key: 'correspondence',
    area: 'mail',
    to: '/correspondence',
    // The same words as the area, on purpose: the page IS the area, and the
    // breadcrumb collapses the two instead of saying them twice. It also frees
    // «المراسلات» to mean one thing only — the folder in the tree.
    label: 'الوارد والصادر',
    icon: Mailbox,
    description: 'تسجيل الكتب الواردة والصادرة، وإحالتها إلى الأقسام، ومتابعة إنجازها.',
    tabs: CORRESPONDENCE_TABS,
  },
  {
    key: 'forms',
    area: 'mail',
    to: '/forms',
    // An action, not the tool's name: «النماذج» was also the administration tab
    // that manages the templates, and beside «تسجيل كتاب» this says which
    // letter it is for — one that we write.
    label: 'إنشاء كتاب',
    icon: FilePenLine,
    description: 'ستُصدر كتاباً؟ املأ نموذجاً معتمداً فيولّد النظام الكتاب ويودعه في مجلده، ثم سجّله صادراً.',
    // Only for someone with a usable template: the menu asks the server.
    requires: 'forms',
  },
  {
    key: 'search',
    area: 'docs',
    to: '/search',
    label: 'البحث',
    icon: Search,
    description: 'ابحث في النصوص والبيانات الوصفية عبر الأرشيف كله.',
  },
  {
    key: 'recycle',
    area: 'docs',
    to: '/recycle-bin',
    label: 'المحذوفات',
    icon: Trash2,
    description: 'الوثائق المحذوفة خلال مهلة الاسترجاع، ويمكن إعادتها.',
  },
  {
    key: 'admin',
    area: 'system',
    to: '/admin',
    label: 'الإدارة',
    icon: Settings,
    description: 'المستخدمون والصلاحيات والإعدادات ومتابعة حالة النظام.',
    subgroup: 'الإعداد والمتابعة',
    tabs: ADMIN_TABS,
    superAdmin: true,
  },
];

/**
 * The modules this user may see.
 *
 * Hiding الإدارة is a convenience, not the control: every /api/admin route
 * refuses a non-administrator on its own, so a tile that leaked through would
 * produce a refusal rather than access.
 */
export function visibleModules(user, capabilities = {}) {
  return MODULES.filter(
    (module) =>
      (!module.superAdmin || user?.isSuperAdmin)
      // A module that names a capability is offered only to someone who holds
      // it — the same rule `visibleTabs` applies inside a module. A tile for
      // a screen the person cannot use teaches them the menu is broken.
      && (!module.requires || capabilities?.[module.requires] === true),
  );
}

/**
 * The modules in the order this user arranged them.
 *
 * ─── Why a saved order is not simply the order ──────────────────────────────
 *
 * The stored list and the module list drift apart, in both directions, and both
 * are ordinary rather than exceptional:
 *
 *   • A module is added after somebody arranged their tiles. It is in no saved
 *     order anywhere, and if an unlisted module were dropped it would be
 *     invisible to precisely the people who use the system most — the ones who
 *     have arranged it. So it is appended, in registry order, and appears.
 *
 *   • A module is removed, or the viewer stops being an administrator. Their
 *     saved order still names الإدارة. A name with no module is skipped, not
 *     treated as an error: a stale entry must not be able to break the menu, and
 *     must certainly not resurrect a tile the viewer may no longer see.
 *
 * The visibility rules are applied before this, never by it — this function
 * orders what it is handed and cannot add to it.
 *
 * @param {Array<object>} modules  The modules this viewer may see.
 * @param {string[]}      order    Saved module keys, oldest arrangement first.
 */
export function applyOrder(modules, order) {
  if (!Array.isArray(order) || order.length === 0) return modules;

  const byKey = new Map(modules.map((module) => [module.key, module]));
  const arranged = [];

  for (const key of order) {
    const module = byKey.get(key);
    if (!module) continue;
    arranged.push(module);
    // Removed as it is placed, so the remainder below is exactly what the saved
    // order did not mention.
    byKey.delete(key);
  }

  // Whatever is left keeps its registry order, after the arranged ones.
  return [...arranged, ...modules.filter((module) => byKey.has(module.key))];
}

/**
 * The same list with one tile moved, as a set of keys to save.
 *
 * Kept beside `applyOrder` because the two are one idea: this produces what that
 * consumes, and a reorder that produced anything else would be a bug neither
 * could see on its own.
 */
export function reorder(modules, fromIndex, toIndex) {
  const keys = modules.map((module) => module.key);
  if (
    fromIndex === toIndex
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= keys.length
    || toIndex >= keys.length
  ) {
    return keys;
  }

  const moved = keys.splice(fromIndex, 1)[0];
  keys.splice(toIndex, 0, moved);
  return keys;
}

/**
 * The tabs of one module that this viewer may actually open.
 *
 * `capabilities` is whatever the module's own status endpoint reports — for
 * correspondence, `{ registrar: true }`. A tab with no `requires` is for
 * everyone; a tab whose capability is absent or false is not offered.
 *
 * Both the module's page and the tile menu call this, which is the whole point:
 * the rule about who sees السجل lives in one expression, so the launcher cannot
 * offer a screen the page will refuse to open.
 */
export function visibleTabs(module, capabilities = {}) {
  return (module?.tabs ?? []).filter((tab) => !tab.requires || Boolean(capabilities[tab.requires]));
}

/**
 * Where signing in lands a person, or null to stay put.
 *
 * Only when nobody asked for a page. The sign-in form is shown at whatever
 * URL was opened — a link out of a notification, a bookmark, a page whose
 * session expired — and that URL is the destination; overriding it would
 * throw the reader off the very document they came for. At the root, the
 * mail room starts at the intake screen, its front door — once an intake
 * folder has been configured, since before that the screen is a notice with
 * nothing to press; a person whose unit has letters waiting starts at their
 * queue; everyone else keeps the tile menu, because an empty queue is not a
 * starting screen. Administrators keep the menu: their day has no single
 * starting screen.
 *
 * `status` is the correspondence status reply. Asked with the most
 * permissive status possible, the answer says whether fetching the real one
 * could change anything — the sign-in page uses that to skip the request.
 */
export function signInLanding({ user, pathname, status }) {
  if (!user || user.isSuperAdmin || user.mustChangePassword) return null;
  if (pathname !== '/') return null;
  if (!status?.enabled) return null;
  if (status.registrar && status.intakeFolderId) return '/correspondence?tab=intake';
  if (Number(status.queueCount) > 0) return '/correspondence';
  return null;
}

/** The status that lands the most people: what `signInLanding` is probed with. */
export const MOST_PERMISSIVE_STATUS = Object.freeze({
  enabled: true,
  registrar: true,
  member: true,
  queueCount: 1,
  intakeFolderId: '1',
});

/** The module a path belongs to, for the breadcrumb and the active tile. */
export function moduleForPath(pathname, user) {
  /*
   * Not `visibleModules`: that answers «what may I be offered», which is gated on
   * capabilities the shell never fetches — so a capability-gated module such as
   * النماذج matched nothing and its screens lost the breadcrumb segment every
   * other screen shows. This answers «where am I», about a page the router has
   * already opened, and the route itself is the access control. الإدارة is still
   * withheld, because a non-administrator is never on one of its pages.
   */
  return (
    MODULES.find(
      (module) => pathname.startsWith(module.to) && (!module.superAdmin || user?.isSuperAdmin),
    ) ?? null
  );
}

/**
 * The mail area's screens this viewer may open, as the home page and the
 * area's own tab bar list them.
 *
 * Built from the registry rather than written out a second time: the rule about
 * who sees السجل is `visibleTabs`, and a launcher with its own list is how a
 * menu comes to offer a screen the page then refuses.
 *
 * `status` is the correspondence status reply; `formsUsable` says whether this
 * person has a letter template they can fill.
 *
 * ─── The area exists only with the master switch on ─────────────────────────
 *
 * `correspondence.enabled` is the master switch of the whole area, not just of
 * the register: with it off the system is the core document management and
 * nothing else — no mail screens, no «إنشاء كتاب», no «التوقيع» and no paper
 * trail — because an institute that refuses the letter process refuses all of
 * it, not the register alone. So nothing is offered here unless the status says
 * `enabled`, and `formsUsable` can no longer carry the area on its own: the
 * server now reports a format as usable only while the master switch is on, and
 * this reads the same rule on its own rather than trusting that it travelled.
 */
export function mailActions(status, formsUsable = false) {
  if (status?.enabled !== true) return [];

  const actions = [];

  const correspondence = MODULES.find((module) => module.key === 'correspondence');
  for (const tab of visibleTabs(correspondence, status)) {
    actions.push({
      key: tab.key,
      label: tab.label,
      icon: tab.icon,
      description: tab.description,
      to: `${correspondence.to}?tab=${tab.key}`,
    });
  }

  if (formsUsable === true) {
    const forms = MODULES.find((module) => module.key === 'forms');
    actions.push({
      key: forms.key,
      label: forms.label,
      icon: forms.icon,
      description: forms.description,
      to: forms.to,
    });
  }

  return actions;
}

/**
 * The blocks the home page draws: one per area, in the fixed area order, each
 * holding what this viewer may open there. An area with nothing in it is left
 * out entirely, so an employee with no mail duties sees no mail heading at all.
 *
 * Documents and administration hold module tiles, in the viewer's saved order.
 * The mail area holds its screens directly (`kind: 'actions'`): «what do I press
 * for this letter» is answered on the menu itself, with no tile to expand first.
 *
 * One exception to "empty is not drawn": when the correspondence status could
 * not be fetched, the mail area comes back with `failed: true` so the page can
 * say so and offer to try again. Dropping it silently would tell a department
 * member on a flaky connection that they have no mail work, which is false.
 *
 * A usable letter template no longer keeps the mail area alive on its own. It
 * used to — «إنشاء كتاب» was treated as a feature that worked without the
 * register — but `correspondence.enabled` is now the master switch of the whole
 * area, so with it off this page shows the core document management and no mail
 * heading at all. `mailActions` holds that rule.
 *
 * @param {object}   args
 * @param {object}   args.user
 * @param {object}   [args.mail]         correspondence status reply
 * @param {boolean}  [args.formsUsable]
 * @param {string[]} [args.order]        saved tile order ('home.tileOrder')
 */
export function homeAreas({ user, mail = null, formsUsable = false, order = [] }) {
  const tiles = applyOrder(
    visibleModules(user, { forms: formsUsable }).filter((module) => module.area !== 'mail'),
    order,
  );

  return AREAS
    .filter((area) => !area.superAdmin || user?.isSuperAdmin)
    .map((area) => (
      area.key === 'mail'
        ? { ...area, kind: 'actions', items: mailActions(mail, formsUsable), failed: mail?.failed === true }
        : { ...area, kind: 'tiles', items: tiles.filter((module) => module.area === area.key) }
    ))
    .filter((area) => area.items.length > 0 || area.failed === true);
}

/**
 * Where a path is, as the breadcrumb says it: the area, then the screen.
 *
 * `segments` never repeats itself. The module is left out when its name is the
 * area's name (/correspondence is «الوارد والصادر», not that twice) or when it is
 * the only module in its area (/admin is «إدارة النظام», then the tab). The tab
 * is the one requested when this viewer may open it, otherwise the first one
 * they may — which is where each page itself falls back to.
 *
 * Deliberately blind to whether a module is switched on: the router has opened
 * the page, and the reader is owed its name either way.
 *
 * @param {object} args
 * @param {string} args.pathname
 * @param {string} [args.search]        location.search, for ?tab=
 * @param {object} [args.user]
 * @param {object} [args.capabilities]  what visibleTabs needs; omit to name no tab of a gated module
 * @returns {{ area: object|null, segments: string[] }}
 */
export function breadcrumbFor({ pathname, search = '', user = null, capabilities = {} }) {
  const module = moduleForPath(pathname, user);
  if (!module) return { area: null, segments: [] };

  const area = AREAS.find((entry) => entry.key === module.area) ?? null;
  const segments = area ? [area.label] : [];

  const alone = MODULES.filter((entry) => entry.area === module.area).length === 1;
  if (module.label !== area?.label && !alone) segments.push(module.label);

  const offered = visibleTabs(module, capabilities);
  if (offered.length > 0) {
    const requested = new URLSearchParams(search).get('tab');
    const tab = offered.find((entry) => entry.key === requested) ?? offered[0];
    segments.push(tab.label);
  }

  return { area, segments };
}
