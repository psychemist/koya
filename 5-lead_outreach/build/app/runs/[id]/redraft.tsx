'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Ask for the copy to be written again.
 *
 * Offered only where it can do something: a qualified lead whose drafts are
 * blocked, either because the gates rejected two attempts or because a
 * reviewer promoted it after the run and the agent never wrote any. Before
 * this the page stated the block and offered no way out of it except
 * re-running the whole agent for a company already qualified and researched.
 *
 * The button says it spends money, because it does.
 */
export function Redraft({ leadId }: { leadId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/drafts`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'That did not work.'); return; }
      router.refresh();
    } catch {
      setError('The server did not respond. Nothing was written, so try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button className="quiet" onClick={go} disabled={busy}>
        {busy ? 'Writing the copy' : 'Write the copy again'}
      </button>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        This asks the model for a fresh attempt and checks it against the same gates. It
        costs a few cents and counts against the daily budget.
      </p>
      {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
