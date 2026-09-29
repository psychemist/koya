'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Park a run, and let it go again.
 *
 * Nothing is lost by stopping. Every company discovered, every page read and
 * every verdict reached was written when it happened, so a paused run is the
 * same rows it had a second earlier. What resuming cannot restore is the
 * agent's train of thought: that lives in the worker and is not saved, so a
 * fresh session starts and reads the stored rows back. It pays to work out
 * where it got to, and re-discovers and re-judges nothing.
 *
 * The button says "stop starting new work" rather than "freeze", because that
 * is what it can honestly promise. A page already being fetched when the
 * button is pressed is paid for either way; what the pause guarantees is that
 * nothing further is bought.
 */
export function PauseRun({ runId, paused }: { runId: string; paused: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function set(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'That did not work.'); return; }
      router.refresh();
    } catch {
      setError('The server did not respond, so nothing changed.');
    } finally {
      setBusy(false);
    }
  }

  if (paused) {
    return (
      <div className="warning" style={{ marginBottom: 18 }}>
        <b>This run is paused.</b>
        <p className="small" style={{ margin: '6px 0 10px' }}>
          No worker will pick it up and nothing can be spent on it. Everything it had
          already found is on the page below and is kept. Resuming starts the agent again
          from what is stored, which costs a few cents to re-read and repeats no
          discovery, no page reads and no verdicts.
        </p>
        {error && (
          <p className="small state-bad" style={{ display: 'inline-block', margin: '0 0 8px' }}>
            {error}
          </p>
        )}
        <button onClick={() => set(false)} disabled={busy}>
          {busy ? 'Resuming the run' : 'Resume the run'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <button className="quiet" onClick={() => set(true)} disabled={busy}>
        {busy ? 'Pausing the run' : 'Pause this run'}
      </button>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Stops it starting any new work. Everything found so far is kept, and you can
        resume it later.
      </p>
      {error && <p className="small state-bad" style={{ margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
