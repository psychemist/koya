'use client';

import { useState } from 'react';

type GateResult = { gate: string; severity: string; passed: boolean; detail?: string };

type Draft = {
  id: string; step: number; subject: string | null; body: string;
  personalization_note: string | null; source_url: string | null; edited_by_human: boolean;
  gate_results: GateResult[] | null;
};

const title = (step: number) => (step === 0 ? 'LinkedIn message' : `Email ${step}`);

export function DraftEditor({ draft }: { draft: Draft }) {
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const [edited, setEdited] = useState(draft.edited_by_human);
  const [gates, setGates] = useState<GateResult[]>(draft.gate_results ?? []);

  // Advisory findings are defined as "shown to the reviewer, not blocking".
  // They were computed, stored, returned to the agent and then dropped, so the
  // one person they were written for never saw them.
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

      {advisories.length > 0 && (
        <ul className="tight small" style={{ margin: '8px 0 0' }}>
          {advisories.map((a) => (
            <li key={a.gate} className="state-degraded">{a.detail ?? a.gate}</li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 8 }}>
        <button className="quiet" onClick={save} disabled={!dirty || state === 'saving'}>
          {state === 'saving' ? 'Checking the edit' : state === 'saved' ? 'Saved' : 'Save changes'}
        </button>
        <span className="small muted" style={{ marginLeft: 10 }}>
          {checksPassed > 0
            ? `${checksPassed} checks passed. Edits are checked the same way.`
            : 'Edits pass the same checks the draft did.'}
        </span>
      </div>
    </div>
  );
}
