import { one, query } from '../lib/db.ts';
import { normalizeSpokenEmail } from '../lib/identity.ts';
import type { TurnFacts } from '../lib/gates/reply.ts';

/**
 * What the gates may rely on, read from the rows the MCP server wrote, never
 * from what the model says it did. "Grounded on this turn" means a search
 * logged at or after `since`, which is the database clock at the turn's start.
 */
export async function loadTurnFacts(conversationId: string, since: Date, currentText: string): Promise<TurnFacts> {
  const calls = await query<{ tool_name: string; input_summary: any; result_summary: any; created_at: Date }>(
    `select tool_name, input_summary, result_summary, created_at from public.tool_calls
     where conversation_id = $1 and status = 'ok' order by created_at`, [conversationId]);
  const turn = calls.filter((c) => c.created_at >= since);
  const conv = await one<{ verified_customer_id: string | null }>('select verified_customer_id from public.conversations where id = $1', [conversationId]);
  const said = await query<{ user_transcript: string }>('select user_transcript from public.conversation_turns where conversation_id = $1 order by seq', [conversationId]);
  const emails = calls.flatMap((c) => [c.input_summary?.email, c.input_summary?.user_email]).filter(Boolean)
    .map((e: string) => normalizeSpokenEmail(e)).filter((e): e is string => !!e);
  return {
    groundedChunkIds: new Set(turn.filter((c) => c.tool_name === 'search_knowledge_base')
      .flatMap((c) => (c.result_summary?.chunks ?? []).filter((ch: any) => ch.grounded).map((ch: any) => ch.id))),
    escalationRequired: turn.some((c) => c.result_summary?.escalation_required === true),
    // Only what a lookup FOUND on this turn. A reference the caller said, or one that came back not_found, grounds nothing.
    recordRefs: new Set(turn.filter((c) => /^lookup_/.test(c.tool_name) && c.result_summary?.found === true)
      .flatMap((c) => [c.result_summary.transaction_id, c.result_summary.payout_id, c.result_summary.customer_id])
      .filter((x): x is string => typeof x === 'string' && /^(TXN|PAY|CUS)-\d{4}$/.test(x))),
    supportNotes: calls.filter((c) => c.tool_name === 'lookup_customer' && c.result_summary?.found)
      .map((c) => String(c.result_summary.support_notes ?? '')).filter(Boolean),
    callerText: [...said.map((s) => s.user_transcript), currentText].join('\n'),
    knownEmails: emails,
    verifiedCustomerId: conv?.verified_customer_id ?? null,
  };
}
