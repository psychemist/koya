'use client';

import { useState } from 'react';
import { usePersisted } from './use-persisted';

type Form = {
  objective: string; geography: string; headcount: string; target_leads: string;
};

const EMPTY: Form = { objective: '', geography: '', headcount: '', target_leads: '10' };

export function IntakeForm() {
  const [form, setForm, clearStored] = usePersisted<Form>('koya-lead-intake', EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'The run could not be queued.'); return; }
      clearStored();
      window.location.href = `/runs/${body.id}`;
    } catch {
      setError('The server did not respond. Nothing was queued, so try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });

  return (
    <form onSubmit={submit}>
      {error && <div className="error">{error}</div>}

      <div className="field">
        <label htmlFor="objective">Who are you looking for?</label>
        <textarea
          id="objective"
          value={form.objective}
          onChange={(e) => set({ objective: e.target.value })}
          placeholder="US B2B SaaS companies with 10 to 100 employees that are hiring operations roles"
          required
        />
        <p className="small muted">
          Plain English is enough. If it is too vague to search, the run stops and asks you
          one question rather than guessing and spending the budget.
        </p>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="geography">Geography (optional)</label>
          <input id="geography" value={form.geography}
                 onChange={(e) => set({ geography: e.target.value })}
                 placeholder="United States" />
        </div>
        <div className="field">
          <label htmlFor="headcount">Headcount (optional)</label>
          <input id="headcount" value={form.headcount}
                 onChange={(e) => set({ headcount: e.target.value })}
                 placeholder="10 to 100" />
        </div>
        <div className="field">
          <label htmlFor="target_leads">How many leads do you want?</label>
          <input id="target_leads" type="number" min={1} max={25} value={form.target_leads}
                 onChange={(e) => set({ target_leads: e.target.value })} />
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            The run works to this number and stops when a budget runs out. If it
            finishes short it tells you which budget ended and how many companies
            it assessed, rather than padding the list.
          </p>
        </div>
      </div>

      <button type="submit" disabled={submitting || form.objective.trim().length < 10}>
        {submitting ? 'Queueing the run' : 'Start the Run'}
      </button>
      <p className="small muted" style={{ marginTop: 14 }}>
        Germany is left out of suggested geography by default: its rules effectively require
        consent for commercial email. Ask for it explicitly if you want it.
      </p>
    </form>
  );
}
