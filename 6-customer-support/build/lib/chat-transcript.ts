import { one, query } from './db.ts';
import { chatRecords, type ChatRecords } from './chat-records.ts';

const NONE: ChatRecords = { ticket_ref: null, escalation_ref: null, call_booked: false, appointment: null };

/**
 * What a returning chat customer sees. Only a web_text conversation is ever
 * returned: the cookie names a conversation, and even a valid one must never
 * open a call's or an eval's transcript.
 */
export async function chatTranscript(conversationId: string) {
  const c = await one<{ channel: string; ended: boolean }>(
    'select channel, ended_at is not null as ended from public.conversations where id = $1', [conversationId]);
  if (!c || c.channel !== 'web_text') return { turns: [], ended: true, records: NONE };
  const turns = await query<{ you: string; relaypay: string; at: Date }>(
    `select user_transcript as you, assistant_response as relaypay, created_at as at from public.conversation_turns
     where conversation_id = $1 and status <> 'interrupted' order by seq`, [conversationId]);
  return { turns: turns.map((t) => ({ you: t.you, relaypay: t.relaypay, at: new Date(t.at).toISOString() })), ended: c.ended,
    records: await chatRecords(conversationId) };
}
