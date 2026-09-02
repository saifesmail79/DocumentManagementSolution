import { useState } from 'react';
import { LogIn, FileText } from 'lucide-react';
import { useBranding } from '../branding.js';

import { useAuth } from '../auth.jsx';
import { ApiError } from '../api.js';
import { Button, TextField, Card, Alert } from '../components/ui.jsx';

/**
 * The server returns one indistinguishable failure for a wrong password, an
 * unknown username and a disabled account. This screen must not undo that by
 * guessing at a friendlier explanation — one message covers all three.
 */
const MESSAGES = {
  invalid_credentials: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  account_locked: 'تم قفل الحساب مؤقتاً بعد عدة محاولات فاشلة.',
};

export default function Login() {
  const brandName = useBranding();
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
      await signIn(username, password);
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
    } finally {
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
