'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './ui/icons.tsx';

/** A note may carry the reference it announces, so the page can offer to copy it without parsing the sentence. */
export type Entry = { who: 'you' | 'relaypay' | 'note'; text: string; at?: string; ref?: string };
const LABEL: Record<Entry['who'], string> = { you: 'You', relaypay: 'RelayPay', note: 'Reference' };
const smooth = () => { try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
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
  const root = useRef<HTMLDivElement>(null);
  const away = useRef(false);
  const [behind, setBehind] = useState(false);
  const shown = entries.length > 0 || !!pending;
  const box = () => root.current?.closest<HTMLElement>('.rp-desk-body') ?? null;

  // Follow the conversation only while the reader is at the bottom. Someone who scrolled up to read an answer
  // is not yanked back down by the next line; they get a button to jump to it instead.
  useEffect(() => {
    const el = box();
    if (!el) return;
    // Only the reader scrolling up counts as leaving the bottom. A smooth scroll to a new line fires scroll events
    // part way down, and treating those as "away" stopped the transcript following the call after a few lines.
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
      if (atBottom) { away.current = false; setBehind(false); }
      else if (el.scrollTop < lastTop - 2) away.current = true;
      lastTop = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [shown]);

  // Scroll only the transcript's own box. scrollIntoView also scrolls every clipped ancestor, which slid the
  // desk header and the End call button out of view once a long conversation overflowed.
  const last = entries.at(-1);
  useEffect(() => {
    const el = box();
    if (!el) return;
    if (away.current) { setBehind(true); return; }
    // Straight to the newest line: a smooth scroll restarted by every new line never reached the bottom.
    el.scrollTop = el.scrollHeight;
  }, [entries.length, last?.text.length, pending]);

  function jump() {
    const el = box();
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth() ? 'smooth' : 'auto' });
    away.current = false; setBehind(false);
  }
  if (!entries.length && !pending) return empty ? <div className="rp-empty">{empty}</div> : null;
  return (
    <div className="rp-scroll" ref={root}>
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
      {behind && <button type="button" className="rp-jump" onClick={jump}>Jump to latest</button>}
      {pending && (
        <div className="rp-pending" aria-hidden="true">
          <span className="rp-who">RelayPay</span>
          <span className="rp-dots"><i /><i /><i /></span>
          <span className="rp-mute">{pending}</span>
        </div>
      )}
    </div>
  );
}
