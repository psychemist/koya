import { one } from './db.ts';

export type Channel = 'voice_web' | 'voice_phone' | 'web_text' | 'eval' | 'mcp_direct';
export type FinalStatus = 'resolved' | 'clarified' | 'ticketed' | 'escalated' | 'declined' | 'abandoned' | 'failed';

export type ConversationRow = {
  id: string; vapi_call_id: string | null; channel: Channel; caller_identifier: string | null;
  verified_customer_id: string | null; model: string | null; started_at: Date; ended_at: Date | null;
  ended_reason: string | null; final_status: FinalStatus | null; summary: string | null; turn_count: number;
  cost_usd: string; identity_failures: number; eval_run_id: string | null;
};

/**
 * One conversation per Vapi call, however many webhooks arrive and in whatever
 * order: the events webhook and the first custom-llm request race, and both
 * upsert on vapi_call_id. A null call id (chat, eval, MCP direct) always inserts.
 */
export async function upsertConversation(i: { vapiCallId?: string | null; channel: Channel; callerIdentifier?: string | null;
  model?: string | null; evalRunId?: string | null }): Promise<ConversationRow> {
  if (i.vapiCallId) {
    const row = await one<ConversationRow>(
      `insert into public.conversations (vapi_call_id, channel, caller_identifier, model)
       values ($1,$2,$3,$4)
       on conflict (vapi_call_id) do update set caller_identifier = coalesce(public.conversations.caller_identifier, excluded.caller_identifier)
       returning *`, [i.vapiCallId, i.channel, i.callerIdentifier ?? null, i.model ?? null]);
    return row!;
  }
  return (await one<ConversationRow>(
    `insert into public.conversations (channel, caller_identifier, model, eval_run_id) values ($1,$2,$3,$4) returning *`,
    [i.channel, i.callerIdentifier ?? null, i.model ?? null, i.evalRunId ?? null]))!;
}
