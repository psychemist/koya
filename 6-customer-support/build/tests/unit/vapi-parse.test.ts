import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatRequest, parseServerMessage, maskNumber } from '../../agent/vapi.ts';

test('only user text after the last assistant message is new', () => {
  const r = parseChatRequest({ call: { id: 'call_1', type: 'webCall' }, messages: [
    { role: 'system', content: 'ignored' }, { role: 'assistant', content: 'Hi, how can I help?' },
    { role: 'user', content: 'My payment' }, { role: 'user', content: 'is stuck.' }] });
  assert.deepEqual([r.callId, r.newUserText], ['call_1', 'My payment is stuck.']);
});

test('the call id is found in the body, then metadata, then the query string', () => {
  assert.equal(parseChatRequest({ metadata: { callId: 'm1' }, messages: [] }).callId, 'm1');
  assert.equal(parseChatRequest({ messages: [] }, new URL('http://x/vapi/chat/completions?callId=q1')).callId, 'q1');
});

test('prior transcript is the last 12 user and assistant messages, labelled', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const r = parseChatRequest({ messages });
  assert.equal(r.prior.split('\n').length, 12);
  assert.match(r.prior, /^(Caller|Agent): /);
});

test('server messages parse in both the nested and flat shapes', () => {
  assert.deepEqual(parseServerMessage({ message: { type: 'status-update', status: 'in-progress', call: { id: 'c', type: 'inboundPhoneCall', customer: { number: '+15551234567' } } } }),
    { type: 'status-update', callId: 'c', status: 'in-progress', callType: 'inboundPhoneCall', customerNumber: '+15551234567', endedReason: undefined });
  assert.equal(parseServerMessage({ message: { type: 'end-of-call-report', endedReason: 'customer-ended-call', call: { id: 'c' } } }).endedReason, 'customer-ended-call');
});

test('a phone number is stored masked', () => { assert.equal(maskNumber('+15551234567'), '***4567'); });
