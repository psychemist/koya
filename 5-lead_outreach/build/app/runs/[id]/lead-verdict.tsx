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
  /** Which note is being written: one attached to a rejection, or one on its
   *  own. The textarea and the save are shared; only the verdict differs. */
  const [open, setOpen] = useState<null | 'rejected' | 'note'>(null);
  // Which verdict is in flight, not merely that one is: every control goes
  // dead while a decision saves, and the one that was clicked says so.
  const [busy, setBusy] = useState<'accepted' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  /** `null` saves the note and leaves the verdict alone, which is what
   *  "leave it for review with a note" has to mean. */
  async function mark(next: 'accepted' | 'rejected' | null, withNote?: string) {
    setBusy(next ?? 'rejected');
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(next ? { human_status: next } : {}),
          human_note: withNote || undefined,
        }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'That did not save.');
        return;
      }
      if (next) setStatus(next);
      setOpen(null);
      // A decision that moves the verdict also moves the chip, the card edge
      // and which tab the lead belongs in, none of which this component owns.
      const outcome = await res.json().catch(() => ({}));
      // A note with no verdict changes nothing the card computed, but it does
      // change what Operator's notes has to show, and that is rendered on the
      // server.
      if (outcome.promoted || outcome.demoted || !next) router.refresh();
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

      {/* The note itself is not printed here. Wherever it came from, a
          rejection or a standalone note, it belongs in one place on the card,
          under Operator's notes, rather than in two depending on which button
          wrote it. */}
      {status ? (
        <>
          <p className="small" style={{ margin: '0 0 6px' }}>
            You marked this <b>{status}</b>.
          </p>
          {/* A note is not part of the verdict, so it stays available after
              one is cast. A reviewer who accepted a lead last week and has
              since learned something about it should not have to undo the
              decision to write that down. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="quiet" onClick={() => setStatus(null)} disabled={busy !== null}>
              Change it
            </button>
            <button className="quiet" onClick={() => setOpen('note')} disabled={busy !== null}>
              {humanNote ? 'Edit the note' : 'Leave a note'}
            </button>
          </div>
        </>
      ) : open ? (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={open === 'rejected'
              ? 'Why you are rejecting this lead' : 'Your note on this lead'}
            placeholder={open === 'rejected'
              ? 'Wrong size, and the site says they sell to consumers.'
              : 'Worth another look. Their careers page suggests they are bigger than this.'}
            style={{ minHeight: 60 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="quiet"
              onClick={() => mark(open === 'rejected' ? 'rejected' : null, note)}
              disabled={busy !== null}
            >
              {busy !== null ? 'Saving'
                : open === 'rejected' ? 'Reject with this note' : 'Save note'}
            </button>
            <button className="quiet" onClick={() => setOpen(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="quiet" onClick={() => mark('accepted')} disabled={busy !== null}>
            {busy === 'accepted' ? 'Saving' : 'Accept'}
          </button>
          <button className="quiet" onClick={() => setOpen('rejected')} disabled={busy !== null}>
            Reject
          </button>
          {/* Offered on every lead, and without a verdict attached. review.ts
              tells a reviewer to "leave it for review with a note" when a lead
              cannot be promoted, and until now there was no way to do that:
              the only route to a note was through a rejection. */}
          <button className="quiet" onClick={() => setOpen('note')} disabled={busy !== null}>
            Leave a note
          </button>
        </div>
      )}
    </div>
  );
}
