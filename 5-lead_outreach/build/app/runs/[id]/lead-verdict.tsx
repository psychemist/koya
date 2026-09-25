'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { useHumanMark } from './lead-card';

/**
 * The reviewer's verdict on the agent's verdict.
 *
 * The route for this existed from the start and nothing on the page called
 * it, so the one review action the spec names could not be taken. A note is
 * offered with a rejection because "no" without a reason teaches the next run
 * nothing.
 */
export function LeadVerdict({ leadId, humanNote }: {
  leadId: string; humanNote: string | null;
}) {
  // Shared with the card, because the left edge answers this button.
  const { status, setStatus } = useHumanMark();
  const [note, setNote] = useState(humanNote ?? '');
  const [open, setOpen] = useState(false);
  // Which verdict is in flight, not merely that one is: every control goes
  // dead while a decision saves, and the one that was clicked says so.
  const [busy, setBusy] = useState<'accepted' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function mark(next: 'accepted' | 'rejected', withNote?: string) {
    setBusy(next);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ human_status: next, human_note: withNote || undefined }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'That did not save.');
        return;
      }
      setStatus(next);
      setOpen(false);
      // A decision that moves the verdict also moves the chip, the card edge
      // and which tab the lead belongs in, none of which this component owns.
      const outcome = await res.json().catch(() => ({}));
      if (outcome.promoted || outcome.demoted) router.refresh();
    } catch {
      setError('The server did not respond.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
      <div className="col-label" style={{ marginBottom: 6 }}>Your verdict</div>

      {error && <p className="small state-failed" style={{ margin: '0 0 6px' }}>{error}</p>}

      {status ? (
        <>
          <p className="small" style={{ margin: '0 0 6px' }}>
            You marked this <b>{status}</b>.
            {note && <> {note}</>}
          </p>
          <button className="quiet" onClick={() => setStatus(null)} disabled={busy !== null}>
            Change it
          </button>
        </>
      ) : open ? (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Why you are rejecting this lead"
            placeholder="Wrong size, and the site says they sell to consumers."
            style={{ minHeight: 60 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="quiet" onClick={() => mark('rejected', note)}
                    disabled={busy !== null}>
              {busy === 'rejected' ? 'Saving the rejection' : 'Reject with this note'}
            </button>
            <button className="quiet" onClick={() => setOpen(false)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="quiet" onClick={() => mark('accepted')} disabled={busy !== null}>
            {busy === 'accepted' ? 'Saving' : 'Accept'}
          </button>
          <button className="quiet" onClick={() => setOpen(true)} disabled={busy !== null}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
