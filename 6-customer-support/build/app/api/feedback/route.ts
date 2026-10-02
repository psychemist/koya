import { foreignOrigin } from '../../../lib/auth.ts';
import { one } from '../../../lib/db.ts';
import { createLimiter } from '../../../lib/rate-limit.ts';
import { CALLER_COOKIE, cookieFrom, readCallerCookie } from '../../../lib/caller.ts';
import { CHAT_COOKIE, readChatToken } from '../../../lib/chat-session.ts';
import { FEEDBACK_COOKIE } from '../../../lib/feedback.ts';

export const dynamic = 'force-dynamic';

const limiter = createLimiter({ perWindow: 20, windowMs: 10 * 60_000 });
const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const ipOf = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';

/**
 * How a call or a chat went, from the person who had it. A web call is named by its Vapi call id, which only the
 * page that started it knows; a chat by the signed chat cookie, or the one kept for feedback when the chat ended.
 * One answer per call or chat; sending again changes it.
 */
export async function POST(req: Request): Promise<Response> {
  if (foreignOrigin(req)) return json(403, { error: 'Feedback is only accepted from the RelayPay support page.' });
  const caller = readCallerCookie(cookieFrom(req.headers.get('cookie'), CALLER_COOKIE));
  if (!caller) return json(401, { error: 'Sign in or continue as a guest first.' });
  if (!limiter.take(ipOf(req))) return json(429, { error: 'Too much feedback at once. Try again in a few minutes.' });
  const b = (await req.json().catch(() => ({}))) as { channel?: unknown; call_id?: unknown; rating?: unknown; comment?: unknown };
  if (b.rating !== 'good' && b.rating !== 'bad') return json(400, { error: 'Choose whether it helped.' });
  const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 500) : null;
  const customerId = caller.mode === 'customer' ? caller.customerId : null;
  try {
    if (b.channel === 'voice_web') {
      const callId = typeof b.call_id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(b.call_id) ? b.call_id : null;
      if (!callId) return json(400, { error: 'That call could not be found.' });
      const conv = await one<{ id: string }>(`select id from public.conversations where vapi_call_id = $1 and channel = 'voice_web'`, [callId]);
      await one(`insert into public.feedback (channel, vapi_call_id, conversation_id, caller_mode, customer_id, rating, comment)
        values ('voice_web', $1, $2, $3, $4, $5, $6)
        on conflict (vapi_call_id) where vapi_call_id is not null do update set rating = excluded.rating, comment = excluded.comment,
          conversation_id = coalesce(public.feedback.conversation_id, excluded.conversation_id), updated_at = now()`,
        [callId, conv?.id ?? null, caller.mode, customerId, b.rating, comment]);
      return json(200, { saved: true });
    }
    if (b.channel === 'web_text') {
      const cookies = req.headers.get('cookie');
      const conv = readChatToken(cookieFrom(cookies, CHAT_COOKIE)) ?? readChatToken(cookieFrom(cookies, FEEDBACK_COOKIE));
      if (!conv) return json(400, { error: 'That chat could not be found.' });
      await one(`insert into public.feedback (channel, conversation_id, caller_mode, customer_id, rating, comment)
        values ('web_text', $1, $2, $3, $4, $5)
        on conflict (conversation_id) where channel = 'web_text' do update set rating = excluded.rating, comment = excluded.comment, updated_at = now()`,
        [conv, caller.mode, customerId, b.rating, comment]);
      return json(200, { saved: true });
    }
    return json(400, { error: 'Say whether this was a call or a chat.' });
  } catch {
    return json(503, { error: 'Your feedback was not saved. Try again in a moment.' });
  }
}
