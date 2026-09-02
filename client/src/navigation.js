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
 */

import {
  Activity,
  BarChart3,
  Bell,
  CheckSquare,
  Clock,
  FolderTree,
  GitBranch,
  KeyRound,
  ScanSearch,
  ScrollText,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Star,
  Tags,
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
];

/** The personal views, in the order they are shown. */
export const MY_TABS = [
  { key: 'favourites', label: 'المفضلة', icon: Star },
  { key: 'recent', label: 'المفتوحة مؤخراً', icon: Clock },
  { key: 'watches', label: 'المتابَعة', icon: Bell },
  { key: 'approvals', label: 'بانتظار موافقتي', icon: CheckSquare },
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
    to: '/folders',
    label: 'المجلدات',
    icon: FolderTree,
    description: 'تصفّح الأرشيف حسب بنيته، وارفع الوثائق إلى مكانها.',
  },
  {
    key: 'my',
    to: '/my',
    label: 'مساحتي',
    icon: Star,
    description: 'ما يخصّك: المفضلة، المفتوح مؤخراً، والمتابَع، وما ينتظر موافقتك.',
    subgroup: 'ما يخصّني',
    tabs: MY_TABS,
  },
  {
    key: 'search',
    to: '/search',
    label: 'البحث',
    icon: Search,
    description: 'ابحث في النصوص والبيانات الوصفية عبر الأرشيف كله.',
  },
  {
    key: 'recycle',
    to: '/recycle-bin',
    label: 'المحذوفات',
    icon: Trash2,
    description: 'الوثائق المحذوفة خلال مهلة الاسترجاع، ويمكن إعادتها.',
  },
  {
    key: 'admin',
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
export function visibleModules(user) {
  return MODULES.filter((module) => !module.superAdmin || user?.isSuperAdmin);
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

/** The module a path belongs to, for the breadcrumb and the active tile. */
export function moduleForPath(pathname, user) {
  return visibleModules(user).find((module) => pathname.startsWith(module.to)) ?? null;
}
