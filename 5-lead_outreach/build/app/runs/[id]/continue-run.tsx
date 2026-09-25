'use client';

import { useState } from 'react';

/**
 * Continue a run that fell short.
 *
 * Offered only on a finished run that settled on criteria, because those are
 * the two things a continuation carries forward. The child keeps the ICP and
 * the candidates this run discovered and never reached, and starts with its
 * own budgets.
 */
export function ContinueRun({ runId, qualified, target }: {
  runId: string; qualified: number; target: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/continue`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'That could not be queued.'); return; }
      window.location.href = `/runs/${body.id}`;
    } catch {
      setError('The server did not respond. Nothing was queued, so try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="quiet" onClick={go} disabled={busy}>
        {busy ? 'Queueing' : `Keep looking for ${Math.max(0, target - qualified)} more`}
      </button>
      {error && <p className="small state-failed" style={{ margin: '8px 0 0' }}>{error}</p>}
    </>
  );
}
