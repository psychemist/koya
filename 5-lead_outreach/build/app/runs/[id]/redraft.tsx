'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Ask for the copy this lead already has to be written again.
 *
 * The last of the three things a reviewer can do with copy: ask for the
 * messages they want, rewrite one that reads badly, or throw the lot out and
 * start over.
 *
 * "The whole copy" means the messages that exist, not the full four. A lead
 * holding a LinkedIn message and one email gets those two written again and
 * does not quietly acquire two more emails nobody asked for. That was this
 * button's old behaviour, and it is the reason drafting moved onto buttons in
 * the first place.
 *
 * Offered only once there is something to replace. With nothing written the
 * question is which messages to write, which is what Write the outreach asks.
 *
 * The button says it spends money, because it does.
 */
/** Matches CONTEXT_MAX_CHARS in lib/drafting.ts, where it is enforced. This is
 *  the courtesy of saying so before the trim happens, not the rule. */
const NOTE_MAX = 500;

export function Redraft(
  { leadId, steps, editedByHuman = 0 }:
  { leadId: string; steps: number[]; editedByHuman?: number },
) {
  const existingDrafts = steps.length;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
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
      // Named steps, not a bare request. Sending none means "write the whole
      // sequence", which hands four messages back to a lead that has two.
      const res = await fetch(`/api/leads/${leadId}/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steps, context: note.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'That did not work.'); return; }
      setAsking(false);
      setNote('');
      router.refresh();
    } catch {
      setError('The server did not respond. Nothing was written, so try again.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * One panel, whether or not there is anything to lose.
   *
   * The note and the confirmation used to be separate ideas: a confirm step
   * when drafts existed, and no way to say what you wanted at all. They belong
   * together, because the moment somebody is deciding whether to replace copy
   * is the moment they know what is wrong with it.
   */
  if (asking) {
    return (
      <div style={{ marginTop: 10 }}>
        <label htmlFor={`redraft-note-${leadId}`} className="small">
          What should change? Optional.
        </label>
        <textarea
          id={`redraft-note-${leadId}`}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Less about us, more about what they are hiring for."
          style={{ minHeight: 64, marginTop: 4 }}
        />
        <p className="small" style={{ margin: '6px 0 8px' }}>
          {destructive ? (
            <>
              <b>
                This replaces all {existingDrafts} draft{existingDrafts === 1 ? '' : 's'} for
                this company.
              </b>{' '}
              {editedByHuman > 0 && (
                <span className="state-degraded">
                  {editedByHuman} of them {editedByHuman === 1 ? 'was' : 'were'} edited by
                  hand, and {editedByHuman === 1 ? 'that edit' : 'those edits'} cannot be
                  recovered.
                </span>
              )}{' '}
              To change one message on its own, use Rewrite this step under it instead.
            </>
          ) : (
            'This writes the messages this lead already has again.'
          )}{' '}
          The copy is checked against the same gates, costs a few cents, and counts against
          the daily budget.
        </p>
        <button onClick={go} disabled={busy}>
          {busy ? 'Writing the copy' : destructive ? 'Replace the drafts' : 'Write the copy'}
        </button>{' '}
        <button className="quiet" onClick={() => setAsking(false)} disabled={busy}>
          {destructive ? 'Keep what is there' : 'Cancel'}
        </button>
        {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 30 }}>
      <button className="quiet" onClick={() => setAsking(true)} disabled={busy}>
        {busy ? 'Writing the copy' : 'Write the copy again'}
      </button>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        A fresh attempt at every message this lead has, checked against the same gates. It
        costs a few cents and counts against the daily budget.
      </p>
      {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
