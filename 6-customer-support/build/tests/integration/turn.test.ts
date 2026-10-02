import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { LINES, FILLERS } from '../../lib/lines.ts';
import { runTurn } from '../../agent/turn.ts';
import { SessionManager } from '../../agent/sessions.ts';
import { fakeRuntime, logToolCall } from '../fakes/runtime.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

const sink = () => { const said: string[] = []; return { said, say: (t: string) => said.push(t) }; };
const ok = (output: object) => ({ kind: 'result', ok: true, output, costUsd: 0.001, durationMs: 10 }) as const;
const answer = (citations: string[]) => ({ answer_type: 'answer', spoken_response: 'Fees vary by corridor and payment method, and you see them before you confirm.',
  citations, confidence_note: 'fees faq', escalation_category: null });

test('a grounded answer is spoken, after the filler, and written as one ok turn', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const rt = fakeRuntime([async () => { await logToolCall(c.id, 'search_knowledge_base', { grounded: true, chunks: [{ id: 'faq/fees', grounded: true }] });
    return [{ kind: 'tool_start', tool: 'mcp__relaypay__search_knowledge_base' }, ok(answer(['faq/fees']))]; }]);
  const s = sink();
  const r = await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'what fees do you charge' }, s);
  assert.equal(r.status, 'ok');
  assert.equal(s.said.length, 2);
  assert.ok((FILLERS.knowledge as readonly string[]).includes(s.said[0]), s.said[0]);   // the search that started picks the line
  assert.equal(s.said[1], answer([]).spoken_response);
  const [t] = await query('select seq, answer_type, citations, status from public.conversation_turns where conversation_id=$1', [c.id]);
  assert.deepEqual(t, { seq: 1, answer_type: 'answer', citations: ['faq/fees'], status: 'ok' });
  await dropConversation(c.id);
});

test('an answer citing the transaction a lookup found on this turn is spoken, with no knowledge search needed', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const rt = fakeRuntime([async () => { await logToolCall(c.id, 'lookup_transaction', { found: true, transaction_id: 'TXN-9001', status: 'processing' });
    return [{ kind: 'tool_start', tool: 'mcp__relaypay__lookup_transaction' }, ok({ answer_type: 'answer',
      spoken_response: 'TXN-9001 is processing within the normal expected window.', citations: ['TXN-9001'], confidence_note: 'lookup', escalation_category: null })]; }]);
  const r = await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'check TXN-9001' }, sink());
  assert.equal(r.status, 'ok');
  await dropConversation(c.id);
});

test('a lookup that found nothing grounds nothing', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const bad = { answer_type: 'answer', spoken_response: 'TXN-0000 is processing.', citations: ['TXN-0000'], confidence_note: 'x', escalation_category: null };
  const rt = fakeRuntime([async () => { await logToolCall(c.id, 'lookup_transaction', { found: false, reason: 'not_found', transaction_id: 'TXN-0000' }); return [ok(bad)]; }, [ok(bad)]]);
  assert.equal((await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'check TXN-0000' }, sink())).status, 'fallback');
  await dropConversation(c.id);
});

test('an ungrounded answer is retried once with the reason, then the decline line is spoken', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation(); const prompts: string[] = [];
  const rt = fakeRuntime([(p) => { prompts.push(p); return [ok(answer(['faq/invented']))]; }, (p) => { prompts.push(p); return [ok(answer(['faq/invented']))]; }]);
  const s = sink();
  const r = await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'what is your refund window' }, s);
  assert.equal(r.status, 'fallback');
  assert.match(prompts[1], /^\[system check\][\s\S]*G2/);
  assert.equal(s.said.at(-1), LINES.decline);
  const [t] = await query('select gate_result from public.conversation_turns where conversation_id=$1', [c.id]);
  assert.equal(t.gate_result.attempts, 2);
  await dropConversation(c.id);
});

test('a retry that fixes the violation is spoken, not the fallback', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const decline = { answer_type: 'decline', spoken_response: "I can't answer that confidently. I can connect you with a specialist.", citations: [], confidence_note: 'not in kb', escalation_category: null };
  const rt = fakeRuntime([[ok(answer(['faq/invented']))], [ok(decline)]]);
  const s = sink();
  assert.equal((await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'refund window?' }, s)).status, 'ok');
  assert.equal(s.said.at(-1), decline.spoken_response);
  // The console shows why a retry happened; the grader reads only the final attempt's violations.
  const [t] = await query('select gate_result from public.conversation_turns where conversation_id=$1', [c.id]);
  assert.deepEqual([t.gate_result.attempts, t.gate_result.violations, t.gate_result.retried_for.map((v: any) => v.gate)], [2, [], ['G2']]);
  await dropConversation(c.id);
});

