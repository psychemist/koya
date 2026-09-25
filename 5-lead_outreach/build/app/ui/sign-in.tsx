'use client';

import { useState } from 'react';

export function SignIn({ next }: { next?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Sign in did not work.');
        return;
      }
      window.location.href = next && next.startsWith('/') ? next : '/';
    } catch {
      setError('The server did not respond. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap narrow">
      <h1>Koya Talent Lead Desk</h1>
      <p className="muted">
        Research and qualify companies, then review the drafts. Nothing is sent.
      </p>

      <hr className="rule" />

      <form onSubmit={submit}>
        {error && <div className="error">{error}</div>}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        <button type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
      </form>

      <p className="small muted" style={{ marginTop: 20 }}>
        Runs spend against a shared research account, so starting one needs an account of
        your own.
      </p>
    </main>
  );
}
