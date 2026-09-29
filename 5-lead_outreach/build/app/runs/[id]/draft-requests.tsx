'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Mirrors EMAIL_STEPS and LINKEDIN_STEP in lib/drafting.ts, where the table
 *  constraint and the model prompt both enforce the same ceiling. */
const LINKEDIN_STEP = 0;
const EMAIL_STEPS = [1, 2, 3];

/**
 * Ask for the copy, one message at a time.
 *
 * The run used to write a LinkedIn message and three emails for every company
 * the moment it qualified. That is four model calls per lead, paid for before
 * anybody had decided whether the lead was worth writing to, on a list where
 * most leads are read once and never contacted. Qualifying is the agent's job
 * and writing is a decision, so the decision is a button now.
 *
 * What it offers is a function of what the lead already has: the LinkedIn
 * button disappears once there is a LinkedIn message, and the email count
 * tops out at whatever is left of the three. An existing message is changed
 * with Rewrite this step, under the draft itself, rather than from here.
 */
export function DraftRequests({ leadId, existingSteps }: {
  leadId: string; existingSteps: number[];
}) {
  const [busy, setBusy] = useState<'linkedin' | 'emails' | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const hasLinkedIn = existingSteps.includes(LINKEDIN_STEP);
  // The slots, not the count: a reviewer who rewrote email 2 and deleted
  // nothing still has 1 and 3, and asking for one more means writing into the
  // gap rather than appending a fourth that cannot exist.
  const free = EMAIL_STEPS.filter((n) => !existingSteps.includes(n));
  const written = EMAIL_STEPS.length - free.length;

  async function write(steps: number[], which: 'linkedin' | 'emails') {
    setBusy(which);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steps }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'That did not work.'); return; }
      setAsking(false);
      router.refresh();
    } catch {
      setError('The server did not respond. Nothing was written, so try again.');
    } finally {
      setBusy(null);
    }
  }

  if (hasLinkedIn && !free.length) {
    return (
      <p className="small muted" style={{ marginTop: 14 }}>
        The LinkedIn message and all {EMAIL_STEPS.length} emails are written. To change one,
        use Rewrite this step under it.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
      <div className="col-label" style={{ marginBottom: 6 }}>Write the outreach</div>

      {error && <p className="small state-bad" style={{ display: 'inline-block', margin: '0 0 8px' }}>
        {error}
      </p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!hasLinkedIn && (
          <button className="quiet" disabled={busy !== null}
                  onClick={() => write([LINKEDIN_STEP], 'linkedin')}>
            {busy === 'linkedin' ? 'Writing the message' : 'LinkedIn message'}
          </button>
        )}
        {free.length > 0 && !asking && (
          <button className="quiet" disabled={busy !== null} onClick={() => setAsking(true)}>
            Emails
          </button>
        )}
      </div>

      {/* The second click is the count. Asking for three at once is one model
          call rather than three, which is most of what this costs. */}
      {asking && free.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="small" style={{ marginBottom: 6 }}>
            How many emails?{' '}
            <span className="muted">
              {written > 0
                ? `${written} of ${EMAIL_STEPS.length} written, so ${free.length} left.`
                : `${EMAIL_STEPS.length} per lead is the limit.`}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {free.map((_, i) => {
              const n = i + 1;
              return (
                <button key={n} className="quiet" disabled={busy !== null}
                        onClick={() => write(free.slice(0, n), 'emails')}>
                  {busy === 'emails' ? 'Writing' : n === 1 ? '1 email' : `${n} emails`}
                </button>
              );
            })}
            <button className="quiet" disabled={busy !== null} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Each request asks the model once, is checked against the same gates, costs a few
        cents and counts against the daily budget. Nothing is sent to anyone.
      </p>
    </div>
  );
}