test('when a lookup said escalation_required and the agent answered anyway, the escalate line is the fallback', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const bad = { answer_type: 'clarify', spoken_response: 'Can you tell me more?', citations: [], confidence_note: 'x', escalation_category: null };
  const rt = fakeRuntime([async () => { await logToolCall(c.id, 'lookup_payout', { escalation_required: true }); return [ok(bad)]; }, [ok(bad)]]);
  const s = sink();
  await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'what is happening with PAY-7002' }, s);
  assert.equal(s.said.at(-1), LINES.escalate);
  await dropConversation(c.id);
});

test('a failed result speaks the failure line and records a failed turn', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const rt = fakeRuntime([[{ kind: 'result', ok: false, subtype: 'error_during_execution', costUsd: 0, durationMs: 1 }]]);
  const s = sink();
  assert.equal((await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'check TXN-9001' }, s)).status, 'failed');
  assert.equal(s.said.at(-1), LINES.failure);
  await dropConversation(c.id);
});

test('row 24: the same text re-posted within 5 s is answered from the stored turn, with no model call', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation(); let calls = 0;
  const decline = { answer_type: 'decline', spoken_response: "I can't answer that confidently.", citations: [], confidence_note: 'x', escalation_category: null };
  const rt = fakeRuntime([() => { calls++; return [ok(decline)]; }, () => { calls++; return [ok(decline)]; }]);
  const m = new SessionManager(rt);
  await runTurn({ sessions: m }, { conversationId: c.id, text: 'Tax advice?' }, sink());
  const r = await runTurn({ sessions: m }, { conversationId: c.id, text: 'tax advice?' }, sink());
  assert.deepEqual([r.status, calls], ['replayed', 1]);
  const [{ n }] = await query('select count(*) n from public.conversation_turns where conversation_id=$1', [c.id]);
  assert.equal(Number(n), 1);
  await dropConversation(c.id);
});

test('Review Focus 3: noise makes no model call and writes no turn', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation(); let calls = 0;
  const rt = fakeRuntime([() => { calls++; return []; }]);
  const s = sink();
  assert.equal((await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'uh' }, s)).status, 'noise');
  assert.deepEqual([calls, s.said], [0, [LINES.didntCatch]]);
  await dropConversation(c.id);
});


test('two turns on one conversation get consecutive seq numbers, even when posted together', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const m = new SessionManager(fakeRuntime([]));
  await Promise.all([runTurn({ sessions: m }, { conversationId: c.id, text: 'first question' }, sink()),
                     runTurn({ sessions: m }, { conversationId: c.id, text: 'second question' }, sink())]);
  const rows = await query('select seq from public.conversation_turns where conversation_id=$1 order by seq', [c.id]);
  assert.deepEqual(rows.map((r: any) => r.seq), [1, 2]);
  await dropConversation(c.id);
});

test('a turn records its cost on the conversation and in the ledger', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const decline = { answer_type: 'decline', spoken_response: "I can't answer that confidently.", citations: [], confidence_note: 'x', escalation_category: null };
  await runTurn({ sessions: new SessionManager(fakeRuntime([[ok(decline)]])) }, { conversationId: c.id, text: 'tax question' }, sink());
  const [conv] = await query('select turn_count, cost_usd::float8 as cost from public.conversations where id=$1', [c.id]);
  const [l] = await query("select sum(amount_usd)::float8 as s from public.spend_ledger where conversation_id=$1 and provider='anthropic'", [c.id]);
  assert.deepEqual([conv.turn_count, conv.cost, l.s], [1, 0.001, 0.001]);
  await dropConversation(c.id);
});

