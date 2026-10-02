import { config } from '../../../lib/config.ts';
import { foreignOrigin } from '../../../lib/auth.ts';
import { chatCookie, clearChatCookie, CHAT_COOKIE, issueChatToken, readChatToken } from '../../../lib/chat-session.ts';
import { chatTranscript } from '../../../lib/chat-transcript.ts';
import { createLimiter } from '../../../lib/rate-limit.ts';
import { endAgentChat } from '../../../lib/agent-client.ts';
import { feedbackCookie } from '../../../lib/feedback.ts';
import { CALLER_COOKIE, cookieFrom, readCallerCookie, type Caller } from '../../../lib/caller.ts';

export const dynamic = 'force-dynamic';

const limiter = createLimiter({ perWindow: 20, windowMs: 10 * 60_000 });
const UNAVAILABLE = 'Chat is unavailable right now. Please try again in a few minutes, or contact support through your RelayPay dashboard.';
const secure = () => config.web.baseUrl.startsWith('https://');
const json = (status: number, body: unknown, cookie?: string) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } });

const cookieToken = (req: Request) => cookieFrom(req.headers.get('cookie'), CHAT_COOKIE);
const callerOf = (req: Request) => readCallerCookie(cookieFrom(req.headers.get('cookie'), CALLER_COOKIE));
const callerBody = (c: Caller) => (c.mode === 'customer' ? { mode: 'customer', customer_id: c.customerId } : { mode: 'guest' });
const NO_CALLER = 'Sign in or continue as a guest to start a chat.';
const ipOf = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
/** A browser on another site may not drive this chat. */
const foreign = foreignOrigin;

async function askAgent(body: object): Promise<{ status: number; json: any } | null> {
  try {
    const res = await fetch(`${config.web.agentUrl}/chat`, { method: 'POST', signal: AbortSignal.timeout(75_000),   // a turn with lookups can outlast 30 s; the page recovers late replies too
      headers: { authorization: `Bearer ${config.agent.internalToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch { return null; }
}

/**
 * One chat message. The browser never sends or receives a conversation id:
 * the conversation lives in a signed, httpOnly cookie, so a pasted id cannot
 * continue somebody else's verified conversation.
 */
export async function POST(req: Request): Promise<Response> {
  if (foreign(req)) return json(403, { error: 'This chat only accepts messages from the RelayPay support page.' });
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(415, { error: 'Send the message as JSON.' });
  let message: unknown;
  try { message = ((await req.json()) as { message?: unknown }).message; } catch { return json(400, { error: 'Please type a message.' }); }
  if (typeof message !== 'string' || !message.trim()) return json(400, { error: 'Please type a message.' });
  if (message.length > 1000) return json(400, { error: 'Please keep your message under 1,000 characters.' });
  const caller = callerOf(req);
  if (!caller) return json(401, { error: NO_CALLER, signed_out: true });
  if (!limiter.take(ipOf(req))) return json(429, { error: "You're sending messages quickly. Please wait a minute and try again." });

  const current = readChatToken(cookieToken(req));
  let r = await askAgent({ conversation_id: current ?? undefined, message, channel: 'web_text', caller: callerBody(caller) });
  let newChat = false;
  if (current && r && (r.status === 404 || r.status === 409)) {
    // The old chat ended, is not a chat, or belongs to whoever was signed in before: start a fresh one.
    r = await askAgent({ message, channel: 'web_text', caller: callerBody(caller) });
    newChat = true;
  }
  if (!r || r.status !== 200 || !r.json?.conversation_id) return json(503, { error: UNAVAILABLE });
  const { reply, answer_type, ended, records } = r.json;
  return json(200, { reply, answer_type, ended: !!ended, records, new_chat: newChat }, chatCookie(issueChatToken(r.json.conversation_id), secure()));
}

/** The transcript for this browser's chat, so a refresh or a return visit shows what was said. */
export async function GET(req: Request): Promise<Response> {
  const id = readChatToken(cookieToken(req));
  if (!id || !callerOf(req)) return json(200, { turns: [], ended: false, records: null });
  try { return json(200, await chatTranscript(id)); } catch { return json(503, { error: UNAVAILABLE }); }
}

/** End chat. Always clears the cookie; if the agent cannot be told, the idle sweep ends the conversation anyway. */
export async function DELETE(req: Request): Promise<Response> {
  if (foreign(req)) return json(403, { error: 'This chat only accepts messages from the RelayPay support page.' });
  const id = readChatToken(cookieToken(req));
  if (id) await endAgentChat(id, 'customer-ended-chat');
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', clearChatCookie(secure()));
  // The chat is over, but the feedback asked next still needs to know which chat it is about.
  if (id) headers.append('set-cookie', feedbackCookie(issueChatToken(id), secure()));
  return new Response(null, { status: 204, headers });
}
