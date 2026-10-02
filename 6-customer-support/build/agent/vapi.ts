import type { Channel } from '../lib/conversations.ts';

type Msg = { role?: string; content?: unknown };
const textOf = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? '').join(' ') : '').trim();

/** The support page starts a web call with its signed caller token in the call metadata. Vapi echoes it on the call object. */
const callerTokenOf = (call: any): string | null =>
  call?.metadata?.rp_caller ?? call?.assistantOverrides?.metadata?.rp_caller ?? null;

/**
 * Vapi sends the whole history every turn. Only the user text after the last
 * assistant message is new; everything before it is context, used only when
 * the warm session was lost (a deploy mid-call) and has to be rebuilt.
 */
export function parseChatRequest(body: any, url?: URL) {
  const callId: string | null = body?.call?.id ?? body?.metadata?.callId ?? url?.searchParams.get('callId') ?? null;
  const msgs: Msg[] = (Array.isArray(body?.messages) ? body.messages : []).filter((m: Msg) => m.role === 'user' || m.role === 'assistant');
  let lastAssistant = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
  // The new utterance is the trailing run of user messages; everything before it is context,
  // and it only counts as a prior transcript if the caller has spoken in it.
  const fresh = msgs.slice(lastAssistant + 1);
  const head = msgs.slice(0, lastAssistant + 1);
  const prior = head.some((m) => m.role === 'user')
    ? head.slice(-12).map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${textOf(m.content)}`).join('\n') : '';
  return {
    callId, callType: (body?.call?.type as string | undefined) ?? null,
    newUserText: fresh.map((m) => textOf(m.content)).filter(Boolean).join(' '),
    prior, customerNumber: (body?.call?.customer?.number as string | undefined) ?? null,
    callerToken: callerTokenOf(body?.call) ?? body?.metadata?.rp_caller ?? null,
  };
}

/** Server messages arrive nested under `message`, and in older payloads flat. Both are read. */
export function parseServerMessage(body: any) {
  const m = body?.message ?? body ?? {};
  return {
    type: String(m.type ?? ''), callId: (m.call?.id as string | undefined) ?? null, status: m.status as string | undefined,
    callType: m.call?.type as string | undefined, customerNumber: (m.call?.customer?.number as string | undefined) ?? null,
    endedReason: m.endedReason as string | undefined, callerToken: callerTokenOf(m.call),
  };
}

export const channelFor = (callType: string | null | undefined): Extract<Channel, 'voice_web' | 'voice_phone'> =>
  /phone/i.test(callType ?? '') ? 'voice_phone' : 'voice_web';

/** Stored as the last four digits only (spec §13 minimisation). */
export const maskNumber = (n: string) => `***${n.replace(/\D/g, '').slice(-4)}`;
