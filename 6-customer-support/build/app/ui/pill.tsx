import { words } from './format.ts';

/** The tint only helps scanning; the word is always there, so nothing is said by colour alone. */
const TONE: Record<string, 'good' | 'bad' | 'blue'> = {
  resolved: 'good', clarified: 'good', sent: 'good', fallback_sent: 'good', booked: 'good', pass: 'good',
  escalated: 'bad', failed: 'bad', declined: 'bad', urgent: 'bad', high: 'bad', fail: 'bad', slot_unavailable: 'bad',
  open: 'blue', in_progress: 'blue', ticketed: 'blue', pending: 'blue',
};

export function Pill({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return null;
  return <span className="rp-pill" data-tone={TONE[value]}>{label ?? words(value)}</span>;
}
