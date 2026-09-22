'use client';

import { useState } from 'react';

export function ClarifyForm({ runId, question }: { runId: string; question: string }) {
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/clarify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'The answer was not accepted.');
        return;
      }
      window.location.reload();
    } catch {
      setError('The server did not respond. Nothing changed, so try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="error">
      <b>This run is waiting on you.</b>
      <p className="small" style={{ margin: '6px 0 10px' }}>{question}</p>

      <form onSubmit={submit}>
        {error && <p className="small" style={{ margin: '0 0 8px' }}>{error}</p>}
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          aria-label="Your answer"
          placeholder="United States only, and business to business software specifically."
          style={{ minHeight: 70 }}
        />
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={busy || answer.trim().length < 2}>
            {busy ? 'Restarting the run' : 'Answer and restart the run'}
          </button>
        </div>
      </form>

      <p className="small muted" style={{ margin: '10px 0 0' }}>
        Nothing has been spent yet. Your answer is added to the objective and the run starts
        again from the beginning.
      </p>
    </div>
  );
}
