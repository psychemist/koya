'use client';
import { useEffect, useState } from 'react';

/**
 * A real <form>, not two inputs sitting beside a button.
 *
 * The previous version wired the submit handler to the button's onClick, so
 * pressing Enter in the password field did nothing whatsoever. That is the
 * single most common way anybody signs in, and it failed silently.
 *
 * The credentials are never persisted anywhere on the client. The email
 * survives a failed attempt because retyping it is pure friction; the
 * password is cleared, because a wrong one is the thing being corrected.
 */
const FILL_EVENT = 'koya:fill-credentials';

export default function ClientLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The demo buttons live in a server component several levels up, so they
   * cannot reach this state directly. A custom event carries it.
   *
   * Writing the values straight into the DOM inputs, which is the obvious
   * shortcut, does not work here: these are controlled inputs, so React
   * overwrites them on the next render and the form submits two empty strings
   * while showing the reviewer a filled-in screen.
   */
  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ email: string; password: string }>).detail;
      if (!d) return;
      setEmail(d.email);
      setPassword(d.password);
      setError(null);
    };
    window.addEventListener(FILL_EVENT, onFill);
    return () => window.removeEventListener(FILL_EVENT, onFill);
  }, []);

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
      if (res.ok) {
        // A full reload, so the server components re-render with the session
        // cookie this response just set.
        location.reload();
        return;
      }
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? 'That email and password do not match.');
      setPassword('');
    } catch {
      // A network failure is not a wrong password, and saying so saves
      // someone retyping a password that was right all along.
      setError('The sign-in request did not reach the server. Check the connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <div>
        <label htmlFor="email" className="label">Email</label>
        <input
          id="email" name="email" type="email" autoComplete="username" required
          autoCapitalize="off" spellCheck={false}
          className="field" value={email} onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="password" className="label">Password</label>
        <input
          id="password" name="password" type="password" autoComplete="current-password" required
          className="field" value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && <p role="alert" className="text-sm text-blocking">{error}</p>}

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !email || !password}>
        {busy ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}

/**
 * Fills the form rather than signing in directly.
 *
 * One click short of signed in is the right amount of friction: the reviewer
 * sees which account they are about to use, which matters on a screen whose
 * whole point is that the two accounts are not interchangeable.
 */
export function Fill({
  email, password, label, note,
}: { email: string; password: string; label: string; note?: string }) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-sunk"
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent(FILL_EVENT, { detail: { email, password } }),
        );
        document.getElementById('password')?.focus();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold">{label}</span>
        {note && <span className="block text-xs text-muted">{note}</span>}
      </span>
      <span className="ident shrink-0 pt-0.5">{email}</span>
    </button>
  );
}
