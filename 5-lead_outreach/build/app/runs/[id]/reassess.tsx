'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Judge this lead again.
 *
 * Offered only on needs_review, which is the one verdict that is not an
 * answer. A not_qualified lead has been decided and re-judging it on request
 * until it says yes is how a filter stops meaning anything; if a reviewer
 * disagrees with that one, Accept is the honest route and it leaves their name
 * on it.
 *
 * Two actions because "look again" and "go and find out" are different
 * requests at different prices. Research reads one more page first and spends
 * a page from the run's budget; reassess spends only a model call.
 *
 * The panel is the one the rewrite buttons use: a note box, a sentence naming
 * what it costs, and the action. What differs is that here the note is a claim
 * to be weighed rather than an instruction to follow, and the prompt says so.
 */
const NOTE_MAX = 500;

export function Reassess({ leadId, confidence }: { leadId: string; confidence: string }) {
  const [asking, setAsking] = useState<null | 'reassess' | 'research'>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function go(research: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/reassess`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ research, context: note.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Nothing is written on a failure, so what was there is still there.
        setError(body.error ?? 'That did not work.');
        return;
      }
      setAsking(null);
      setNote('');
      router.refresh();
    } catch {
      setError('The server did not respond. Nothing was changed, so try again.');
    } finally {
      setBusy(false);
    }
  }

  if (asking) {
    const research = asking === 'research';
    return (
      <div style={{ marginTop: 12 }}>
        <label htmlFor={`reassess-note-${leadId}`} className="small">
          Anything it should weigh? Optional.
        </label>
        <textarea
          id={`reassess-note-${leadId}`}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Their careers page lists 40 staff, so the headcount filter should pass."
          style={{ minHeight: 60, marginTop: 4 }}
        />
        <p className="small muted" style={{ margin: '4px 0 8px' }}>
          {research
            ? 'This reads one more page from their site, then judges again on the fuller '
              + 'evidence. It spends a page from this run\'s budget and a few cents.'
            : 'This judges again on the evidence already gathered. It reads nothing new '
              + 'and costs a few cents.'}{' '}
          Your note is weighed against the evidence, not taken as fact, and qualified still
          needs a fit reason and confidence of at least 0.40.
        </p>
        <button onClick={() => go(research)} disabled={busy}>
          {busy ? 'Judging' : research ? 'Research and judge again' : 'Judge again'}
        </button>{' '}
        <button className="quiet" onClick={() => setAsking(null)} disabled={busy}>
          Cancel
        </button>
        {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="quiet" onClick={() => setAsking('reassess')} disabled={busy}>
          Reassess this lead
        </button>
        <button className="quiet" onClick={() => setAsking('research')} disabled={busy}>
          Research further
        </button>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Confidence is {confidence}, and {Number(confidence) < 0.4 ? 'below' : 'at or above'} the
        0.40 a qualified lead needs. Judging again can move it either way.
      </p>
      {error && <p className="small state-failed" style={{ margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}
