import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { FileText, LogOut, Search as SearchIcon, FolderTree, KeyRound } from 'lucide-react';

import { useAuth } from './auth.jsx';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Browse from './pages/Browse.jsx';
import Search from './pages/Search.jsx';

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

  return <Shell />;
}

function Shell() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const navigation = [
    { to: '/folders', label: 'المجلدات', icon: FolderTree },
    { to: '/search', label: 'البحث', icon: SearchIcon },
  ];

  const active = navigation.find((item) => location.pathname.startsWith(item.to));

  return (
    <div className="flex min-h-screen bg-surface-muted text-text">
      <div className="flex flex-1 flex-col">
        <header className="border-b border-border bg-surface shadow-sm">
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            {/* RIGHT SIDE in RTL: logo, app name, navigation */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-primary/10 p-1.5">
                  <FileText size={18} className="text-primary" />
                </div>
                <span className="text-sm font-semibold text-text">نظام إدارة الوثائق</span>
              </div>

              <nav className="flex items-center gap-1">
                {navigation.map((item) => {
                  const isActive = location.pathname.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                        isActive
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-text-muted hover:bg-surface-muted hover:text-text'
                      }`}
                    >
                      <item.icon size={15} />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </div>

            {/* LEFT SIDE in RTL: user identity and session actions */}
            <div className="flex items-center gap-3">
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
          نظام إدارة الوثائق {active ? <span> &gt; {active.label}</span> : null}
        </div>

        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route path="/" element={<Navigate to="/folders" replace />} />
            <Route path="/folders" element={<Browse />} />
            <Route path="/folders/:folderId" element={<Browse />} />
            <Route path="/search" element={<Search />} />
            <Route path="/password" element={<ChangePassword />} />
            <Route path="*" element={<Navigate to="/folders" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
