import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorFromTurns, endsChat } from '../../agent/chat.ts';
import { frameCallerText, collectSink } from '../../agent/turn.ts';
import { LINES, FILLERS } from '../../lib/lines.ts';

test('prior transcript from stored turns keeps the last 12 lines, oldest first, labelled', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ user_transcript: `q${i}`, assistant_response: `a${i}` }));
  const p = priorFromTurns(turns).split('\n');
  assert.equal(p.length, 12);
  assert.deepEqual([p[0], p[11]], ['Caller: q2', 'Agent: a7']);
});

test('no stored turns is no prior transcript at all', () => {
  assert.equal(priorFromTurns([]), '');
});

test('only the exact chat goodbye at the end of a reply ends a chat', () => {
  assert.equal(endsChat(`Glad that helped. ${LINES.chatGoodbye}`), true);
  assert.equal(endsChat(LINES.goodbye), false);
  assert.equal(endsChat('Say goodbye whenever you are done.'), false);
});

test('every turn states its channel', () => {
  const now = new Date('2026-10-05T09:00:00Z');
  assert.match(frameCallerText('hi', now, undefined, 'chat'), /\n\[Channel: web chat\]\n/);
  assert.match(frameCallerText('hi', now), /\n\[Channel: voice call\]\n/);
});

test('a chat reply keeps the approved text and drops the filler', () => {
  const s = collectSink();
  s.say(FILLERS.general[0], 'filler');
  s.say('Fees vary by corridor.');
  assert.equal(s.reply(), 'Fees vary by corridor.');
});
