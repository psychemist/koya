import { z } from 'zod/v4';
import { one } from '../../lib/db.ts';
import { normalizeRef } from '../../lib/refs.ts';
import type { ToolSpec } from '../define.ts';

const PRIORITY_ORDER = ['low', 'normal', 'high', 'urgent'] as const;
const floor = (p: string, min: string) => PRIORITY_ORDER[Math.max(PRIORITY_ORDER.indexOf(p as any), PRIORITY_ORDER.indexOf(min as any))];

const input = z.object({
  customer_id: z.string().max(40).optional().describe('Only a customer verified on this call is attached.'),
  transaction_id: z.string().max(80).optional().describe('The transaction reference the issue is about, if any.'),
  category: z.enum(['payment', 'payout', 'invoice', 'account', 'compliance', 'dispute', 'other']),
  priority: z.enum(PRIORITY_ORDER),
  summary: z.string().trim().min(10).max(500).describe('One or two sentences a specialist can act on.'),
  conversation_id: z.string().max(60).optional().describe('Ignored when the connection names the conversation.'),
});

export const ticketTool: ToolSpec<typeof input> = {
  name: 'create_support_ticket',
  description: 'Log an issue for support follow-up. Asking twice in one conversation for the same category returns the ' +
    'same ticket with deduplicated: true, so it is safe to retry.',
  input, readOnly: false,
  async run(args, conversationId) {
    const conv = await one<{ verified_customer_id: string | null }>('select verified_customer_id from public.conversations where id = $1', [conversationId]);
    // A customer the call has not verified is never attached: the ticket must not become a way to link a stranger to an account.
    const customerId = args.customer_id && normalizeRef(args.customer_id, 'CUS') === conv?.verified_customer_id ? conv!.verified_customer_id : null;
    const txnRef = args.transaction_id ? normalizeRef(args.transaction_id, 'TXN') : null;
    const txnId = txnRef && (await one('select 1 from public.transactions where transaction_id = $1', [txnRef])) ? txnRef : null;
    const priority = ['compliance', 'dispute'].includes(args.category) ? floor(args.priority, 'high') : args.priority;
    const dedupe = `${conversationId}:${args.category}`;
    const inserted = await one<{ ticket_ref: string; priority: string }>(
      `insert into public.support_tickets (conversation_id, customer_id, transaction_id, category, priority, summary, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (dedupe_key) where status <> 'closed' do nothing
       returning ticket_ref, priority`, [conversationId, customerId, txnId, args.category, priority, args.summary, dedupe]);
    const row = inserted ?? (await one<{ ticket_ref: string; priority: string }>(
      `select ticket_ref, priority from public.support_tickets where dedupe_key = $1 and status <> 'closed'`, [dedupe]))!;
    const result = { ticket_id: row.ticket_ref, status: 'open', deduplicated: !inserted, priority: row.priority };
    return { result, summary: result };
  },
};
