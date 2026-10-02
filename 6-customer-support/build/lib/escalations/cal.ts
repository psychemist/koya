import { config } from '../config.ts';
import { redactString } from '../sanitise.ts';

// Cal.com versions each v2 endpoint separately; an unset or wrong header silently selects an older contract.
const V_SLOTS = '2024-09-04';
const V_CREATE = '2026-02-25';
const V_LIST = '2026-05-01';

export type BookingResult = { result: 'booked'; uid: string } | { result: 'slot_taken' } | { result: 'failed'; error: string };
export type CallbackRequest = { start: string; name: string; email: string; timeZone: string; ref: string; key: string };

const TAKEN = /not available|already has booking|no available users/i;

async function call(base: string, path: string, version: string, init: { method?: string; query?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${config.escalation.calApiKey}`, 'cal-api-version': version,
      ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(config.escalation.stepTimeoutMs),
  });
  const json = await res.json().catch(() => null) as any;
  return { status: res.status, ok: res.ok, json };
}

const sameInstant = (a: unknown, b: string) => typeof a === 'string' && new Date(a).getTime() === new Date(b).getTime();

/**
 * Books one support callback on Cal.com. Cal.com owns the calendar, the
 * free/busy check and the invite, so there is no calendar auth here.
 *
 * It never throws: the outbox stores the result and decides what to retry.
 * `lookFirst` is for retries. A first attempt that timed out may still have
 * booked, so a retry looks for that booking before making another, and fails
 * rather than books when it cannot look.
 */
export async function bookCallback(r: CallbackRequest, opts: { baseUrl: string; lookFirst: boolean }): Promise<BookingResult> {
  const eventTypeId = config.escalation.calEventTypeId;
  const end = new Date(new Date(r.start).getTime() + config.hours.slotMinutes * 60_000).toISOString();
  try {
    if (opts.lookFirst) {
      const pad = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60_000).toISOString();
      const found = await call(opts.baseUrl, '/v2/bookings', V_LIST, { query: { attendeeEmail: r.email, eventTypeId: String(eventTypeId),
        afterStart: pad(r.start, -1), beforeEnd: pad(end, 1) } });
      if (!found.ok) return { result: 'failed', error: `cal.com lookup returned ${found.status}` };
      const hit = (found.json?.data ?? []).find((b: any) => sameInstant(b.start, r.start) && b.status !== 'cancelled');
      if (hit?.uid) return { result: 'booked', uid: String(hit.uid) };
    }

    const slots = await call(opts.baseUrl, '/v2/slots', V_SLOTS, { query: { eventTypeId: String(eventTypeId), start: r.start, end } });
    if (!slots.ok) return { result: 'failed', error: `cal.com slots returned ${slots.status}` };
    const open = Object.values<any[]>(slots.json?.data ?? {}).flat().some((s) => sameInstant(s?.start, r.start));
    if (!open) return { result: 'slot_taken' };

    const made = await call(opts.baseUrl, '/v2/bookings', V_CREATE, { method: 'POST', body: { start: r.start, eventTypeId,
      attendee: { name: r.name, email: r.email, timeZone: r.timeZone }, metadata: { relaypay_ref: r.ref, relaypay_key: r.key } } });
    if (made.ok && made.json?.data?.uid) return { result: 'booked', uid: String(made.json.data.uid) };
    // Someone took the slot between the check and the booking: the customer is offered other times, as for any taken slot.
    if (made.status < 500 && TAKEN.test(String(made.json?.error?.message ?? made.json?.message ?? ''))) return { result: 'slot_taken' };
    return { result: 'failed', error: `cal.com booking returned ${made.status}` };
  } catch (err) {
    return { result: 'failed', error: redactString(`cal.com unreachable: ${(err as Error).message}`) };
  }
}
