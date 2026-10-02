'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CustomerRequest } from '../../lib/customer-requests.ts';
import { describeSlot } from '../../lib/hours.ts';

/** Fired by the chat and the call when a reference appears or a call ends, so every list of requests refreshes. */
export const REQUESTS_CHANGED = 'rp:requests-changed';
export const requestsChanged = () => { try { window.dispatchEvent(new Event(REQUESTS_CHANGED)); } catch { /* not in a browser */ } };

const STATUS: Record<CustomerRequest['status'], string> = { open: 'Open', in_progress: 'In progress', closed: 'Closed' };
const KIND: Record<CustomerRequest['kind'], string> = { ticket: 'Ticket', escalation: 'Specialist case' };
const words = (s: string) => s.replace(/_/g, ' ');

/** What happens next on a request, in the customer's terms. */
function nextStep(r: CustomerRequest): string {
  if (r.kind === 'ticket') return r.status === 'closed' ? 'Resolved' : 'Our support team is working on it';
  if (r.callback_at) return `Callback ${describeSlot(new Date(r.callback_at))}`;
  if (r.status === 'closed') return 'Resolved';
  if (r.booking_status === 'pending') return 'Booking your callback';
  return 'A specialist will email you to arrange a time';
}

function useRequests(initial: CustomerRequest[]) {
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/support/requests', { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'Your requests could not be loaded.'); return; }
      setRows(j.requests); setError('');
    } catch { setError('Your requests could not be loaded. Check your connection.'); }
  }, []);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener(REQUESTS_CHANGED, load);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener(REQUESTS_CHANGED, load); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);
  return { rows, error, load };
}

/** In the brand panel: only what is still open, so the customer sees at a glance what support owes them. */
export function PanelRequests({ initial }: { initial: CustomerRequest[] }) {
  const { rows } = useRequests(initial);
  const open = rows.filter((r) => r.status !== 'closed');
  return (
    <div className="sp-requests">
      <p className="sp-requests-h">Your open requests</p>
      {open.length === 0 ? <p className="sp-requests-none">None right now. Anything we raise for you shows up here.</p> : (
        <ul>
          {open.slice(0, 4).map((r) => (
            <li key={r.ref}>
              <span className="sp-req-ref">{r.ref}</span>
              <span className="sp-req-next">{nextStep(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {open.length > 4 && <p className="sp-requests-none">and {open.length - 4} more in the Requests tab.</p>}
    </div>
  );
}

/** The Requests tab: every ticket and specialist case, open ones first, each with what happens next. */
export function RequestsTab({ initial }: { initial: CustomerRequest[] }) {
  const { rows, error, load } = useRequests(initial);
  useEffect(() => { void load(); }, [load]);
  const sorted = [...rows].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed'));
  return (
    <div className="rp-desk-body">
      <div className="rq-list">
        {error && <p className="rp-status" data-tone="bad" role="alert">{error}</p>}
        {sorted.length === 0 && !error ? (
          <div className="rp-empty">
            <p className="rp-empty-title">No requests yet</p>
            <p className="rp-mute">When we raise a ticket or book a specialist for you, it shows up here with what happens next.</p>
          </div>
        ) : (
          <ul>
            {sorted.map((r) => (
              <li key={r.ref} className="rq-item" data-closed={r.status === 'closed'}>
                <div className="rq-top">
                  <span className="rq-ref">{r.ref}</span>
                  <span className="rp-pill" data-tone={r.status === 'closed' ? undefined : 'blue'}>{STATUS[r.status]}</span>
                  <span className="rq-kind">{KIND[r.kind]}, {words(r.category)}</span>
                </div>
                {/* An escalation's reason is written for the team, not the customer, so it is described instead. */}
                <p className="rq-summary">{r.kind === 'escalation' ? `A specialist is looking at your ${words(r.category)} case.` : r.summary}</p>
                <p className="rq-next">{nextStep(r)}</p>
                <p className="rq-when">Raised {describeSlot(new Date(r.created_at)).replace(/ at /, ', ')}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
