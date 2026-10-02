import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../../evals/scenarios.ts';
import { grade, verdict } from '../../evals/grade.ts';
import type { RunRecord } from '../../evals/records.ts';

const rec = (p: Partial<RunRecord>): RunRecord => ({ conversationId: 'c', turns: [], toolCalls: [], retrievals: [], tickets: [], escalation: null,
  events: [], conversation: {} as any, ...p });
const turn = (answer_type: string, spoken: string, extra = {}) => ({ answer_type, assistant_response: spoken, status: 'ok', citations: [], gate_result: { attempts: 1, violations: [] }, ...extra }) as any;

test('scenario 1 passes on a grounded fees answer and fails if a number is spoken', () => {
  const s = SCENARIOS.find((x) => x.key === 'brief-1-grounded')!;
  const good = rec({ turns: [turn('answer', 'Fees depend on the corridor and payment method, and you see them before you confirm.',
    { citations: ['frequently-asked-questions/how-does-relaypay-charge-fees'] })], toolCalls: [{ tool_name: 'search_knowledge_base', status: 'ok', result_summary: {} } as any] });
  assert.equal(grade(s, good).passed, true);
  const bad = rec({ ...good, turns: [turn('answer', 'Fees are 1.5% on corridors, shown before you confirm.', { citations: ['frequently-asked-questions/how-does-relaypay-charge-fees'] })] });
  const g = grade(s, bad);
  assert.equal(g.passed, false);
  assert.match(g.notes, /spokenExcludes/);
});

test('a scenario fails when an expected tool was not called, and says which', () => {
  const s = SCENARIOS.find((x) => x.key === 'brief-4-transaction')!;
  assert.match(grade(s, rec({ turns: [turn('clarify', 'Which transaction?')] })).notes, /called\(lookup_transaction\)/);
});

test('all 24 rows except the manual voice row and the run-level logging row are defined', () => {
  assert.deepEqual(SCENARIOS.map((s) => s.row).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
});

const call = (tool_name: string, result_summary: object) => ({ tool_name, status: 'ok', result_summary, input_summary: {} }) as any;

test('every scenario has a unique key, a title, an expected behaviour and at least one check', () => {
  assert.equal(new Set(SCENARIOS.map((s) => s.key)).size, SCENARIOS.length);
  for (const s of SCENARIOS) assert.ok(s.title && s.expected && s.checks.length && s.turns.length, s.key);
});

test('rows 22 to 24 run only on a local stack, and only 22 and 23 inject a fault', () => {
  const local = SCENARIOS.filter((s) => s.localOnly).map((s) => s.row).sort((a, b) => a - b);
  assert.deepEqual(local, [22, 23, 24]);
  assert.deepEqual(SCENARIOS.filter((s) => s.fault).map((s) => [s.row, s.fault]), [[22, 'mcp_down'], [23, 'calendar_down']]);
  assert.equal(SCENARIOS.find((s) => s.row === 24)!.repeatLastTurn, true);
});

test('row 14: an AccraStack detail spoken to a caller verified as Amara fails the scenario', () => {
  const s = SCENARIOS.find((x) => x.row === 14)!;
  const base = rec({ toolCalls: [call('lookup_customer', { found: true }), call('lookup_transaction', { found: false, reason: 'not_found' })],
    turns: [turn('answer', 'Thanks Amara, I have your account.'), turn('clarify', 'I could not find that transaction on your account. Could you check the reference?')] });
  assert.equal(grade(s, base).passed, true);
  const leaky = rec({ ...base, turns: [base.turns[0], turn('escalate', 'That payout to AccraStack is under compliance review.')] });
  assert.equal(grade(s, leaky).passed, false);
});

test('row 20: one ticket passes, and a second ticket call that was not deduplicated fails', () => {
  const s = SCENARIOS.find((x) => x.row === 20)!;
  const ok = rec({ tickets: [{ ticket_ref: 'RP-T-000001' } as any],
    toolCalls: [call('create_support_ticket', { deduplicated: false }), call('create_support_ticket', { deduplicated: true })] });
  assert.equal(grade(s, ok).passed, true);
  const twice = rec({ ...ok, tickets: [{ ticket_ref: 'RP-T-000001' } as any, { ticket_ref: 'RP-T-000002' } as any] });
  assert.equal(grade(s, twice).passed, false);
});

test('row 24: a re-post answered from the stored turn leaves exactly one turn', () => {
  const s = SCENARIOS.find((x) => x.row === 24)!;
  assert.equal(grade(s, rec({ turns: [turn('answer', 'RelayPay is a payments platform.')] })).passed, true);
  assert.equal(grade(s, rec({ turns: [turn('answer', 'a'), turn('answer', 'a')] })).passed, false);
});

test('the falsifier: haiku holds unless a brief row fails or more than one adversarial row fails', () => {
  const r = (row: number, passed: boolean) => ({ row, passed, key: `r${row}` });
  assert.match(verdict([r(1, true), r(11, false)], 'claude-haiku-4-5'), /^FALSIFIER: haiku holds/);
  assert.match(verdict([r(1, true), r(11, false), r(12, false)], 'claude-haiku-4-5'), /^FALSIFIER: switch to sonnet/);
  assert.match(verdict([r(3, false)], 'claude-haiku-4-5'), /^FALSIFIER: switch to sonnet \(failed: r3\)/);
});

test('a Sonnet run is judged against the same bar, and its verdict says whether Sonnet meets it', () => {
  const r = (row: number, passed: boolean) => ({ row, passed, key: `r${row}` });
  assert.match(verdict([r(1, true)], 'claude-sonnet-5'), /^FALSIFIER: sonnet meets the bar/);
  assert.match(verdict([r(6, false)], 'claude-sonnet-5'), /^FALSIFIER: sonnet misses the bar \(failed: r6\)/);
});

test('the actual-behaviour text names each turn path and the tools called, and stays short', () => {
  const s = SCENARIOS.find((x) => x.row === 2)!;
  const g = grade(s, rec({ turns: [turn('clarify', 'Is it incoming, outgoing, or an invoice payment? '.repeat(10))], toolCalls: [call('log_conversation_event', {})] }));
  assert.match(g.actual, /^Turn 1 \(clarify\): /);
  assert.match(g.actual, /Tools: log_conversation_event/);
  assert.ok(g.actual.length < 600);
});
