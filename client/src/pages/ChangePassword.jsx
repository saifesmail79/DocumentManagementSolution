import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { passwordProblemMessages } from '../passwordProblems.js';

import { useAuth } from '../auth.jsx';
import { api, ApiError } from '../api.js';
import { Button, TextField, Card, Alert } from '../components/ui.jsx';

/**
 * Shown when the account is flagged must_change_password. The server refuses
 * every other route in that state, so this is not a suggestion the user can
 * navigate away from — presenting it as a full screen matches what the API does.
 */
export default function ChangePassword({ forced = false }) {
  const { refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setProblems([]);

    if (newPassword !== confirmation) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setDone(true);
      await refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'weak_password') {
        // The server sends the specific reasons; echoing them beats a generic
        // "password not strong enough" the user cannot act on.
        // Rendered from the codes, so the list reads in the language of the
        // form around it rather than in the server's.
        setProblems(passwordProblemMessages(caught.body ?? caught));
      } else if (caught instanceof ApiError && caught.code === 'invalid_credentials') {
        setError('كلمة المرور الحالية غير صحيحة.');
      } else {
        setError('تعذر تغيير كلمة المرور.');
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
            <KeyRound size={24} className="text-primary" />
          </div>
          <h1 className="text-lg font-semibold text-text">تغيير كلمة المرور</h1>
          {forced ? (
            <p className="text-xs text-text-muted">
              يجب تغيير كلمة المرور المؤقتة قبل استخدام النظام.
            </p>
          ) : null}
        </div>

        {done ? (
          <Alert tone="success">تم تغيير كلمة المرور، وأُنهيت الجلسات الأخرى.</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <TextField
              label="كلمة المرور الحالية"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              dir="ltr"
              required
            />
            <TextField
              label="كلمة المرور الجديدة"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              dir="ltr"
              required
            />
            <TextField
              label="تأكيد كلمة المرور"
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="new-password"
              dir="ltr"
              required
            />

            {problems.length > 0 ? (
              <Alert tone="error">
                <ul className="list-inside list-disc space-y-1">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {error ? <Alert tone="error">{error}</Alert> : null}

            <Button type="submit" className="w-full justify-center" disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
