'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmButton } from './confirm.tsx';
import { usePersisted } from './use-persisted.ts';

const EMPTY = { title: '', body: '' };

/** Add an approved answer to the knowledge base. The draft survives a refresh; publishing asks first. */
export function KnowledgeForm() {
  const router = useRouter();
  const [form, setForm, clear] = usePersisted('rp_kb_draft', EMPTY);
  const [saved, setSaved] = useState('');
  const ready = form.title.trim().length >= 5 && form.body.trim().length >= 40;

  async function publish(): Promise<string | null> {
    const res = await fetch('/api/knowledge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return j.error ?? 'The article was not published.';
    setSaved(`${j.replaced ? 'Updated' : 'Published'} "${form.title.trim()}". The agent can answer from it now.`);
    clear(); setForm(EMPTY); router.refresh();
    return null;
  }

  return (
    <form className="rp-form rp-form-wide" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="kb-title">Title</label>
      <input id="kb-title" value={form.title} maxLength={120} placeholder="For example: Can I cancel a payout after I send it?"
        onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <small className="rp-mute">Phrase it as the question customers ask. The same title again replaces the article.</small>
      <label htmlFor="kb-body">Approved answer</label>
      <textarea id="kb-body" rows={8} maxLength={4000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <small className="rp-mute">{form.body.length} of 4,000 characters. Only write what RelayPay has approved: the agent quotes it to customers.</small>
      <div className="rp-row">
        <ConfirmButton label="Publish article" className="rp-btn" title="Publish this article?"
          body={`The agent starts answering from "${form.title.trim() || 'this article'}" on calls and chats straight away. It is embedded with Voyage, which costs a fraction of a cent per article.`}
          confirmLabel="Publish" cancelLabel="Keep editing" onConfirm={publish} />
        {!ready && <span className="rp-mute">A title of 5 characters and an answer of 40 are needed.</span>}
      </div>
      {saved && <p className="rp-status" role="status">{saved}</p>}
    </form>
  );
}

/** Takes one article out of search, after saying what that does. */
export function RetireArticle({ id, heading }: { id: string; heading: string }) {
  const router = useRouter();
  return (
    <ConfirmButton label="Retire" className="rp-step rp-step-quiet" title={`Retire "${heading}"?`}
      body="The agent stops answering from this article on new turns. It is kept, so adding the same title again brings it back."
      confirmLabel="Retire article" cancelLabel="Keep it"
      onConfirm={async () => {
        const res = await fetch(`/api/knowledge?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) return (await res.json().catch(() => ({}))).error ?? 'The article was not retired.';
        router.refresh(); return null;
      }} />
  );
}
