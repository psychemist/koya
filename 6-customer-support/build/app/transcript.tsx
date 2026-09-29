'use client';

import { useEffect, useRef } from 'react';

export type Entry = { who: 'you' | 'relaypay' | 'note'; text: string; at?: string };
const LABEL: Record<Entry['who'], string> = { you: 'You', relaypay: 'RelayPay', note: 'Reference' };
const hhmm = (iso?: string) => (iso ? new Date(iso).toISOString().slice(11, 16) : '');

/**
 * The conversation as a statement: one row per line, the speaker in a narrow
 * column, the time in UTC, a 1px rule between rows. Deliberately not a
 * messenger. A call and a chat render through this same component, so they
 * read the same way (brand: "avoid chat-heavy visual treatment").
 */
export function Transcript({ entries, label = 'Conversation' }: { entries: Entry[]; label?: string }) {
  const last = useRef<HTMLLIElement>(null);
  useEffect(() => { last.current?.scrollIntoView({ block: 'nearest' }); }, [entries.length]);
  if (!entries.length) return null;
  return (
    <ol className="rp-transcript" role="log" aria-live="polite" aria-relevant="additions" aria-label={label}>
      {entries.map((e, i) => (
        <li key={i} ref={i === entries.length - 1 ? last : undefined} data-who={e.who}>
          <span className="rp-who">{LABEL[e.who]}</span>
          <p>{e.text}</p>
          {e.at && <time dateTime={e.at}>{hhmm(e.at)} UTC</time>}
        </li>
      ))}
    </ol>
  );
}
