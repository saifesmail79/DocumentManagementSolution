/**
 * The menu, one section per area, per docs/UI_UX_AGENT_STANDARDS.md section 3.
 *
 * ─── Why the menu is divided before it is arranged ──────────────────────────
 *
 * Every module used to sit in one flat grid, so «المجلدات» stood beside
 * «الوارد والصادر» as though filing a scan and registering an official letter
 * were the same kind of errand. They are not, and the person reading the menu
 * could not tell which tile belonged to which job — the complaint that started
 * this was literally "I don't know what to use for what action".
 *
 * So the grid is now one bordered section per area — «الوثائق والأرشيف»,
 * «الوارد والصادر», «إدارة النظام» — each with its own icon, name and one-line
 * hint, drawn from `homeAreas()` in navigation.js. The areas are told apart by
 * icon, name and heading and never by colour: colour here would be decoration
 * that some readers cannot see, and the amber and red tokens already mean
 * pending and waiting elsewhere in this client.
 *
 * An area with nothing in it is not drawn at all. An employee in no department
 * with no letter template sees no mail heading, rather than a heading over an
 * empty space that invites them to wonder what they are missing.
 *
 * ─── What a tile does when it is pressed ────────────────────────────────────
 *
 * In «الوثائق والأرشيف» a module that is a single destination — البحث,
 * المحذوفات, المجلدات — opens on the first press, and one that holds several
 * screens expands into a panel linking straight into each of them. Reaching
 * سجل التدقيق used to mean opening الإدارة and hunting for the eleventh tab,
 * and there was no way to say beforehand that it existed.
 *
 * «الوارد والصادر» skips the tile-then-panel step entirely: its items ARE the
 * screens («تسجيل كتاب», «الوارد إليّ», «السجل»…), each a single press. The
 * question being answered there is "which button for this letter", and making
 * someone open a module first to read the answer is the mixing this change
 * exists to undo.
 *
 * ─── Rearranging, and where the arrangement lives ───────────────────────────
 *
 * Only the documents tiles rearrange. The area order is fixed, because the
 * whole value of the division is that it keeps the same shape — a person learns
 * where each kind of work lives once. The mail items are not draggable either:
 * they are a procedure in its own order (a letter arrives, is registered, is
 * referred, is followed up), and shuffling the steps would teach nothing.
 *
 * The saved order is stored against the account rather than the browser — see
 * the note in migration 0015 — so someone who arranges the menu on the
 * workstation in the records room finds the same arrangement on their own
 * machine, which is the only reading of "remember this" that is not a small
 * lie. The stored value is still a plain list of module keys.
 *
 * Dragging is not the only way to do it. A tile can also be moved with
 * Ctrl+Arrow while focused, because a drag is unavailable to anyone working
 * from the keyboard and a feature that is mouse-only is a feature some people
 * simply do not have.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronUp, ExternalLink, GripVertical, RotateCcw, X } from 'lucide-react';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { AREAS, homeAreas, reorder, visibleTabs } from '../navigation.js';
import { useMail } from '../MailContext.jsx';
import { useHelpTopic } from '../help/HelpContext.jsx';
import { useBranding } from '../branding.js';
import { Alert } from '../components/ui.jsx';

const TILE_ORDER = 'home.tileOrder';

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();

  /*
   * Who this person is to the mail area, asked once for the whole shell rather
   * than here. The menu, the header, the tab bar and the folder tree all need
   * the same answer, and four requests that can disagree for a moment is how a
   * count appears on a tile that the tab bar does not show. `status` is null
   * until the first answer, which `homeAreas` reads as "no mail items yet" —
   * so nothing flashes a mail heading that then disappears.
   */
  const { status, formsUsable, refresh } = useMail();

  const [openKey, setOpenKey] = useState(null);
  // null until the saved arrangement is known, so the tiles are not painted in
  // the default order and then visibly jump into the saved one.
  const [order, setOrder] = useState(null);
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [error, setError] = useState(null);
  const [announcement, setAnnouncement] = useState('');

  useHelpTopic('home');
  const brandName = useBranding();

  useEffect(() => {
    let cancelled = false;

    api
      .preferences()
      .then((result) => {
        if (!cancelled) setOrder(result.preferences?.[TILE_ORDER] ?? []);
      })
      .catch(() => {
        // The menu is how everything else is reached, so it renders in the
        // default order rather than not at all. Losing a saved arrangement for
        // one load is a far smaller failure than a home page that will not draw.
        if (!cancelled) setOrder([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The blocks to draw, in the fixed area order, each holding only what this
   * viewer may actually open. The rules about who sees «السجل» or «إنشاء كتاب»
   * live in the registry, so the menu cannot offer a screen the page would
   * refuse — a tile that promises a destination and silently goes elsewhere
   * teaches people the screen is broken, when the truth is it was never theirs.
   */
  const areas = homeAreas({ user, mail: status, formsUsable, order: order ?? [] });

  // The arrangeable list, and the only one a drag may reorder.
  const docsItems = areas.find((area) => area.key === 'docs')?.items ?? [];

  const persist = useCallback(
    async (keys) => {
      const previous = order;
      setOrder(keys);
      setError(null);

      try {
        await api.setPreference(TILE_ORDER, keys);
      } catch {
        // Put it back. A tile that stays where it was dropped and then reverts
        // on the next visit is worse than one that refuses in front of you.
        setOrder(previous);
        setError('تعذّر حفظ الترتيب الجديد، وأُعيد الترتيب السابق. تحقّق من الاتصال ثم أعد المحاولة.');
      }
    },
    [order],
  );

  const move = useCallback(
    (fromIndex, toIndex) => {
      if (fromIndex === toIndex || toIndex < 0 || toIndex >= docsItems.length) return;

      const label = docsItems[fromIndex].label;
      /*
       * Keys of the documents tiles only. `applyOrder` skips a name it does not
       * find and appends whatever the saved list never mentioned, so a list
       * that says nothing about الإدارة leaves it exactly where the registry
       * puts it — the stored format is unchanged, still a flat list of keys.
       */
      persist(reorder(docsItems, fromIndex, toIndex));
      // Announced, because for anyone moving a tile from the keyboard the only
      // other evidence it worked is a visual one they may not be using.
      setAnnouncement(`نُقلت ${label} إلى الموضع ${toIndex + 1} من ${docsItems.length}`);
    },
    [docsItems, persist],
  );

  const arranged = (order ?? []).length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text">{brandName}</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            كل قسم أدناه نوعٌ من العمل، ولا يظهر لك منها إلا ما يخصّك. يمكنك سحب بطاقات
            «الوثائق والأرشيف» لترتيبها، ويُحفظ الترتيب لحسابك.
          </p>
        </div>

        {/* The way out of an arrangement someone no longer wants, shown only
            once there is one to undo. */}
        {arranged ? (
          <button
            type="button"
            onClick={() => {
              persist([]);
              setAnnouncement('أُعيد الترتيب الافتراضي');
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface
              px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-primary/10
              hover:text-primary"
          >
            <RotateCcw size={14} />
            الترتيب الافتراضي
          </button>
        ) : null}
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="space-y-6">
        {areas.map((area) => {
          const AreaIcon = area.icon;
          const headingId = `area-${area.key}`;
          // Only the documents block arranges, so only it carries the drag and
          // Ctrl+Arrow wiring.
          const arrangeable = area.kind === 'tiles' && area.key === 'docs';
          const open = area.items.find((item) => item.key === openKey) ?? null;

          return (
            <section
              key={area.key}
              aria-labelledby={headingId}
              className="rounded-lg border border-border bg-surface p-5"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2">
                  <AreaIcon aria-hidden="true" className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h2 id={headingId} className="text-base font-semibold text-text">
                    {area.label}
                  </h2>
                  <p className="mt-0.5 text-xs leading-snug text-text-muted">{area.hint}</p>
                </div>
              </div>

              <div className="my-4 h-px bg-border" />

              {/* The status request failed: say so instead of letting the
                  section look complete, or vanish, on a network hiccup. */}
              {area.failed ? (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded border border-border
                  bg-surface-muted px-3 py-2 text-xs text-text-muted"
                >
                  <span>تعذّر تحميل شاشات الوارد والصادر الخاصة بك، فقد لا يظهر هنا كل ما يخصّك.</span>
                  <button
                    type="button"
                    onClick={() => refresh()}
                    className="font-medium text-primary transition-colors hover:underline"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {area.items.map((item, index) => {
                  /*
                   * A mail item is a screen, not a module: it has nowhere to
                   * expand to and pressing it goes straight there. A documents
                   * or administration module with two screens or more expands,
                   * because a panel over a single link is a click that buys
                   * nothing.
                   */
                  const expandable =
                    area.kind === 'tiles' && visibleTabs(item, status ?? {}).length >= 2;

                  return (
                    <ModuleTile
                      key={item.key}
                      module={item}
                      index={index}
                      total={area.items.length}
                      isActive={openKey === item.key}
                      // How many letters wait on this person's departments.
                      // On «الوارد إليّ» itself now, rather than on a module
                      // tile that no longer exists — the menu says "something
                      // is for you" on the very button that opens it.
                      badge={item.key === 'queue' ? status?.queueCount : null}
                      expandable={expandable}
                      arrangeable={arrangeable}
                      isDragging={dragKey === item.key}
                      isOver={overKey === item.key && dragKey !== item.key}
                      onSelect={() => {
                        if (!expandable) {
                          navigate(item.to);
                          return;
                        }
                        setOpenKey((current) => (current === item.key ? null : item.key));
                      }}
                      onDragStart={() => setDragKey(item.key)}
                      onDragEnter={() => setOverKey(item.key)}
                      onDragEnd={() => {
                        setDragKey(null);
                        setOverKey(null);
                      }}
                      onDrop={() => {
                        const fromIndex = docsItems.findIndex((entry) => entry.key === dragKey);
                        setDragKey(null);
                        setOverKey(null);
                        if (fromIndex !== -1) move(fromIndex, index);
                      }}
                      onMove={(delta) => move(index, index + delta)}
                    />
                  );
                })}
              </div>

              {/* Inside its own section, directly under the tiles it belongs
                  to: a panel that opened at the foot of the page would leave
                  the reader guessing which heading it answered to. */}
              {open ? (
                <div className="mt-4">
                  <ModulePanel
                    module={open}
                    tabs={visibleTabs(open, status ?? {})}
                    onClose={() => setOpenKey(null)}
                  />
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ModuleTile({
  module,
  index,
  total,
  isActive,
  badge,
  expandable,
  // Documents tiles are arranged by the person using them. Everything else —
  // the mail steps, الإدارة — is a fixed target: no drag, no grip, no
  // Ctrl+Arrow, and no aria-label promising a move that will not happen.
  arrangeable = true,
  isDragging,
  isOver,
  onSelect,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
  onMove,
}) {
  const Icon = module.icon;

  return (
    <button
      type="button"
      draggable={arrangeable}
      onClick={onSelect}
      onDragStart={
        arrangeable
          ? (event) => {
            // Required by Firefox, which starts no drag without data on the
            // transfer.
            event.dataTransfer.setData('text/plain', module.key);
            event.dataTransfer.effectAllowed = 'move';
            onDragStart();
          }
          : undefined
      }
      onDragOver={
        arrangeable
          ? (event) => {
            // Without this the drop never fires: preventDefault is what marks
            // an element as a valid target.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
          : undefined
      }
      onDragEnter={arrangeable ? onDragEnter : undefined}
      onDragEnd={arrangeable ? onDragEnd : undefined}
      onDrop={
        arrangeable
          ? (event) => {
            event.preventDefault();
            onDrop();
          }
          : undefined
      }
      onKeyDown={
        arrangeable
          ? (event) => {
            if (!event.ctrlKey) return;
            /*
             * RTL: the row runs right to left, so ArrowLeft advances and
             * ArrowRight goes back — the opposite of the physical key names,
             * and the right behaviour, because what someone means by "move it
             * left" is where they see it go, not what the key is called.
             */
            const rtl = document.dir !== 'ltr';
            const delta =
              event.key === 'ArrowLeft' ? (rtl ? 1 : -1)
                : event.key === 'ArrowRight' ? (rtl ? -1 : 1)
                  : 0;
            if (delta === 0) return;

            event.preventDefault();
            onMove(delta);
          }
          : undefined
      }
      aria-expanded={expandable ? isActive : undefined}
      aria-label={
        arrangeable
          ? `${module.label} — الموضع ${index + 1} من ${total}. اضغط Ctrl مع الأسهم لنقلها.`
          // The description is hidden below the largest tiles, so it is spoken
          // here instead: for a mail step it is the whole explanation of which
          // letter the button is for.
          : module.description ? `${module.label} — ${module.description}` : module.label
      }
      className={`group relative flex min-h-[120px] flex-col items-center justify-center
        rounded-lg p-4 transition-all duration-300 hover:scale-105 focus:outline-none focus:ring-2
        focus:ring-primary focus:ring-offset-2 sm:min-h-[140px] sm:p-6 ${
          arrangeable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
        } ${isDragging ? 'opacity-40' : ''} ${
          isOver
            ? 'border-2 border-dashed border-primary bg-primary/5'
            : isActive
              ? 'border-2 border-primary/30 bg-primary/10 shadow-md'
              : 'border-2 border-transparent hover:bg-surface-muted/50'
        }`}
    >
      {isActive ? (
        <div className="absolute top-1 start-1">
          <ChevronUp className="h-4 w-4 animate-pulse text-primary" />
        </div>
      ) : null}

      {/* The handle is a hint, not a target: the whole tile drags, because a
          small grip is a small thing to hit and there is nothing else here that
          a drag could plausibly have meant. It is absent where nothing moves,
          rather than shown and inert. */}
      {arrangeable ? (
        <GripVertical
          aria-hidden="true"
          className="absolute top-1.5 end-1.5 h-3.5 w-3.5 text-text-muted opacity-0
            transition-opacity group-hover:opacity-60"
        />
      ) : null}

      <div
        className={`relative mb-3 rounded-lg bg-primary p-4 shadow-lg transition-all group-hover:shadow-xl ${
          isActive ? 'ring-2 ring-primary/50 ring-offset-2' : ''
        }`}
      >
        <Icon className="h-8 w-8 text-on-primary sm:h-10 sm:w-10" />
        {badge ? (
          <span
            className="num absolute -top-2 -start-2 flex h-5 min-w-5 items-center justify-center
              rounded-full bg-red-600 px-1 text-[11px] font-bold text-white shadow"
            aria-label={`${badge} بانتظارك`}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </div>

      <span className="text-center text-sm font-semibold text-text sm:text-base">
        {module.label}
      </span>

      {/* Hidden on the smallest tiles, where it would crowd the name out. */}
      <span className="mt-1 hidden text-center text-[11px] leading-snug text-text-muted lg:block">
        {module.description}
      </span>
    </button>
  );
}

function ModulePanel({ module, tabs, badges = {}, onClose }) {
  const navigate = useNavigate();
  const Icon = module.icon;

  /*
   * Some screens inside a module belong to the other area: الإدارة configures
   * the mail room as well as the archive. Those tabs are banded off under the
   * area's own name, taken from the registry so the band and the area cannot
   * come to say different words, rather than sitting in one list where
   * «نماذج الكتب» reads like another archive setting.
   */
  const plain = tabs.filter((tab) => !tab.group);
  const groups = [...new Set(tabs.map((tab) => tab.group).filter(Boolean))];

  return (
    <div className="animate-slide-down rounded-lg border-2 border-primary/20 bg-primary/5 p-6">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary p-2">
            <Icon className="h-5 w-5 text-on-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text">{module.label}</h3>
            <p className="text-xs text-text-muted">{module.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/*
            The module itself, not one of its screens. Without this the tile
            expands and the module becomes unreachable from its own tile — you
            could open every tab of الإدارة and never الإدارة.
          */}
          <button
            type="button"
            onClick={() => navigate(module.to)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3
              py-1.5 text-xs text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            فتح {module.label}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="إغلاق"
            aria-label="إغلاق"
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {plain.length > 0 ? (
        <TabBand
          title={module.subgroup ?? module.label}
          tabs={plain}
          moduleTo={module.to}
          badges={badges}
        />
      ) : null}

      {groups.map((group) => (
        <TabBand
          key={group}
          // The band says «الوارد والصادر» because that is what the area is
          // called everywhere else in the menu.
          title={AREAS.find((area) => area.key === group)?.label ?? group}
          tabs={tabs.filter((tab) => tab.group === group)}
          moduleTo={module.to}
          badges={badges}
          spaced={plain.length > 0}
        />
      ))}
    </div>
  );
}

/** One labelled band of sub-screens: the label, its rule, then the tiles. */
function TabBand({ title, tabs, moduleTo, badges = {}, spaced = false }) {
  return (
    <div className={spaced ? 'mt-6' : ''}>
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {title}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {tabs.map((tab) => (
          <SubItemTile
            key={tab.key}
            tab={tab}
            badge={badges[tab.key] ?? null}
            // The tab is carried in the URL so the tile lands on the screen it
            // names, and so that screen can be linked to and bookmarked at all.
            to={`${moduleTo}?tab=${tab.key}`}
          />
        ))}
      </div>
    </div>
  );
}

function SubItemTile({ tab, to, badge = null }) {
  const navigate = useNavigate();
  const Icon = tab.icon;

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        onClick={() => navigate(to)}
        className="flex flex-1 items-center gap-3 rounded-sm border border-border bg-surface px-4
          py-3 transition-all duration-200 hover:border-primary/50 hover:shadow-md
          focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1
          rtl:hover:-translate-x-1 ltr:hover:translate-x-1"
      >
        <div className="rounded-sm bg-primary p-2 shadow transition-shadow group-hover:shadow-md">
          <Icon className="h-4 w-4 text-on-primary" />
        </div>
        <span className="text-sm font-medium text-text">{tab.label}</span>
        {badge ? (
          <span
            className="num flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600
              px-1 text-[11px] font-bold text-white"
            aria-label={`${badge} بانتظارك`}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </button>

      {/*
        A real link, not a button: opening a screen in a second tab is how an
        administrator compares two of them, and only an anchor gives the browser
        its own "open in new tab" behaviour for free.
      */}
      <a
        href={to}
        target="_blank"
        rel="noreferrer"
        title="فتح في تبويب جديد"
        aria-label={`فتح ${tab.label} في تبويب جديد`}
        onClick={(event) => event.stopPropagation()}
        className="absolute end-2 rounded border border-border bg-surface-muted p-1.5 text-text-muted
          opacity-0 transition-all hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
      >
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
