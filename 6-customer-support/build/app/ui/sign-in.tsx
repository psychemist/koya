'use client';

import { useState } from 'react';

export function SignIn({ next }: { next?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? 'Sign in did not work.'); return; }
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/console';
    } catch { setError('The server did not respond. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <form className="rp-form" onSubmit={submit}>
      {error && <p className="rp-status" data-tone="bad" role="alert">{error}</p>}
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit" className="rp-btn" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
    </form>
  );
}
