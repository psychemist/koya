import { one, query } from './db.ts';
import type { Caller } from './caller.ts';

export type CallerMode = 'customer' | 'guest' | null;

/**
 * Attaches the signed-in caller to a conversation, once. A conversation never
 * changes hands: a different caller arriving on it is a mismatch, and the chat
 * starts a new conversation instead. A signed-in customer is verified here,
 * from the sign-in, so lookup_customer never has to ask who they are.
 */
export async function bindCaller(conversationId: string, caller: Caller): Promise<'bound' | 'same' | 'mismatch'> {
  const customerId = caller.mode === 'customer' ? caller.customerId : null;
  if (customerId && !(await one('select 1 from public.customers where customer_id = $1', [customerId]))) return 'mismatch';
  const set = await one<{ id: string }>(
    `update public.conversations set caller_mode = $2, verified_customer_id = coalesce($3, verified_customer_id)
     where id = $1 and caller_mode is null and (verified_customer_id is null or verified_customer_id = $3) returning id`,
    [conversationId, caller.mode, customerId]);
  if (set) {
    await query(`insert into public.conversation_events (conversation_id, event_type, source, summary) values ($1, $2, 'system', $3)`,
      [conversationId, customerId ? 'identity_verified' : 'guest_session',
       customerId ? `${customerId} signed in on the support page` : 'guest on the support page: knowledge base only']).catch(() => undefined);
    return 'bound';
  }
  const now = await one<{ caller_mode: CallerMode; verified_customer_id: string | null }>(
    'select caller_mode, verified_customer_id from public.conversations where id = $1', [conversationId]);
  return now?.caller_mode === caller.mode && (now.verified_customer_id ?? null) === customerId ? 'same' : 'mismatch';
}

/** What the tools need to know about the caller on this conversation. */
export async function callerOf(conversationId: string): Promise<{ mode: CallerMode; verifiedCustomerId: string | null; channel: string | null }> {
  const r = await one<{ caller_mode: CallerMode; verified_customer_id: string | null; channel: string | null }>(
    'select caller_mode, verified_customer_id, channel from public.conversations where id = $1', [conversationId]);
  return { mode: r?.caller_mode ?? null, verifiedCustomerId: r?.verified_customer_id ?? null, channel: r?.channel ?? null };
}

/**
 * A call has no sign-in, so a caller on one is nobody in particular until lookup_customer matches them on two
 * identifiers. Until then a transaction or payout reference tells them nothing: the support page refuses a guest the
 * same way, and anyone can read a reference off an invoice.
 */
export function refusalFor(c: { mode: CallerMode; verifiedCustomerId: string | null; channel: string | null }) {
  if (c.mode === 'guest') return GUEST_REFUSAL;
  if (!c.verifiedCustomerId && (c.channel === 'voice_phone' || c.channel === 'voice_web')) return IDENTITY_FIRST;
  return null;
}

/** Said the same way for a record that exists and one that does not. */
export const IDENTITY_FIRST = {
  found: false, reason: 'identity_required',
  message: 'The caller is not verified yet, so nothing about this record can be shared. Keep the reference, ask for two ' +
    'identifiers (contact name, company name, account email or customer ID), call lookup_customer, then look the reference up again.',
};

/** The tools' answer to a guest asking for account data. Said the same way for a record that exists and one that does not. */
export const GUEST_REFUSAL = {
  found: false, reason: 'guest',
  message: 'The caller is a guest, so account, transaction and payout details are not available. Tell them to sign in on the ' +
    'support page with their account email and customer ID, or offer a specialist.',
};
