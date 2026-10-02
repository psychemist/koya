import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePreToolUseHook } from '../../agent/hooks.ts';

const call = (hook: any, tool: string) => hook({ hook_event_name: 'PreToolUse', tool_name: `mcp__relaypay__${tool}`, tool_input: {} }, undefined, {});
const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision ?? 'allow';

test('the fifth tool call in one turn is denied', async () => {
  const s = { conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false };
  const h = makePreToolUseHook(s, async () => false);
  for (let i = 0; i < 4; i++) assert.equal(decision(await call(h, 'search_knowledge_base')), 'allow');
  assert.equal(decision(await call(h, 'search_knowledge_base')), 'deny');
});

test('after an escalation is open, lookups are denied but ticket and event tools are not', async () => {
  const h = makePreToolUseHook({ conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false }, async () => true);
  assert.equal(decision(await call(h, 'lookup_transaction')), 'deny');
  assert.equal(decision(await call(h, 'log_conversation_event')), 'allow');
});

test('a call over budget gets every tool denied', async () => {
  const h = makePreToolUseHook({ conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: true }, async () => false);
  assert.equal(decision(await call(h, 'search_knowledge_base')), 'deny');
});

test('StructuredOutput is always allowed and never counted, because it is how the reply itself is delivered (SPIKE.md)', async () => {
  const s = { conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false };
  const h = makePreToolUseHook(s, async () => true);
  for (let i = 0; i < 4; i++) assert.equal(decision(await call(h, 'search_knowledge_base')), 'allow');
  const r = await h({ hook_event_name: 'PreToolUse', tool_name: 'StructuredOutput', tool_input: {} } as any, undefined, {} as any);
  assert.equal(decision(r), 'allow');
  assert.equal(s.toolCallsThisTurn, 4);
});

test('a denied call explains itself in a sentence the model can act on', async () => {
  const h = makePreToolUseHook({ conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false }, async () => true);
  const r: any = await call(h, 'lookup_customer');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /escalat/i);
});

test('a time the tool just offered cannot be booked on the same turn: the caller has to choose it first', async () => {
  const offered = ['2026-10-07T10:00:00.000Z', '2026-10-07T10:30:00.000Z'];
  const h = makePreToolUseHook({ conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false }, async () => false, async () => offered);
  const book = (preferred_time: string) => h({ tool_name: 'mcp__relaypay__create_escalation', tool_input: { preferred_time } } as any, undefined, { signal: new AbortController().signal } as any);
  const denied: any = await book('2026-10-07T10:00:00Z');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /has not chosen it/);
  assert.deepEqual(await book('2026-10-08T09:00:00Z'), {}, 'a time the caller named themselves is not blocked');
});

test('once the caller has spoken since the offer, booking an offered time goes through', async () => {
  const h = makePreToolUseHook({ conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false }, async () => false, async () => []);
  assert.deepEqual(await h({ tool_name: 'mcp__relaypay__create_escalation', tool_input: { preferred_time: '2026-10-07T10:00:00Z' } } as any,
    undefined, { signal: new AbortController().signal } as any), {});
});
