'use client';

import { useState } from 'react';
import { ConfirmButton } from './confirm.tsx';

/**
 * Move to in progress, and Close. Close asks first, naming the consequence
 * (spec §9); a move that lost a race says so and shows the status it lost to.
 */
export function StatusActions({ kind, id, reference, status }: { kind: 'escalations' | 'tickets'; id: string; reference: string; status: string }) {
  const [current, setCurrent] = useState(status);
  const [error, setError] = useState('');

  async function move(to: string): Promise<string | null> {
    setError('');
    const res = await fetch(`/api/${kind}/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: current, to }) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 409 && j.status) { setCurrent(j.status); return j.error; }
    if (!res.ok) return j.error ?? 'The status did not change.';
    setCurrent(j.status);
    return null;
  }

  if (current === 'closed') return <span className="rp-tag">Closed</span>;
  return (
    <div className="rp-row rp-actions">
      {current === 'open' && (
        <button type="button" className="rp-btn rp-btn-quiet rp-btn-small" onClick={async () => { const e = await move('in_progress'); if (e) setError(e); }}>
          Move to in progress
        </button>
      )}
      <ConfirmButton label="Close" className="rp-btn rp-btn-quiet rp-btn-small" title={`Close ${reference}?`}
        body={`Closing ${reference} marks it resolved and removes it from the open queue. The customer is not notified.`}
        confirmLabel={`Close ${reference}`} cancelLabel="Keep it open" onConfirm={() => move('closed')} />
      {error && <span className="rp-status" data-tone="bad" role="alert">{error}</span>}
    </div>
  );
}
