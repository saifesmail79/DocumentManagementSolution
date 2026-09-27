import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogIn, FileText } from 'lucide-react';
import { useBranding } from '../branding.js';

import { useAuth } from '../auth.jsx';
import { api, ApiError } from '../api.js';
import { signInLanding, MOST_PERMISSIVE_STATUS } from '../navigation.js';
import { Button, TextField, Card, Alert } from '../components/ui.jsx';

/**
 * The server returns one indistinguishable failure for a wrong password, an
 * unknown username and a disabled account. This screen must not undo that by
 * guessing at a friendlier explanation — one message covers all three.
 */
/**
 * How long the landing decision may hold the sign-in. The status request is a
 * convenience; a person with valid credentials must not sit on the form
 * because a table is locked or a connection stalled. Past this, they land on
 * the menu as if the module were off.
 */
const LANDING_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('landing timed out')), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

const MESSAGES = {
  invalid_credentials: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  account_locked: 'تم قفل الحساب مؤقتاً بعد عدة محاولات فاشلة.',
};

export default function Login() {
  const brandName = useBranding();
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      /*
       * The landing page is chosen here, before the shell renders, so the
       * reader never sees the tile menu paint and then jump. The rule itself
       * lives in navigation.js beside the other shared rules; this only asks
       * it, and skips the status request when no answer could move anyone —
       * an administrator, a forced password change, or a page that was asked
       * for by its own URL.
       *
       * Pushed, not replaced: the entry beneath the landing is the menu, so
       * the shell's رجوع leads there. Replacing would inherit the history
       * index of whoever used this browser before, and رجوع would walk into
       * their pages.
       */
      const { pathname } = location;
      await signIn(username, password, {
        before: async (user) => {
          if (!signInLanding({ user, pathname, status: MOST_PERMISSIVE_STATUS })) return;
          const status = await withTimeout(api.correspondence.status(), LANDING_TIMEOUT_MS);
          const target = signInLanding({ user, pathname, status });
          if (target) navigate(target);
        },
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        const lockedUntil = caught.body?.lockedUntil;
        setError(
          caught.code === 'account_locked' && lockedUntil
            ? `${MESSAGES.account_locked} حاول مرة أخرى بعد قليل.`
            : (MESSAGES[caught.code] ?? 'تعذر تسجيل الدخول. حاول مرة أخرى.'),
        );
      } else {
        setError('تعذر الاتصال بالخادم.');
      }
      /*
       * Re-enabled on failure only. After success the form stays disabled
       * until the shell replaces it: the user commit is a transition, so an
       * ordinary update here would render first and show a live button for
       * an instant, and a second Enter in that instant would start a second
       * sign-in.
       */
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <Card className="w-full max-w-sm p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="rounded-xl bg-primary/10 p-3">
            <FileText size={24} className="text-primary" />
          </div>
          <h1 className="text-lg font-semibold text-text">{brandName}</h1>
          <p className="text-xs text-text-muted">سجّل الدخول للمتابعة</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <TextField
            label="اسم المستخدم"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            dir="ltr"
            required
            autoFocus
          />
          <TextField
            label="كلمة المرور"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            dir="ltr"
            required
          />

          {error ? <Alert tone="error">{error}</Alert> : null}

          <Button type="submit" icon={LogIn} className="w-full justify-center" disabled={busy}>
            {busy ? 'جارٍ الدخول…' : 'دخول'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
