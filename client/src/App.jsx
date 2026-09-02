import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  FileText,
  LayoutGrid,
  LogOut,
  KeyRound,
} from 'lucide-react';

import { useAuth } from './auth.jsx';
import { moduleForPath } from './navigation.js';
import { useBranding } from './branding.js';
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
      <HelpProvider>
        <Shell />
      </HelpProvider>
    </TreeProvider>
  );
}

function Shell() {
  const { user, signOut } = useAuth();
  const brandName = useBranding();
  const location = useLocation();
  const navigate = useNavigate();

  // The modules themselves live in the tile menu now; the shell only needs to
  // know which one is open so the breadcrumb can say so.
  const active = moduleForPath(location.pathname, user);

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
              <button
                onClick={signOut}
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

        <div className="border-b border-border bg-surface px-6 py-2 text-sm text-text-muted">
          <Link to="/" className="transition-colors hover:text-primary">
            {brandName}
          </Link>
          {active ? <span> &gt; {active.label}</span> : null}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* The tree is first in DOM order, so RTL puts it on the right — the
              side an Arabic reader starts from. */}
          {/* The divider lives on main's inline-start, which RTL places between
              the two panels without a second border to keep in sync. */}
          <aside className="hidden w-64 shrink-0 overflow-y-auto bg-surface p-3 lg:block">
            <FolderTree />
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
