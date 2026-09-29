export type HoursConfig = { days: number[]; startHour: number; endHour: number; slotMinutes: number };
export const DEFAULT_HOURS: HoursConfig = { days: [1, 2, 3, 4, 5], startHour: 8, endHour: 18, slotMinutes: 30 };
const LEAD_MS = 15 * 60_000;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function inHours(d: Date, h: HoursConfig): boolean {
  if (!h.days.includes(d.getUTCDay())) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= h.startHour * 60 && mins + h.slotMinutes <= h.endHour * 60;
}

export function nextSlots(from: Date, n: number, h = DEFAULT_HOURS): Date[] {
  const step = h.slotMinutes * 60_000;
  let t = Math.ceil((from.getTime() + LEAD_MS) / step) * step;
  const out: Date[] = [];
  for (let guard = 0; out.length < n && guard < 14 * 48; guard++, t += step) { const d = new Date(t); if (inHours(d, h)) out.push(d); }
  return out;
}

export type SlotCheck = { ok: true; start: Date }
  | { ok: false; code: 'TIME_NEEDS_OFFSET' | 'TIME_IN_PAST' | 'OUTSIDE_HOURS' | 'INVALID_TIME'; suggestions: Date[] };

export function validateSlot(iso: string, now: Date, h = DEFAULT_HOURS): SlotCheck {
  const fail = (code: Exclude<SlotCheck, { ok: true }>['code']): SlotCheck => ({ ok: false, code, suggestions: nextSlots(now, 3, h) });
  if (!OFFSET.test(iso.trim())) return fail('TIME_NEEDS_OFFSET');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fail('INVALID_TIME');
  if (d.getTime() < now.getTime() + LEAD_MS) return fail('TIME_IN_PAST');
  if (!inHours(d, h)) return fail('OUTSIDE_HOURS');
  return { ok: true, start: d };
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz.includes('/'); } catch { return false; }
}

const hhmm = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

export function describeSlot(d: Date, tz?: string | null): string {
  const base = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} at ${hhmm(d, 'UTC')} UTC`;
  if (!tz || !isValidTimezone(tz)) return base;
  return `${base}, which is ${hhmm(d, tz)} in ${tz.split('/').pop()!.replace(/_/g, ' ')}`;
}
