'use client';

import { useState } from 'react';
import { ConfirmButton } from './confirm.tsx';
import { Pill } from './pill.tsx';
import { PlayIcon } from './icons.tsx';

/**
 * Move to in progress, and Close. Close asks first, naming the consequence
 * (spec §9); a move that lost a race says so and shows the status it lost to.
 */
export function StatusActions({ kind, id, reference, status }: { kind: 'escalations' | 'tickets'; id: string; reference: string; status: string }) {
  const [current, setCurrent] = useState(status);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  if (current === 'closed') return <Pill value="closed" label="Closed" />;
  return (
    <div className="rp-actions">
      <Pill value={current} />
      <div className="rp-actions-btns">
        {current === 'open' && (
          <button type="button" className="rp-step" disabled={busy} title={`Mark ${reference} as being worked on`}
            onClick={async () => { setBusy(true); const e = await move('in_progress'); setBusy(false); if (e) setError(e); }}>
            <PlayIcon size={14} />{busy ? 'Starting' : 'Start work'}
          </button>
        )}
        <ConfirmButton label="Close" className="rp-step rp-step-quiet" title={`Close ${reference}?`}
          body={`Closing ${reference} marks it resolved and removes it from the open queue. The customer is not notified.`}
          confirmLabel={`Close ${reference}`} cancelLabel="Keep it open" onConfirm={() => move('closed')} />
      </div>
      {error && <span className="rp-status" data-tone="bad" role="alert">{error}</span>}
    </div>
  );
}
