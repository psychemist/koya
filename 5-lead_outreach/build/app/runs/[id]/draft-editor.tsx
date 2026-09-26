'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type GateResult = { gate: string; severity: string; passed: boolean; detail?: string };

type Draft = {
  id: string; step: number; subject: string | null; body: string;
  personalization_note: string | null; source_url: string | null; edited_by_human: boolean;
  gate_results: GateResult[] | null;
};

const title = (step: number) => (step === 0 ? 'LinkedIn Message' : `Email ${step}`);

/** Matches CONTEXT_MAX_CHARS in lib/drafting.ts, where it is enforced. This
 *  is the courtesy of saying so before the trim happens, not the rule. */
const NOTE_MAX = 500;

export function DraftEditor({ draft, leadId }: { draft: Draft; leadId: string }) {
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const [edited, setEdited] = useState(draft.edited_by_human);
  const [gates, setGates] = useState<GateResult[]>(draft.gate_results ?? []);

  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [rewriting, setRewriting] = useState(false);

  /**
   * Rewrite THIS step, with the reviewer's own words as context.
   *
   * Scoped to one step because the whole-sequence redraft replaced everything,
   * so disliking the second email cost you the other three, including your own
   * edits. The note is optional: asking again with no guidance is still the
   * quickest answer to copy that simply reads badly.
   */
  async function rewrite() {
    setRewriting(true);
    setReason(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/drafts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: draft.step, context: note.trim() || undefined }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // What was there is still there: a rejected rewrite writes nothing.
        setReason(payload.error ?? 'That rewrite was not accepted.');
        return;
      }
      setAsking(false);
      setNote('');
      router.refresh();
    } catch {
      setReason('The server did not respond. Nothing was changed, so try again.');
    } finally {
      setRewriting(false);
    }
  }

  // Advisory findings are defined as "shown to the reviewer, not blocking".
  // They were computed, stored, returned to the agent and then dropped, so the
  // one person they were written for never saw them.
  const blocking = gates.filter((g) => g.severity === 'blocking' && !g.passed);
  const advisories = gates.filter((g) => g.severity === 'advisory' && !g.passed);
  const checksPassed = gates.filter((g) => g.severity === 'blocking' && g.passed).length;

  const dirty = subject !== (draft.subject ?? '') || body !== draft.body;

  async function save() {
    setState('saving');
    setReason(null);
    const res = await fetch(`/api/drafts/${draft.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: subject || undefined, body }),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.ok) {
      setState('saved');
      setEdited(true);
      if (payload.results) setGates(payload.results as GateResult[]);
    } else {
      setState('idle');
      setReason(payload.reason ?? payload.error ?? 'The edit was not saved.');
      if (payload.results) setGates(payload.results as GateResult[]);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="col-label" style={{ marginBottom: 6 }}>
        {title(draft.step)}{edited && <span className="muted"> (you edited this)</span>}
      </div>

      {reason && <div className="error small">{reason}</div>}

      {draft.step !== 0 && (
        <input value={subject} onChange={(e) => setSubject(e.target.value)}
               aria-label={`${title(draft.step)} subject`} style={{ marginBottom: 6 }} />
      )}
      <textarea value={body} onChange={(e) => setBody(e.target.value)}
                aria-label={`${title(draft.step)} body`} />

      {draft.personalization_note && (
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Uses: {draft.personalization_note}
          {draft.source_url && (
            <> (<a href={draft.source_url} target="_blank" rel="noreferrer">source</a>)</>
          )}
        </p>
      )}

      {/*
        One verdict block, ordered by what the reviewer has to act on.
        Blocking failures first because they stop the draft, advisories next
        because they are judgement calls, and the passed count last because it
        is reassurance rather than a task. It previously sat on the button row
        instead, so the count and the findings it summarised were in two
        different places.

        A list rather than a sentence: four gates today and there will be more,
        and findings that wrap read as prose the moment they run together.
      */}
      {(blocking.length > 0 || advisories.length > 0 || checksPassed > 0) && (
        <ul className="draft-checks">
          {blocking.map((g) => (
            <li key={g.gate}>
              <span className="state-failed"style={{ marginLeft: 2 }}>must fix</span>
              <span style={{ marginLeft: 15.5 }}>{g.detail ?? g.gate}</span>
            </li>
          ))}
          {advisories.map((a) => (
            <li key={a.gate}>
              <span className="state-degraded"style={{ marginLeft: 2 }}>worth a look</span>
              <span style={{ marginLeft: 15.5 }}>{a.detail ?? a.gate}</span>
            </li>
          ))}
          {checksPassed > 0 && (
            <li>
              <span className="state-good"style={{ marginLeft: 2 }}>passed</span>
              <span className="muted" style={{ marginLeft: 15.5 }}>
                {checksPassed} check{checksPassed === 1 ? '' : 's'}
                {blocking.length > 0 || advisories.length > 0 ? ', and the rest are above' : ''}
              </span>
            </li>
          )}
        </ul>
      )}

      {asking && (
        <div style={{ marginTop: 10 }}>
          <label htmlFor={`note-${draft.id}`} className="small">
            What should change? Optional.
          </label>
          <textarea
            id={`note-${draft.id}`}
            value={note}
            maxLength={NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Shorter. Lead with their hiring, not the product."
            style={{ minHeight: 64, marginTop: 4 }}
          />
          <p className="small muted" style={{ margin: '4px 0 8px' }}>
            This rewrites {title(draft.step).toLowerCase()} only, and leaves the rest of the
            sequence alone. {edited && 'Your edits to this one will be replaced. '}
            It costs a few cents and is checked against the same gates.
          </p>
          <button onClick={rewrite} disabled={rewriting}>
            {rewriting ? 'Writing' : 'Rewrite this step'}
          </button>{' '}
          <button className="quiet" onClick={() => setAsking(false)} disabled={rewriting}>
            Cancel
          </button>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button className="quiet" onClick={save} disabled={!dirty || state === 'saving'}>
          {state === 'saving' ? 'Checking the edit' : state === 'saved' ? 'Saved' : 'Save changes'}
        </button>
        {!asking && (
          <button
            className="quiet"
            onClick={() => setAsking(true)}
            disabled={rewriting}
            style={{ marginLeft: 8 }}
          >
            Rewrite this step
          </button>
        )}
      </div>
    </div>
  );
}
