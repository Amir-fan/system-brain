import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../i18n';
import { SESSION_NOTICE_KEY } from '../api/session';

export function LoginPage() {
  const { signIn } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A prior request may have ended the session (expired and unrecoverable):
  // show why the user is back here, then clear the one-shot notice.
  useEffect(() => {
    try {
      const notice = localStorage.getItem(SESSION_NOTICE_KEY);
      if (notice) {
        setError(notice);
        localStorage.removeItem(SESSION_NOTICE_KEY);
      }
    } catch {
      /* storage unavailable — nothing to show */
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.invalid'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl2 border border-surface-line bg-surface-card p-8 shadow-card">
        <h1 className="text-xl font-bold text-slate-900">{t('login.title')}</h1>
        <p className="mt-1 text-sm text-muted-soft">{t('login.subtitle')}</p>
        {error ? <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p> : null}
        <label className="mt-5 block text-sm font-medium text-slate-700">{t('login.email')}</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
        />
        <label className="mt-4 block text-sm font-medium text-slate-700">{t('login.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? t('login.signingIn') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}