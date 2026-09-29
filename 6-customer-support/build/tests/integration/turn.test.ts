import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { LINES } from '../../lib/lines.ts';
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
  assert.deepEqual(s.said, [LINES.filler, answer([]).spoken_response]);
  const [t] = await query('select seq, answer_type, citations, status from public.conversation_turns where conversation_id=$1', [c.id]);
  assert.deepEqual(t, { seq: 1, answer_type: 'answer', citations: ['faq/fees'], status: 'ok' });
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
  process.env.DAILY_CLAUDE_CAP_USD = '0.30';            // cap above the per-call budget, so config accepts it
  const c = await newConversation();
  await query(`insert into public.spend_ledger (provider, amount_usd, conversation_id, note) values ('anthropic', 1.0, $1, 'cap test')`, [c.id]);
  const s = sink();
  const r = await runTurn({ sessions: new SessionManager(fakeRuntime([])) }, { conversationId: c.id, text: 'hello there' }, s);
  assert.equal(r.status, 'capacity');
  assert.equal(s.said.at(-1), `${LINES.capacity} ${LINES.goodbye}`);
  await dropConversation(c.id);
});
