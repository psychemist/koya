'use client';
import { useState } from 'react';

/**
 * A form, so signing out is a POST.
 *
 * A link would be a GET, and a GET that ends a session fires on anything that
 * merely fetches the URL: a prefetch, a preview crawler, an image tag on
 * somebody else's page.
 *
 * The full page load afterwards is deliberate rather than a router push.
 * Every page here is server-rendered from the session cookie, so the whole
 * tree has to be fetched again with that cookie gone. A client-side
 * navigation would leave the previous person's name sitting in the masthead.
 */
export default function SignOut() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch('/api/logout', { method: 'POST' });
      if (!res.ok) throw new Error('logout failed');
      window.location.href = '/';
    } catch {
      // Saying nothing would be the worst outcome here: the person believes
      // they have signed out on a shared machine, and they have not.
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="contents">
      <button
        type="submit"
        disabled={busy}
        className="btn btn-ghost text-xs"
        title={failed ? 'The request did not reach the server. You are still signed in.' : undefined}
      >
        {busy ? 'Signing out' : failed ? 'Still signed in, retry' : 'Sign out'}
      </button>
    </form>
  );
}
