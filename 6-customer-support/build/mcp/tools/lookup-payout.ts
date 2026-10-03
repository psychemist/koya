import { z } from 'zod/v4';
import { one } from '../../lib/db.ts';
import { normalizeRef } from '../../lib/refs.ts';
import { payoutSupportSummary, recordNeedsEscalation } from '../../lib/safe-summaries.ts';
import { callerOf, refusalFor } from '../../lib/caller-binding.ts';
import type { ToolSpec } from '../define.ts';

const input = z.object({
  payout_id: z.string().trim().max(80).optional().describe('The payout reference, for example PAY-7002.'),
  transaction_id: z.string().trim().max(80).optional().describe('Or the transaction the payout belongs to.'),
}).refine((a) => !!(a.payout_id || a.transaction_id), { message: 'Give payout_id or transaction_id.' });

type Row = { payout_id: string; customer_id: string; recipient_name: string; status: string; scheduled_for: string | null; failure_reason: string | null };

export const payoutTool: ToolSpec<any> = {
  name: 'lookup_payout',
  description: 'Look up a contractor payout by payout reference or transaction reference. If escalation_required is ' +
    'true, the reply must escalate. The recipient is returned only when the owning customer is verified on this call.',
  input: input as any, readOnly: true,
  async run(args: z.infer<typeof input>, conversationId: string) {
    const refused = refusalFor(await callerOf(conversationId));
    if (refused) return { result: refused, summary: refused };
    const payoutRef = args.payout_id ? normalizeRef(args.payout_id, 'PAY') : null;
    const txnRef = !payoutRef && args.transaction_id ? normalizeRef(args.transaction_id, 'TXN') : null;
    if (!payoutRef && !txnRef) {
      const result = { found: false, reason: 'unrecognised_reference', message: 'Ask the caller to repeat the reference, for example P A Y and four digits.' };
      return { result, summary: result };
    }
    const row = await one<Row>(
      `select payout_id, customer_id, recipient_name, status, to_char(scheduled_for, 'YYYY-MM-DD') as scheduled_for, failure_reason
       from public.payouts where ${payoutRef ? 'payout_id' : 'transaction_id'} = $1`, [payoutRef ?? txnRef]);
    const conv = await one<{ verified_customer_id: string | null }>('select verified_customer_id from public.conversations where id = $1', [conversationId]);
    const verified = conv?.verified_customer_id ?? null;
    if (!row || (verified && verified !== row.customer_id)) {
      const result = { found: false, reason: 'not_found', payout_id: payoutRef, transaction_id: txnRef };
      return { result, summary: result };
    }
    const owner = verified === row.customer_id;
    const result = {
      found: true, payout_id: row.payout_id, status: row.status, scheduled_for: row.scheduled_for, failure_reason: row.failure_reason,
      support_summary: payoutSupportSummary(row), recipient_name: owner ? row.recipient_name : null,
      escalation_required: recordNeedsEscalation(row.status, row.failure_reason), ticket_recommended: ['failed'].includes(row.status),
      verification: owner ? 'customer_verified' : 'reference_only',
    };
    return { result, summary: result };
  },
};
