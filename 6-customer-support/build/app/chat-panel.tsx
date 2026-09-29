'use client';

import { useEffect, useRef, useState } from 'react';
import { Transcript, type Entry } from './transcript.tsx';
import { ConfirmButton } from './ui/confirm.tsx';
import { usePersisted } from './ui/use-persisted.ts';

type Records = { ticket_ref: string | null; escalation_ref: string | null; call_booked: boolean; appointment: string | null } | null;
const LIMIT = 1000;
const ENDED = 'This chat has ended. Send a message to start a new one.';

/** References are notes built from the rows the agent service returned, never parsed out of the reply. */
function notesFor(r: Records, seen: Set<string>): Entry[] {
  const out: Entry[] = [];
  if (r?.ticket_ref && !seen.has(r.ticket_ref)) { seen.add(r.ticket_ref); out.push({ who: 'note', text: `Ticket reference ${r.ticket_ref}` }); }
  if (r?.escalation_ref && !seen.has(r.escalation_ref)) {
    seen.add(r.escalation_ref);
    out.push({ who: 'note', text: r.call_booked && r.appointment
      ? `Escalation reference ${r.escalation_ref}. Callback booked for ${r.appointment}.`
      : `Escalation reference ${r.escalation_ref}. A specialist will follow up by email to confirm a time.` });
  }
  return out;
}

export function ChatPanel() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft, clearDraft] = usePersisted('rp_chat_draft', '', 'session');
  const [pending, setPending] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const seen = useRef(new Set<string>());
  const box = useRef<HTMLTextAreaElement>(null);

  /** Rebuilds the view from the stored transcript. Returns how many turns it found. */
  async function restore(): Promise<number> {
    const t = (await (await fetch('/api/chat', { cache: 'no-store' })).json()) as { turns: { you: string; relaypay: string; at: string }[]; ended: boolean; records: Records };
    seen.current = new Set();
    const rows: Entry[] = t.turns.flatMap((x) => [{ who: 'you', text: x.you, at: x.at }, { who: 'relaypay', text: x.relaypay, at: x.at }] as Entry[]);
    rows.push(...notesFor(t.records, seen.current));
    if (t.ended && rows.length) rows.push({ who: 'note', text: ENDED });
    setEntries(rows); setEnded(t.ended && rows.length > 0);
    return t.turns.length;
  }

  useEffect(() => {
    restore().then(async () => {
      // A draft that is already the last thing answered was sent; keeping it invites a duplicate.
      const t = await (await fetch('/api/chat', { cache: 'no-store' })).json();
      const last = t.turns?.at(-1)?.you?.trim();
      const saved = (() => { try { return JSON.parse(window.sessionStorage.getItem('rp_chat_draft') ?? '""'); } catch { return ''; } })();
      if (last && typeof saved === 'string' && saved.trim() === last) { setDraft(''); clearDraft(); }
    }).catch(() => { /* a failed restore leaves an empty chat, which still works */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** A reply can land after the page gave up waiting. If it did, show it rather than an error. */
  async function recovered(before: number): Promise<boolean> {
    try { return (await restore()) > before; } catch { return false; }
  }

  async function send() {
    const message = draft.trim();
    if (!message || pending) return;
    setPending(true); setError('');
    const at = new Date().toISOString();
    const turnsBefore = ended ? Infinity : entries.filter((e) => e.who === 'you').length;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      const j = await res.json();
      if (!res.ok) {
        if (res.status === 503 && (await recovered(turnsBefore))) { setDraft(''); clearDraft(); return; }
        setError(j.error ?? 'The message was not sent. Try again.'); return;
      }
      if (j.new_chat || ended) seen.current = new Set();
      setEntries((prev) => [...(j.new_chat || ended ? [] : prev), { who: 'you', text: message, at },
        { who: 'relaypay', text: j.reply, at: new Date().toISOString() }, ...notesFor(j.records, seen.current),
        ...(j.ended ? [{ who: 'note' as const, text: ENDED }] : [])]);
      setEnded(!!j.ended);
      setDraft(''); clearDraft();
    } catch {
      if (await recovered(turnsBefore)) { setDraft(''); clearDraft(); return; }
      setError('The message was not sent, because the connection dropped. Your message is still here; try again.');
    } finally { setPending(false); box.current?.focus(); }
  }

  async function endChat(): Promise<string | null> {
    const res = await fetch('/api/chat', { method: 'DELETE' });
    if (!res.ok && res.status !== 204) return 'The chat was not ended. Try again.';
    setEntries((prev) => [...prev, { who: 'note', text: ENDED }]); setEnded(true);
    return null;
  }

  const status = error || (pending ? 'RelayPay is replying' : '');
  return (
    <div>
      <Transcript entries={entries} label="Chat transcript" />
      <form className="rp-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor="rp-message">Message</label>
        <textarea id="rp-message" ref={box} rows={2} maxLength={LIMIT} value={draft}
          placeholder="For example: what fees do you charge for international payments?"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="rp-row rp-composer-actions">
          <button type="submit" className="rp-btn" disabled={pending || !draft.trim()}>Send</button>
          {entries.length > 0 && !ended && (
            <ConfirmButton label="End chat" title="End this chat?"
              body="The conversation closes, and your next message starts a new chat. Any ticket or escalation reference you were given stays valid."
              confirmLabel="End chat" cancelLabel="Keep chatting" onConfirm={endChat} />
          )}
          {draft.length >= 800 && <span className="rp-count" aria-live="polite">{draft.length} / {LIMIT}</span>}
        </div>
      </form>
      <p className="rp-status" role="status" aria-live="polite" data-tone={error ? 'bad' : undefined}>{status}</p>
    </div>
  );
}
