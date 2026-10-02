import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILLERS } from '../../lib/lines.ts';
import { FillerPicker, fillerKind } from '../../agent/fillers.ts';

test('a tool that started names what is happening', () => {
  assert.equal(fillerKind('anything', 'mcp__relaypay__lookup_transaction'), 'lookup');
  assert.equal(fillerKind('anything', 'mcp__relaypay__lookup_payout'), 'lookup');
  assert.equal(fillerKind('anything', 'mcp__relaypay__lookup_customer'), 'account');
  assert.equal(fillerKind('anything', 'mcp__relaypay__search_knowledge_base'), 'knowledge');
  assert.equal(fillerKind('anything', 'mcp__relaypay__create_escalation'), 'handoff');
  assert.equal(fillerKind('anything', 'mcp__relaypay__create_support_ticket'), 'handoff');
});

test('before any tool, the caller\'s words choose the line', () => {
  assert.equal(fillerKind('This is ridiculous, my payout is still not here'), 'empathy');
  assert.equal(fillerKind('Can you check TXN-9001'), 'lookup');
  assert.equal(fillerKind('My name is Amara Okafor from LagosLedger'), 'account');
  assert.equal(fillerKind('What fees does RelayPay charge for international transfers?'), 'knowledge');
  assert.equal(fillerKind('my payment is stuck'), 'general');
  assert.equal(fillerKind('the event logger', 'mcp__relaypay__log_conversation_event'), 'general');
});

test('a caller never hears the same filler twice running', () => {
  const p = new FillerPicker();
  const lines = Array.from({ length: 8 }, () => p.pick('c1', 'general'));
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1]);
  assert.deepEqual(new Set(lines.slice(0, 4)), new Set(FILLERS.general));
});

test('sympathy is said once per conversation, then the turn gets a plain filler', () => {
  const p = new FillerPicker();
  assert.ok((FILLERS.empathy as readonly string[]).includes(p.pick('c1', 'empathy')));
  assert.ok((FILLERS.general as readonly string[]).includes(p.pick('c1', 'empathy')));
  assert.ok((FILLERS.empathy as readonly string[]).includes(p.pick('c2', 'empathy')));
});

test('memory is bounded: the oldest conversation is forgotten first', () => {
  const p = new FillerPicker(2);
  const first = p.pick('a', 'general'); p.pick('b', 'general'); p.pick('c', 'general');
  assert.equal(p.pick('a', 'general'), first);   // a was forgotten, so it starts again from the first line
});

test('no filler contains a dash or a promise word', () => {
  for (const [k, lines] of Object.entries(FILLERS)) for (const l of lines) {
    assert.ok(!/[—–-]/.test(l), `${k}: ${l}`);
    assert.ok(!/\b(guarantee|promise|will be|definitely|resolved|fixed)\b/i.test(l), `${k}: ${l}`);
  }
});
