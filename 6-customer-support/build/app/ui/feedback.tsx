'use client';

import { useState } from 'react';
import { CheckIcon } from './icons.tsx';

/**
 * Asked once a call or a chat ends: did it help, and anything to add. Two plain choices, then an optional note.
 * A call is named by its Vapi call id; a chat is found by the server from its cookie.
 */
export function Feedback({ channel, callId, label }: { channel: 'voice_web' | 'web_text'; callId?: string | null; label: string }) {
  const [rating, setRating] = useState<'good' | 'bad' | null>(null);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'asking' | 'sending' | 'sent'>('asking');
  const [error, setError] = useState('');

  async function send(r: 'good' | 'bad', note?: string) {
    setRating(r); setState('sending'); setError('');
    try {
      const res = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, call_id: callId ?? undefined, rating: r, comment: note || undefined }) });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? 'Your feedback was not saved.'); setState('asking'); return; }
      setState('sent');
    } catch { setError('Your feedback was not saved, because the connection dropped.'); setState('asking'); }
  }

  return (
    <div className="fb" role="group" aria-label={label}>
      {state === 'sent' ? (
        <p className="fb-done"><CheckIcon /> Thanks, your feedback was sent.</p>
      ) : (
        <>
          <p className="fb-q">{label}</p>
          <div className="fb-choices">
            <button type="button" className="rp-btn rp-btn-quiet rp-btn-small" aria-pressed={rating === 'good'} disabled={state === 'sending'}
              onClick={() => void send('good', comment)}>It helped</button>
            <button type="button" className="rp-btn rp-btn-quiet rp-btn-small" aria-pressed={rating === 'bad'} disabled={state === 'sending'}
              onClick={() => setRating('bad')}>It did not help</button>
          </div>
          {rating === 'bad' && (
            <form className="fb-note" onSubmit={(e) => { e.preventDefault(); void send('bad', comment); }}>
              <label htmlFor={`fb-${channel}`}>What went wrong? (optional)</label>
              <textarea id={`fb-${channel}`} rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
              <button type="submit" className="rp-btn rp-btn-small" disabled={state === 'sending'}>Send feedback</button>
            </form>
          )}
          {error && <p className="rp-status" data-tone="bad" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
