'use client';

import { useState } from 'react';
import { ConfirmButton } from './confirm.tsx';
import { usePersisted } from './use-persisted.ts';

const EMPTY = { scenario_key: 'brief-9-voice', scenario_title: 'Voice flow',
  expected: 'A spoken question gets a spoken reply, and the conversation and its tool calls are logged with channel voice_web.',
  actual: '', passed: 'pass', notes: '', conversation_id: '' };

/** For what the harness cannot run itself, above all row 9: a real voice call. The draft survives a refresh. */
export function ManualEvaluation() {
  const [form, setForm, clear] = usePersisted('rp_manual_eval', EMPTY);
  const [saved, setSaved] = useState('');
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(): Promise<string | null> {
    const res = await fetch('/api/evaluations', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, passed: form.passed === 'pass', conversation_id: form.conversation_id.trim() || undefined }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return j.error ?? 'The evaluation was not saved.';
    clear(); setForm(EMPTY); setSaved(`Saved ${form.scenario_title || form.scenario_key}. Refresh to see it in its run.`);
    return null;
  }

  return (
    <form className="rp-form rp-form-wide" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="me-key">Scenario key</label><input id="me-key" value={form.scenario_key} onChange={set('scenario_key')} />
      <label htmlFor="me-title">Scenario</label><input id="me-title" value={form.scenario_title} onChange={set('scenario_title')} />
      <label htmlFor="me-expected">Expected behaviour</label><textarea id="me-expected" rows={2} value={form.expected} onChange={set('expected')} />
      <label htmlFor="me-actual">What actually happened</label><textarea id="me-actual" rows={3} value={form.actual} onChange={set('actual')} />
      <label htmlFor="me-passed">Result</label>
      <select id="me-passed" value={form.passed} onChange={set('passed')}><option value="pass">Pass</option><option value="fail">Fail</option></select>
      <label htmlFor="me-notes">Notes or fix made</label><textarea id="me-notes" rows={2} value={form.notes} onChange={set('notes')} />
      <label htmlFor="me-conv">Conversation id (optional)</label><input id="me-conv" value={form.conversation_id} onChange={set('conversation_id')} />
      <div className="rp-row">
        <ConfirmButton label="Record evaluation" className="rp-btn" title="Record this evaluation?"
          body={`This adds a manual ${form.passed === 'pass' ? 'pass' : 'fail'} for "${form.scenario_title || form.scenario_key}" to the evaluation records, under your name. The testing evidence is generated from these records.`}
          confirmLabel="Record it" cancelLabel="Keep editing" onConfirm={submit} />
      </div>
      {saved && <p className="rp-status" role="status">{saved}</p>}
    </form>
  );
}
