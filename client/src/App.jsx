import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  FileText,
  LayoutGrid,
  LogOut,
  KeyRound,
} from 'lucide-react';

import { useAuth } from './auth.jsx';
import { breadcrumbFor } from './navigation.js';
import { useBranding } from './branding.js';
import { MailProvider, useMail } from './MailContext.jsx';
import { TreeProvider } from './TreeContext.jsx';
import FolderTree from './components/FolderTree.jsx';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Browse from './pages/Browse.jsx';
import Search from './pages/Search.jsx';
import Admin from './pages/Admin.jsx';
import DocumentDetail from './pages/DocumentDetail.jsx';
import RecycleBin from './pages/RecycleBin.jsx';
import MyDocuments from './pages/MyDocuments.jsx';
import Correspondence from './pages/Correspondence.jsx';
import Forms from './pages/Forms.jsx';
import Home from './pages/Home.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import { HelpProvider } from './help/HelpContext.jsx';
import { HelpButton, HelpPanel } from './components/HelpPanel.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

/**
 * Application shell, per docs/UI_UX_AGENT_STANDARDS.md section 2:
 * header bar, breadcrumb strip, then the scrolling content area.
 */
export default function App() {
  const { user, loading } = useAuth();

  // Nothing renders until the session is known, so a returning user never sees a
  // flash of the login screen on refresh.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted">
        <Spinner label="جارٍ التحميل…" />
      </div>
    );
  }

  if (!user) return <Login />;

  // The server refuses every other route in this state, so the UI must not offer
  // one. Showing the shell with dead links would just produce 403s.
  if (user.mustChangePassword) return <ChangePassword forced />;

  return (
    <TreeProvider>
      {/*
        Inside the router, because it watches the path to know when the waiting
        count is worth asking for again — and above the shell, because the header,
        the breadcrumb, the folder tree and the folder page all need the same
        answer about this person and the mail room. Four requests that can
        disagree for a moment is how a badge comes to contradict a tab bar.
      */}
      <MailProvider>
        <HelpProvider>
          <Shell />
        </HelpProvider>
      </MailProvider>
    </TreeProvider>
  );
}

