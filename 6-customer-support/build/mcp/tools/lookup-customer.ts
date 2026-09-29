import { z } from 'zod/v4';
import { query, one } from '../../lib/db.ts';
import { matchCustomer, normKey, normalizeSpokenEmail, type CustomerRow } from '../../lib/identity.ts';
import { normalizeRef } from '../../lib/refs.ts';
import { safeCustomerSummary, customerNeedsEscalation } from '../../lib/safe-summaries.ts';
import type { ToolSpec } from '../define.ts';

const MAX_FAILURES = 3;
const input = z.object({
  customer_id: z.string().max(40).optional(), email: z.string().max(160).optional(),
  company_name: z.string().max(120).optional(), contact_name: z.string().max(120).optional(),
});

export const customerTool: ToolSpec<typeof input> = {
  name: 'lookup_customer',
  description: 'Find the caller\'s RelayPay account. Needs TWO identifiers the caller gave you that belong to one account: ' +
    'contact name, company name, account email, or customer ID. Never read support_notes aloud.',
  input, readOnly: false, // it writes verification state onto the conversation
  async run(args, conversationId) {
    const conv = await one<{ identity_failures: number }>('select identity_failures from public.conversations where id = $1', [conversationId]);
    if ((conv?.identity_failures ?? 0) >= MAX_FAILURES) {
      const result = { found: false, reason: 'too_many_attempts', message: 'Identity could not be confirmed on this call. Offer a specialist.' };
      return { result, summary: result };
    }
    const candidates = await query<CustomerRow>(
      `select * from public.customers where customer_id = $1 or email_key = $2 or company_key = $3`,
      [normalizeRef(args.customer_id ?? '', 'CUS'), normalizeSpokenEmail(args.email ?? ''), normKey(args.company_name) || null]);
    const m = matchCustomer(candidates, args);
    if (m.status !== 'matched') {
      if (m.status === 'no_match') await query('update public.conversations set identity_failures = identity_failures + 1 where id = $1', [conversationId]);
      await query(`insert into public.conversation_events (conversation_id, event_type, source, summary) values ($1,'identity_failed','system',$2)`,
        [conversationId, m.status]);
      const result = { found: false, reason: m.status, message: m.status === 'need_second_identifier'
        ? 'Ask for one more identifier: account email, company name, contact name or customer ID.'
        : 'No account matches those details together. Do not say which detail was wrong.' };
      return { result, summary: result };
    }
    const c = m.customer;
    await query('update public.conversations set verified_customer_id = $2 where id = $1', [conversationId, c.customer_id]);
    await query(`insert into public.conversation_events (conversation_id, event_type, source, summary) values ($1,'identity_verified','system',$2)`,
      [conversationId, c.customer_id]);
    const result = { found: true, customer_id: c.customer_id, company_name: c.company_name, plan: c.plan,
      account_status: c.account_status, kyc_status: c.kyc_status, support_notes: c.support_notes, support_notes_internal: true,
      safe_summary: safeCustomerSummary(c), escalation_required: customerNeedsEscalation(c), verification: 'two_identifiers' };
    return { result, summary: result };
  },
};
