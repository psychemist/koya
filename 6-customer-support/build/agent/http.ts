import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../lib/config.ts';
import { dbHealthy, one, query } from '../lib/db.ts';
import { LINES } from '../lib/lines.ts';
import { finalizeConversation, upsertConversation, type Channel } from '../lib/conversations.ts';
import { openSse } from './sse.ts';
import type { Prefetch } from './prefetch.ts';
import { channelFor, maskNumber, parseChatRequest, parseServerMessage } from './vapi.ts';
import { collectSink, runTurn } from './turn.ts';
import { endsChat, priorFromTurns } from './chat.ts';
import { chatRecords } from '../lib/chat-records.ts';
import type { SessionManager } from './sessions.ts';
import { readCallToken, type Caller } from '../lib/caller.ts';
import { bindCaller } from '../lib/caller-binding.ts';

const MAX_MESSAGE = 1000;
const MAX_BODY = 256 * 1024;

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

function secretMatches(given: string | undefined, want: string): boolean {
  const a = Buffer.from(given ?? ''), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
const bearer = (req: IncomingMessage) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

/** The web server's word for who is chatting, behind the internal token. Only the web page sends it. */
function parseCaller(v: any): Caller | null {
  if (v?.mode === 'guest') return { mode: 'guest' };
  if (v?.mode === 'customer' && typeof v.customer_id === 'string' && /^CUS-\d{4,}$/.test(v.customer_id)) return { mode: 'customer', customerId: v.customer_id };
  return null;
}

/** A web call carries the caller's signed token through Vapi. A missing or bad token leaves the call on the two-identifier flow. */
async function bindCallToken(conversationId: string, channel: string, token: unknown) {
  const caller = channel === 'voice_web' ? readCallToken(token) : null;
  if (caller) await bindCaller(conversationId, caller).catch(() => undefined);
}

const systemEvent = (conversationId: string, type: string, summary: string, metadata: object = {}) =>
  query(`insert into public.conversation_events (conversation_id, event_type, source, summary, metadata) values ($1,$2,'system',$3,$4)`,
    [conversationId, type, summary.slice(0, 500), JSON.stringify(metadata)]).catch(() => undefined);

/**
 * The agent service. Vapi treats it as the LLM (custom-llm) and tells it about
 * the call through the events webhook; the web page and the eval harness use
 * /chat. Every route that runs a turn goes through runTurn, so voice and text
 * pass the same gates.
 */
export function createAgentServer(deps: { sessions: SessionManager; prefetch?: Prefetch }): Server & { drain(): Promise<void> } {
  const { sessions, prefetch } = deps;
  const background = new Set<Promise<unknown>>();
  const later = (p: Promise<unknown>) => { const q = p.catch((e) => console.error(JSON.stringify({ level: 'error', at: 'agent_bg', message: e.message })));
    background.add(q); q.finally(() => background.delete(q)); };
  const full = (id: string) => sessions.size >= sessions.max && !sessions.has(id);
  /** A full pool first asks an idle chat to give its slot up (Task 14b); only then is anyone refused. */
  const hasRoom = async (id: string) => !full(id) || (await sessions.evictOneIdle('chat')) || !full(id);

  async function vapiCompletion(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!secretMatches(bearer(req), config.vapi.customLlmKey)) return json(res, 401, { error: 'unauthorized' });
    const body = await readJson(req);
    const p = parseChatRequest(body, url);
    if (!p.callId) return json(res, 400, { error: 'no call id' });
    const conv = await upsertConversation({ vapiCallId: p.callId, channel: channelFor(p.callType),
      callerIdentifier: p.customerNumber ? maskNumber(p.customerNumber) : 'web' });
    await bindCallToken(conv.id, conv.channel, p.callerToken);
    const sse = openSse(res);
    if (!(await hasRoom(conv.id))) {
      sse.say(`${LINES.capacity} ${LINES.goodbye}`); sse.finish();
      await systemEvent(conv.id, 'capacity_refused', `refused at ${sessions.size} of ${sessions.max} sessions`);
      return;
    }
    const recovering = !sessions.has(conv.id) && !!p.prior;
    await sessions.interruptInFlight(conv.id);
    if (recovering) await systemEvent(conv.id, 'session_recovered', 'warm session missing; rebuilt from the call history');
    const turn = runTurn({ sessions, prefetch }, { conversationId: conv.id, text: p.newUserText, prior: recovering ? p.prior : undefined }, sse);
    later(turn);
    try { await turn; } finally { sse.finish(); }
  }

  async function vapiEvent(req: IncomingMessage, res: ServerResponse) {
    // Either header carries the secret: X-Vapi-Secret from a custom-header credential, or
    // Authorization: Bearer from a Bearer Token credential. Both are compared in constant time.
    const hook = config.vapi.webhookSecret;
    const viaHeader = secretMatches(req.headers['x-vapi-secret'] as string | undefined, hook);
    const viaBearer = /^Bearer\s+/i.test(req.headers.authorization ?? '') && secretMatches(bearer(req), hook);
    if (!viaHeader && !viaBearer) return json(res, 401, { error: 'unauthorized' });
    const m = parseServerMessage(await readJson(req));
    json(res, 200, {});                                   // Vapi is answered first; the work happens after.
    if (!m.callId) return;
    if (m.type === 'status-update' && m.status === 'in-progress') {
      later((async () => {
        const conv = await upsertConversation({ vapiCallId: m.callId, channel: channelFor(m.callType),
          callerIdentifier: m.customerNumber ? maskNumber(m.customerNumber) : 'web' });
        await bindCallToken(conv.id, conv.channel, m.callerToken);
        if (sessions.has(conv.id) || !(await hasRoom(conv.id))) return;
        await sessions.getOrOpen(conv.id, { kind: 'voice' });             // opened while Vapi speaks the first message
        await systemEvent(conv.id, 'session_opened', 'session opened on call start');
      })());
    } else if (m.type === 'end-of-call-report') {
      later((async () => {
        const conv = await one<{ id: string }>('select id from public.conversations where vapi_call_id = $1', [m.callId]);
        if (!conv) return;
        await sessions.settle(conv.id, 10_000);        // Review Focus 4: the in-flight turn records first
        await finalizeConversation(conv.id, { endedReason: m.endedReason ?? 'ended' });
        await sessions.close(conv.id);
        await systemEvent(conv.id, 'session_closed', `call ended: ${m.endedReason ?? 'ended'}`);
      })());
    } else if (m.type === 'user-interrupted') {
      later((async () => {
        const conv = await one<{ id: string }>('select id from public.conversations where vapi_call_id = $1', [m.callId]);
        if (conv) await systemEvent(conv.id, 'interrupted', 'caller interrupted the agent');
      })());
    }
  }

  async function chat(req: IncomingMessage, res: ServerResponse) {
    if (!secretMatches(bearer(req), config.agent.internalToken)) return json(res, 401, { error: 'unauthorized' });
    const b = await readJson(req);
    // Review Focus 5: refused at the edge, before any row or model call.
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) return json(res, 400, { error: 'Please type a message.' });
    if (message.length > MAX_MESSAGE) return json(res, 400, { error: 'Please keep your message under 1,000 characters.' });
    if (b.channel !== 'web_text' && b.channel !== 'eval') return json(res, 400, { error: 'channel must be web_text or eval' });
    const channel = b.channel as Extract<Channel, 'web_text' | 'eval'>;
    const model = channel === 'eval' && (config.models.allowed as readonly string[]).includes(b.model) ? b.model as string : undefined;
    const caller = parseCaller(b.caller);
    if (b.caller !== undefined && !caller) return json(res, 400, { error: 'caller must be a guest or a customer_id' });
    const mcpFault = config.agent.allowFaults && (b.fault === 'mcp_down' || b.fault === 'calendar_down') ? b.fault as 'mcp_down' | 'calendar_down' : null;
    // 1 and 2. A chat continues only its own kind of conversation, and never one that has ended.
    let id: string;
    if (b.conversation_id) {
      const c = await one<{ id: string; channel: string; ended: boolean }>(
        'select id, channel, ended_at is not null as ended from public.conversations where id::text = $1', [String(b.conversation_id)]);
      if (!c || c.channel !== channel) return json(res, 404, { error: 'conversation_unknown' });
      if (c.ended) return json(res, 409, { error: 'conversation_ended' });
      id = c.id;
      // A chat belongs to whoever started it. Someone else signed in on this browser gets a new one.
      if (caller && (await bindCaller(id, caller)) === 'mismatch') return json(res, 409, { error: 'conversation_caller_changed' });
    } else {
      id = (await upsertConversation({ channel, callerIdentifier: channel === 'eval' ? String(b.eval_run_id ?? 'eval') : 'web',
        model: model ?? null, evalRunId: channel === 'eval' && b.eval_run_id ? String(b.eval_run_id) : null })).id;
      if (caller && (await bindCaller(id, caller)) === 'mismatch') return json(res, 400, { error: 'caller_unknown' });
    }
    // 3. A session that is gone is rebuilt from what was said, the same way a call is rebuilt from Vapi's history.
    let prior: string | undefined;
    if (!sessions.has(id)) {
      const turns = await query<{ user_transcript: string; assistant_response: string }>(
        'select user_transcript, assistant_response from public.conversation_turns where conversation_id = $1 order by seq', [id]);
      prior = priorFromTurns(turns) || undefined;
    }
    // 4. Room, or the capacity line.
    if (!(await hasRoom(id))) return json(res, 200, { conversation_id: id, reply: LINES.capacity, answer_type: 'decline', status: 'capacity',
      ended: false, records: await chatRecords(id) });
    // 5. The same turn as a call. Eval is framed as voice, because the brief grades the voice agent.
    await sessions.getOrOpen(id, { model, mcpFault, kind: 'chat' });
    const sink = collectSink();
    const turn = runTurn({ sessions, prefetch }, { conversationId: id, text: message, prior, channel: channel === 'eval' ? 'voice' : 'chat' }, sink);
    later(turn);
    const out = await turn;
    const reply = sink.reply();
    // 6. The chat goodbye ends the conversation, as the end-call phrase ends a call.
    const ended = channel === 'web_text' && endsChat(reply);
    if (ended) { await finalizeConversation(id, { endedReason: 'customer-ended-chat' }); await sessions.close(id); }
    // 7. References from rows, so what the page shows exists.
    json(res, 200, { conversation_id: id, reply, answer_type: out.answerType, status: out.status, ended, records: await chatRecords(id) });
  }

  async function chatEnd(req: IncomingMessage, res: ServerResponse) {
    if (!secretMatches(bearer(req), config.agent.internalToken)) return json(res, 401, { error: 'unauthorized' });
    const b = await readJson(req);
    const c = await one<{ id: string }>('select id from public.conversations where id::text = $1', [String(b.conversation_id ?? '')]);
    if (!c) return json(res, 404, { error: 'conversation_unknown' });
    await sessions.settle(c.id, 10_000);
    const row = await finalizeConversation(c.id, { endedReason: b.reason ?? 'chat_ended' });
    await sessions.close(c.id);
    json(res, 200, { conversation_id: c.id, final_status: row.final_status });
  }

  async function health(res: ServerResponse) {
    let mcp = false;
    try { const r = await fetch(config.agent.mcpUrl.replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(2000) }); mcp = r.ok; } catch { mcp = false; }
    const db = await dbHealthy();
    json(res, db && mcp ? 200 : 503, { ok: db && mcp, db, mcp, sessions: sessions.size, capacity: Math.max(0, sessions.max - sessions.size) });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://agent.local');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return await health(res);
      if (req.method !== 'POST') return json(res, 404, { error: 'not_found' });
      if (url.pathname === '/vapi/chat/completions' || url.pathname === '/vapi') return await vapiCompletion(req, res, url);
      if (url.pathname === '/vapi/events') return await vapiEvent(req, res);
      if (url.pathname === '/chat') return await chat(req, res);
      if (url.pathname === '/chat/end') return await chatEnd(req, res);
      return json(res, 404, { error: 'not_found' });
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'error', at: 'agent_http', path: url.pathname, message: e?.message }));
      if (!res.headersSent) json(res, e?.status ?? 500, { error: e?.status ? e.message : 'internal' });
      else try { res.end(); } catch { /* gone */ }
    }
  }) as Server & { drain(): Promise<void> };
  server.drain = async () => { while (background.size) await Promise.all([...background]); };
  return server;
}