function Shell() {
  const { user, signOut } = useAuth();
  const brandName = useBranding();
  const location = useLocation();
  const navigate = useNavigate();
  const { status } = useMail();

  /*
   * Where the reader is: asked once, said three times — the chip in the header,
   * the trail beneath it, and the note above the folder tree.
   *
   * One answer rather than three, because three drift apart and the reader
   * cannot tell which one is lying: a chip reading «الوارد والصادر» above a trail
   * reading «الوثائق والأرشيف» is worse than neither of them.
   *
   * `capabilities` is the correspondence status, because that is what decides
   * which tab a mail screen actually opens on. Before the first answer it is an
   * empty object, so the trail names the area and the screen now and adds the
   * tab when the answer lands — never a tab this viewer cannot open.
   */
  const where = breadcrumbFor({
    pathname: location.pathname,
    search: location.search,
    user,
    capabilities: status ?? {},
  });
  const AreaIcon = where.area?.icon ?? null;

  return (
    <div className="flex h-screen bg-surface-muted text-text">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="border-b border-border bg-surface shadow-sm">
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            {/*
              RIGHT SIDE in RTL: the way back to the tile menu.

              The row of module links used to live here. With the modules now
              presented as tiles, what the header still owes the reader is a way
              back to them from inside any screen — so the name of the system is
              that way back, and says so.
            */}
            <div className="flex items-center gap-4">
              <Link
                to="/"
                title="القائمة الرئيسية"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors
                  hover:bg-surface-muted"
              >
                <div className="rounded-lg bg-primary/10 p-1.5">
                  <FileText size={18} className="text-primary" />
                </div>
                <span className="text-sm font-semibold text-text">{brandName}</span>
              </Link>

              {/* Shown only away from home, where it is the one thing to do. */}
              {location.pathname === '/' ? null : (
                <Link
                  to="/"
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface
                    px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-primary/10
                    hover:text-primary"
                >
                  <LayoutGrid size={15} />
                  القائمة الرئيسية
                </Link>
              )}

              {/*
                Which kind of work this screen belongs to, named where the eye
                already is. Not a link and not a control — it answers «where am
                I», and the way out is the button beside it.

                Every area wears the same chip. Telling them apart by colour
                would load a second meaning onto tokens that already mean
                pending or failed here, and would say nothing whatsoever to a
                reader who cannot separate the two colours. The icon and the
                name carry the difference.
              */}
              {where.area && AreaIcon ? (
                <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  <AreaIcon size={14} />
                  {where.area.label}
                </span>
              ) : null}
            </div>

            {/* LEFT SIDE in RTL: user identity and session actions */}
            <div className="flex items-center gap-3">
              {/* One button, every screen. What it explains follows whatever the
                  screen — or the tab inside it — has claimed. */}
              <HelpButton />
              <NotificationBell />
              <div className="text-left">
                <p className="text-sm font-medium text-text">{user.displayName || user.username}</p>
                {user.isSuperAdmin ? (
                  <p className="text-[11px] text-text-muted">مدير النظام</p>
                ) : null}
              </div>
              <button
                onClick={() => navigate('/password')}
                title="تغيير كلمة المرور"
                aria-label="تغيير كلمة المرور"
                className="rounded-lg border border-border bg-surface p-2 text-text-muted
                  transition-colors hover:bg-primary/10 hover:text-primary"
              >
                <KeyRound size={16} />
              </button>
              {/* Back to the root as well as out: shared machines sign in as
                  someone else next, and the new person should start at the
                  menu, not deep inside whatever page the last person left. */}
              <button
                onClick={() => {
                  navigate('/', { replace: true });
                  signOut();
                }}
                title="خروج"
                aria-label="خروج"
                className="rounded-lg border border-border bg-surface p-2 text-text-muted
                  transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </header>

        {/*
          The trail: the system, then the area, then the screen and its tab.

          Only the brand is a link. An area is not a page one can open, and the
          screen at the end of the trail is the one already on display — a link
          that leads where you already are teaches the reader that the trail does
          not work. The way back is the brand, and the button in the header.
        */}
        <div className="border-b border-border bg-surface px-6 py-2 text-sm text-text-muted">
          <Link to="/" className="transition-colors hover:text-primary">
            {brandName}
          </Link>
          {where.segments.map((segment, index) => (
            <span key={segment}>
              {' '}&gt;{' '}
              {/* The area's mark, on the first segment only: the same icon the
                  chip above and the home page heading carry, so the three read
                  as one place rather than three unrelated labels. */}
              {index === 0 && AreaIcon ? (
                <AreaIcon size={14} className="me-1 inline align-text-bottom" />
              ) : null}
              {segment}
            </span>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* The tree is first in DOM order, so RTL puts it on the right — the
              side an Arabic reader starts from. */}
          {/* The divider lives on main's inline-start, which RTL places between
              the two panels without a second border to keep in sync. */}
          {/* A column, so the note below can take the room it needs and the tree
              takes the rest — rather than the note pushing an equally tall tree
              past the bottom edge and putting a second scrollbar in a 16rem pane. */}
          <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto bg-surface p-3 lg:flex">
            {/*
              The tree stays on every screen, mail ones included: a letter's file
              is archived like any other document and is found here. What it is
              not is where a letter is registered or referred — so on a mail
              screen that is said once, in a line above the tree, rather than
              being learned by dragging a scan into a folder and waiting for a
              number that never arrives.
            */}
            {/* Only while the correspondence module is on: with it off, the
                screens this sentence points at do not exist. */}
            {where.area?.key === 'mail' && status?.enabled === true ? (
              <p className="mb-2 px-2 text-[11px] leading-snug text-text-muted">
                الشجرة للأرشيف؛ تسجيل الكتب وإحالتها من شاشات الوارد والصادر.
              </p>
            ) : null}
            {/* The letters folder is only marked in the tree, never moved out of
                it or hidden: it is a real folder with real documents in it, and
                hiding it would strand whatever is already filed there. */}
            <FolderTree mailFolderId={status?.enabled ? status.intakeFolderId : null} />
          </aside>

          <main className="min-w-0 flex-1 overflow-auto border-border p-6 lg:border-s">
            {/*
              Back, at the start of the working area — the top-right corner in
              RTL, which is where the eye lands first.

              `history.state.idx` is React Router's own position counter. It is
              0 when this page is the first thing this tab has shown, which is
              the case that matters: a link opened in a new tab, or a bookmarked
              document. Going "back" from there would leave the application
              entirely, so the menu is the destination instead — the button never
              takes anyone somewhere they did not come from.
            */}
            {location.pathname === '/' ? null : (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() =>
                    ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate('/'))}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface
                    px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-primary/10
                    hover:text-primary"
                >
                  {/* RTL: back points right, the direction the text comes from. */}
                  <ArrowRight size={15} />
                  رجوع
                </button>
              </div>
            )}

            {/*
              Around the routed page only, so a crash in one screen leaves the
              header, the navigation and the folder tree usable — and keyed on
              the path, so moving to another page clears an error belonging to
              the one just left.
            */}
            <ErrorBoundary resetKey={location.pathname}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/folders" element={<Browse />} />
              <Route path="/folders/:folderId" element={<Browse />} />
              <Route path="/documents/:documentId" element={<DocumentDetail />} />
              <Route path="/search" element={<Search />} />
              <Route path="/recycle-bin" element={<RecycleBin />} />
              <Route path="/my" element={<MyDocuments />} />
              <Route path="/correspondence" element={<Correspondence />} />
              <Route path="/forms" element={<Forms />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/password" element={<ChangePassword />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </ErrorBoundary>
          </main>
        </div>
      </div>

      {/* Last in the shell so it wins a z-index tie against anything the page
          itself floats — the row action ring, for one, also sits at z-50. */}
      <HelpPanel />
    </div>
  );
}
