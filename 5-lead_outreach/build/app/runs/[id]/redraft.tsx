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
export function Redraft(
  { leadId, existingDrafts = 0, editedByHuman = 0 }:
  { leadId: string; existingDrafts?: number; editedByHuman?: number },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  /**
   * Asking again REPLACES what is there: draftForLead deletes every draft for
   * the lead before writing the new set. With no drafts that is free, which is
   * the case this button was built for. With drafts it destroys them, and a
   * draft a reviewer edited by hand is not something to lose to a stray click,
   * so that case asks first and names what goes.
   */
  const destructive = existingDrafts > 0;

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

  if (confirming) {
    return (
      <div style={{ marginTop: 10 }}>
        <p className="small" style={{ margin: '0 0 8px' }}>
          <b>
            This replaces {existingDrafts} draft{existingDrafts === 1 ? '' : 's'} for this
            company.
          </b>{' '}
          {editedByHuman > 0 && (
            <span className="state-degraded">
              {editedByHuman} of them {editedByHuman === 1 ? 'was' : 'were'} edited by hand,
              and {editedByHuman === 1 ? 'that edit' : 'those edits'} cannot be recovered.
            </span>
          )}{' '}
          The new copy is checked against the same gates, costs a few cents, and counts
          against the daily budget.
        </p>
        <button onClick={go} disabled={busy}>
          {busy ? 'Writing the copy' : 'Replace the drafts'}
        </button>{' '}
        <button className="quiet" onClick={() => setConfirming(false)} disabled={busy}>
          Keep what is there
        </button>
        {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button
        className="quiet"
        onClick={() => (destructive ? setConfirming(true) : go())}
        disabled={busy}
      >
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
