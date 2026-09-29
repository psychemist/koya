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

function fieldMatches(k: keyof Identifiers, r: CustomerRow, v: string): boolean {
  switch (k) {
    case 'customer_id': return normalizeRef(v, 'CUS') === r.customer_id;
    case 'email': return (normalizeSpokenEmail(v) ?? '') === r.contact_email.toLowerCase();
    case 'company_name': return normKey(v) === normKey(r.company_name);
    case 'contact_name': {
      const given = normKey(v);
      return given === normKey(r.contact_name) || given === normKey(r.contact_name.split(/\s+/)[0]);
    }
  }
}

export function matchCustomer(rows: CustomerRow[], ids: Identifiers): MatchResult {
  const provided = (['customer_id', 'email', 'company_name', 'contact_name'] as const).filter((k) => normKey(ids[k]) !== '');
  if (provided.length < 2) return { status: 'need_second_identifier' };
  const hits = rows.filter((r) => provided.every((k) => fieldMatches(k, r, ids[k]!)));
  return hits.length === 1 ? { status: 'matched', customer: hits[0] } : { status: 'no_match' };
}
