'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './ui/icons.tsx';

/** A note may carry the reference it announces, so the page can offer to copy it without parsing the sentence. */
export type Entry = { who: 'you' | 'relaypay' | 'note'; text: string; at?: string; ref?: string };
const LABEL: Record<Entry['who'], string> = { you: 'You', relaypay: 'RelayPay', note: 'Reference' };
const hhmm = (iso?: string) => (iso ? new Date(iso).toISOString().slice(11, 16) : '');

function CopyRef({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* the reference is still on screen to select */ }
  }
  return (
    <button type="button" className="rp-copy" onClick={copy} aria-label={done ? `Copied ${value}` : `Copy ${value}`}>
      {done ? <CheckIcon /> : <CopyIcon />}<span aria-hidden="true">{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/**
 * The conversation as a statement: one row per line, the speaker and the UTC
 * time above the words, a 1px rule between rows. Deliberately not a
 * messenger. A call and a chat render through this same component, so they
 * read the same way (brand: "avoid chat-heavy visual treatment"). References
 * are set apart as records, because they are what a customer keeps.
 */
export function Transcript({ entries, label = 'Conversation', pending, empty }: {
  entries: Entry[]; label?: string; pending?: string; empty?: React.ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [entries.length, pending]);
  if (!entries.length && !pending) return empty ? <div className="rp-empty">{empty}</div> : null;
  return (
    <div className="rp-scroll">
      <ol className="rp-transcript" role="log" aria-live="polite" aria-relevant="additions" aria-label={label}>
        {entries.map((e, i) => e.who === 'note' ? (
          <li key={i} data-who="note">
            <div className="rp-record-note">
              <p>{e.text}</p>
              {e.ref && <CopyRef value={e.ref} />}
            </div>
          </li>
        ) : (
          <li key={i} data-who={e.who}>
            <div className="rp-line-meta">
              <span className="rp-who">{LABEL[e.who]}</span>
              {e.at && <time dateTime={e.at}>{hhmm(e.at)} UTC</time>}
            </div>
            <p>{e.text}</p>
          </li>
        ))}
      </ol>
      {pending && (
        <div className="rp-pending" aria-hidden="true">
          <span className="rp-who">RelayPay</span>
          <span className="rp-dots"><i /><i /><i /></span>
          <span className="rp-mute">{pending}</span>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
