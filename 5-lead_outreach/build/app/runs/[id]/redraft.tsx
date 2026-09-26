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
/** Matches CONTEXT_MAX_CHARS in lib/drafting.ts, where it is enforced. This is
 *  the courtesy of saying so before the trim happens, not the rule. */
const NOTE_MAX = 500;

export function Redraft(
  { leadId, existingDrafts = 0, editedByHuman = 0 }:
  { leadId: string; existingDrafts?: number; editedByHuman?: number },
) {
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
      // No step: this rewrites the whole sequence. The note is optional.
      const res = await fetch(`/api/leads/${leadId}/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: note.trim() || undefined }),
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
            'This writes the full sequence: the LinkedIn message and all three emails.'
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
        This asks the model for a fresh attempt at the whole sequence and checks it against
        the same gates. It costs a few cents and counts against the daily budget.
      </p>
      {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
