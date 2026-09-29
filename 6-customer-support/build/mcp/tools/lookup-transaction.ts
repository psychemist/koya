import { z } from 'zod/v4';
import { one } from '../../lib/db.ts';
import { normalizeRef } from '../../lib/refs.ts';
import { recordNeedsEscalation } from '../../lib/safe-summaries.ts';
import type { ToolSpec } from '../define.ts';

const input = z.object({ transaction_id: z.string().trim().min(1).max(80).describe('The reference the caller gave, as they said it.') });

type Row = { transaction_id: string; customer_id: string; transaction_type: string; status: string; amount: string;
  currency: string; estimated_arrival: string | null; support_summary: string };

export const transactionTool: ToolSpec<typeof input> = {
  name: 'lookup_transaction',
  description: 'Look up a transaction by the reference the caller gave (for example TXN-9001). Say only the status and ' +
    'support_summary in plain words. The amount is returned only when the owning customer is verified on this call.',
  input, readOnly: true,
  async run({ transaction_id }, conversationId) {
    const ref = normalizeRef(transaction_id, 'TXN');
    if (!ref) {
      const result = { found: false, reason: 'unrecognised_reference', message: 'Ask the caller to repeat the reference, for example T X N and four digits.' };
      return { result, summary: result };
    }
    const row = await one<Row>(
      `select transaction_id, customer_id, transaction_type, status, amount::text as amount, currency,
              to_char(estimated_arrival, 'YYYY-MM-DD') as estimated_arrival, support_summary
       from public.transactions where transaction_id = $1`, [ref]);
    const conv = await one<{ verified_customer_id: string | null }>('select verified_customer_id from public.conversations where id = $1', [conversationId]);
    const verified = conv?.verified_customer_id ?? null;
    // Verified as someone else: the same answer as a reference that does not exist, so existence does not leak.
    if (!row || (verified && verified !== row.customer_id)) {
      const result = { found: false, reason: 'not_found', transaction_id: ref };
      return { result, summary: result };
    }
    const owner = verified === row.customer_id;
    const result = {
      found: true, transaction_id: row.transaction_id, customer_id: owner ? row.customer_id : null, type: row.transaction_type,
      status: row.status, amount: owner ? row.amount : null, currency: owner ? row.currency : null,
      estimated_arrival: row.estimated_arrival, support_summary: row.support_summary,
      escalation_required: recordNeedsEscalation(row.status), ticket_recommended: ['failed', 'delayed'].includes(row.status),
      verification: owner ? 'customer_verified' : 'reference_only',
    };
    return { result, summary: result };
  },
};
