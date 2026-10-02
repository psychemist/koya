import { normalizeRef } from './refs.ts';
export type CustomerRow = { customer_id: string; company_name: string; contact_name: string; contact_email: string;
  plan: string; account_status: string; region: string; kyc_status: string; support_notes: string };
export type Identifiers = { customer_id?: string; email?: string; company_name?: string; contact_name?: string };
export type MatchResult = { status: 'matched'; customer: CustomerRow } | { status: 'need_second_identifier' } | { status: 'no_match' };

export const normKey = (s?: string | null) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function normalizeSpokenEmail(s: string): string | null {
  const e = ` ${s.toLowerCase().trim()} `
    .replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.').replace(/\s+underscore\s+/g, '_')
    .replace(/\s+(dash|hyphen)\s+/g, '-').replace(/\s+/g, '');
  return EMAIL.test(e) ? e : null;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Speech-to-text drops and swaps letters in names ("Okafor" heard as "Okafo"), so a full name or a
 * company may differ by one letter, or two in a long one. A first name alone stays exact: "Amaka" is
 * another person, not a mishearing of "Amara". References and emails stay exact too, and two
 * identifiers must still agree on exactly one account.
 */
const near = (given: string, stored: string) => {
  const a = normKey(given), b = normKey(stored);
  return a === b || (b.length >= 8 && editDistance(a, b) <= (b.length >= 14 ? 2 : 1));
};

function fieldMatches(k: keyof Identifiers, r: CustomerRow, v: string): boolean {
  switch (k) {
    case 'customer_id': return normalizeRef(v, 'CUS') === r.customer_id;
    case 'email': return (normalizeSpokenEmail(v) ?? '') === r.contact_email.toLowerCase();
    case 'company_name': return near(v, r.company_name);
    case 'contact_name': return near(v, r.contact_name) || normKey(v) === normKey(r.contact_name.split(/\s+/)[0]);
  }
}

export function matchCustomer(rows: CustomerRow[], ids: Identifiers): MatchResult {
  const provided = (['customer_id', 'email', 'company_name', 'contact_name'] as const).filter((k) => normKey(ids[k]) !== '');
  if (provided.length < 2) return { status: 'need_second_identifier' };
  const hits = rows.filter((r) => provided.every((k) => fieldMatches(k, r, ids[k]!)));
  return hits.length === 1 ? { status: 'matched', customer: hits[0] } : { status: 'no_match' };
}
