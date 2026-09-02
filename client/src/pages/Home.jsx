/**
 * The tile menu, per docs/UI_UX_AGENT_STANDARDS.md section 3.
 *
 * ─── Why the modules are tiles and no longer a row of links ─────────────────
 *
 * The header carried four small text links, which is the densest possible way to
 * present a choice and the least informative: four words, no room to say what
 * any of them holds, and no way to reach a screen inside a module without first
 * entering it and hunting for a tab. The standard calls for tiles because a
 * module deserves a target you can describe, and because the space a tile buys
 * is what lets a module show its own contents.
 *
 * ─── What a tile does when it is pressed ────────────────────────────────────
 *
 * A module that is a single destination — البحث, المحذوفات, المجلدات — opens on
 * the first press. Asking for a second press to reveal a panel containing one
 * link would be ceremony.
 *
 * A module that contains several screens expands instead, and its panel links
 * straight into each of them. That is the part the header row could not do at
 * all: reaching سجل التدقيق used to mean opening الإدارة and then finding the
 * eleventh tab, and there was no way to say beforehand that it existed.
 *
 * ─── Rearranging, and where the arrangement lives ───────────────────────────
 *
 * Tiles can be dragged into whatever order suits the person using them, and that
 * order is saved against their account rather than their browser — see the note
 * in migration 0015. Someone who arranges the menu on the workstation in the
 * records room finds the same arrangement on their own machine, which is the
 * only reading of "remember this" that is not a small lie.
 *
 * Dragging is not the only way to do it. A tile can also be moved with
 * Ctrl+Arrow while focused, because a drag is unavailable to anyone working from
 * the keyboard and a feature that is mouse-only is a feature some people simply
 * do not have.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronUp, ExternalLink, GripVertical, RotateCcw, X } from 'lucide-react';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { applyOrder, reorder, visibleModules } from '../navigation.js';
import { useHelpTopic } from '../help/HelpContext.jsx';
import { useBranding } from '../branding.js';
import { Alert } from '../components/ui.jsx';

const TILE_ORDER = 'home.tileOrder';

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();

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

  const modules = applyOrder(visibleModules(user), order ?? []);

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
      if (fromIndex === toIndex || toIndex < 0 || toIndex >= modules.length) return;

      const label = modules[fromIndex].label;
      persist(reorder(modules, fromIndex, toIndex));
      // Announced, because for anyone moving a tile from the keyboard the only
      // other evidence it worked is a visual one they may not be using.
      setAnnouncement(`نُقلت ${label} إلى الموضع ${toIndex + 1} من ${modules.length}`);
    },
    [modules, persist],
  );

  const arranged = (order ?? []).length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text">{brandName}</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            اختر ما تريد العمل عليه. الوحدات التي تحتوي أكثر من شاشة تُظهر شاشاتها عند اختيارها.
            يمكنك سحب البطاقات لترتيبها كما يناسبك، ويُحفظ الترتيب لحسابك.
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

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {modules.map((module, index) => (
          <ModuleTile
            key={module.key}
            module={module}
            index={index}
            total={modules.length}
            isActive={openKey === module.key}
            isDragging={dragKey === module.key}
            isOver={overKey === module.key && dragKey !== module.key}
            onSelect={() => {
              // A module with nothing to expand goes straight there: a panel
              // holding a single link is a click that buys nothing.
              if (!module.tabs?.length) {
                navigate(module.to);
                return;
              }
              setOpenKey((current) => (current === module.key ? null : module.key));
            }}
            onDragStart={() => setDragKey(module.key)}
            onDragEnter={() => setOverKey(module.key)}
            onDragEnd={() => {
              setDragKey(null);
              setOverKey(null);
            }}
            onDrop={() => {
              const fromIndex = modules.findIndex((entry) => entry.key === dragKey);
              setDragKey(null);
              setOverKey(null);
              if (fromIndex !== -1) move(fromIndex, index);
            }}
            onMove={(delta) => move(index, index + delta)}
          />
        ))}
      </div>

      {(() => {
        const open = modules.find((module) => module.key === openKey);
        return open ? <ModulePanel module={open} onClose={() => setOpenKey(null)} /> : null;
      })()}
    </div>
  );
}

function ModuleTile({
  module,
  index,
  total,
  isActive,
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
      draggable
      onClick={onSelect}
      onDragStart={(event) => {
        // Required by Firefox, which starts no drag without data on the transfer.
        event.dataTransfer.setData('text/plain', module.key);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(event) => {
        // Without this the drop never fires: preventDefault is what marks an
        // element as a valid target.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onKeyDown={(event) => {
        if (!event.ctrlKey) return;
        /*
         * RTL: the row runs right to left, so ArrowLeft advances and ArrowRight
         * goes back — the opposite of the physical key names, and the right
         * behaviour, because what someone means by "move it left" is where they
         * see it go, not what the key is called.
         */
        const rtl = document.dir !== 'ltr';
        const delta =
          event.key === 'ArrowLeft' ? (rtl ? 1 : -1)
            : event.key === 'ArrowRight' ? (rtl ? -1 : 1)
              : 0;
        if (delta === 0) return;

        event.preventDefault();
        onMove(delta);
      }}
      aria-expanded={module.tabs?.length ? isActive : undefined}
      aria-label={`${module.label} — الموضع ${index + 1} من ${total}. اضغط Ctrl مع الأسهم لنقلها.`}
      className={`group relative flex min-h-[120px] cursor-grab flex-col items-center justify-center
        rounded-lg p-4 transition-all duration-300 hover:scale-105 focus:outline-none focus:ring-2
        focus:ring-primary focus:ring-offset-2 active:cursor-grabbing sm:min-h-[140px] sm:p-6 ${
          isDragging ? 'opacity-40' : ''
        } ${
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
          a drag could plausibly have meant. */}
      <GripVertical
        aria-hidden="true"
        className="absolute top-1.5 end-1.5 h-3.5 w-3.5 text-text-muted opacity-0
          transition-opacity group-hover:opacity-60"
      />

      <div
        className={`mb-3 rounded-lg bg-primary p-4 shadow-lg transition-all group-hover:shadow-xl ${
          isActive ? 'ring-2 ring-primary/50 ring-offset-2' : ''
        }`}
      >
        <Icon className="h-8 w-8 text-on-primary sm:h-10 sm:w-10" />
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

function ModulePanel({ module, onClose }) {
  const navigate = useNavigate();
  const Icon = module.icon;

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

      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {module.subgroup ?? module.label}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {module.tabs.map((tab) => (
          <SubItemTile
            key={tab.key}
            tab={tab}
            // The tab is carried in the URL so the tile lands on the screen it
            // names, and so that screen can be linked to and bookmarked at all.
            to={`${module.to}?tab=${tab.key}`}
          />
        ))}
      </div>
    </div>
  );
}

function SubItemTile({ tab, to }) {
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
