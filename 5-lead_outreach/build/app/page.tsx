'use client';

import { useState } from 'react';
import { usePersisted } from './ui/use-persisted';

type Form = { objective: string; geography: string; headcount: string };

const EMPTY: Form = { objective: '', geography: '', headcount: '' };

export default function Intake() {
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
    <main className="wrap narrow">
      <h1>Koya Lead Desk</h1>
      <p className="muted">
        Describe who you want to reach. The agent refines that into criteria, finds companies,
        reads their websites and writes a sequence for each one it can justify. Nothing is sent.
      </p>

      <hr className="rule" />

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
        </div>

        <button type="submit" disabled={submitting || form.objective.trim().length < 10}>
          {submitting ? 'Queueing the run' : 'Start the run'}
        </button>
        <p className="small muted" style={{ marginTop: 14 }}>
          Germany is left out of suggested geography by default: its rules effectively require
          consent for commercial email. Ask for it explicitly if you want it.
        </p>
      </form>
    </main>
  );
}