test('over the daily cap, the capacity line and goodbye are spoken, with no model call', { skip: skipWithoutDatabase }, async () => {
  // The ledger row outlives the conversation (ON DELETE SET NULL), so the low cap must not outlive this test.
  const cap = process.env.DAILY_CLAUDE_CAP_USD; process.env.DAILY_CLAUDE_CAP_USD = '0.30';   // above the per-call budget, so config accepts it
  try {
    const c = await newConversation();
    await query(`insert into public.spend_ledger (provider, amount_usd, conversation_id, note) values ('anthropic', 1.0, $1, 'cap test')`, [c.id]);
    const s = sink();
    const r = await runTurn({ sessions: new SessionManager(fakeRuntime([])) }, { conversationId: c.id, text: 'hello there' }, s);
    assert.equal(r.status, 'capacity');
    assert.equal(s.said.at(-1), `${LINES.capacity} ${LINES.goodbye}`);
    await dropConversation(c.id);
  } finally { if (cap === undefined) delete process.env.DAILY_CLAUDE_CAP_USD; else process.env.DAILY_CLAUDE_CAP_USD = cap; }
});

test('a prefetched search reaches the model in the turn message and grounds the answer with no model tool call', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation(); const prompts: string[] = [];
  const prefetch = async (id: string) => { await logToolCall(id, 'search_knowledge_base', { grounded: true, chunks: [{ id: 'faq/fees', grounded: true }] });
    return '[Knowledge search, already run on this turn for the caller\'s words: grounded true]'; };
  const rt = fakeRuntime([(p) => { prompts.push(p); return [ok(answer(['faq/fees']))]; }]);
  const s = sink();
  const r = await runTurn({ sessions: new SessionManager(rt), prefetch }, { conversationId: c.id, text: 'what fees do you charge' }, s);
  assert.equal(r.status, 'ok');
  assert.match(prompts[0], /Caller said: what fees do you charge\n\[Knowledge search/);
  assert.deepEqual(s.said, [answer([]).spoken_response]);
  await dropConversation(c.id);
});

test('a prefetch that fails leaves the turn to the model, which still answers', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation(); const prompts: string[] = [];
  const rt = fakeRuntime([(p) => { prompts.push(p); return [{ kind: 'result', ok: true, costUsd: 0.001, durationMs: 5, output: { answer_type: 'clarify',
    spoken_response: 'Is that an incoming transfer or an outgoing payout?', citations: [], confidence_note: 'vague', escalation_category: null } }]; }]);
  const r = await runTurn({ sessions: new SessionManager(rt), prefetch: async () => { throw new Error('mcp down'); } },
    { conversationId: c.id, text: 'what about my payment' }, sink());
  assert.equal(r.status, 'ok');
  assert.doesNotMatch(prompts[0], /Knowledge search/);
  await dropConversation(c.id);
});

test('a slow turn speaks the filler before the reply, and the filler never follows the reply', { skip: skipWithoutDatabase }, async () => {
  const before = process.env.AGENT_FILLER_AFTER_MS; process.env.AGENT_FILLER_AFTER_MS = '50';
  try {
    const clarify = { answer_type: 'clarify', spoken_response: 'Is that an incoming transfer or an outgoing payout?', citations: [],
      confidence_note: 'vague', escalation_category: null };
    const c = await newConversation();
    const slow = fakeRuntime([async () => { await new Promise((r) => setTimeout(r, 200)); return [ok(clarify)]; }]);
    const s = sink();
    await runTurn({ sessions: new SessionManager(slow) }, { conversationId: c.id, text: 'my payment is stuck' }, s);
    assert.equal(s.said.length, 2);
    assert.ok((FILLERS.general as readonly string[]).includes(s.said[0]), s.said[0]);
    assert.equal(s.said[1], clarify.spoken_response);
    // A timer longer than the turn: once the reply is out, the moment it would have fired passes in silence.
    process.env.AGENT_FILLER_AFTER_MS = '2500';
    const c2 = await newConversation();
    const s2 = sink(); const t0 = Date.now();
    await runTurn({ sessions: new SessionManager(fakeRuntime([[ok(clarify)]])) }, { conversationId: c2.id, text: 'my payment is stuck' }, s2);
    await new Promise((r) => setTimeout(r, Math.max(0, 2600 - (Date.now() - t0))));
    assert.equal(s2.said.at(-1), clarify.spoken_response);
    assert.ok(s2.said.length <= 2);
    await dropConversation(c.id); await dropConversation(c2.id);
  } finally { if (before === undefined) delete process.env.AGENT_FILLER_AFTER_MS; else process.env.AGENT_FILLER_AFTER_MS = before; }
});
