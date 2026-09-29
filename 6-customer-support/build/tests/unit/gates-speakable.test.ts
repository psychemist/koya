import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpeakable } from '../../lib/gates/speakable.ts';

test('an answer over 60 words or any other reply over 45 is too long to speak', () => {
  assert.ok(checkSpeakable(Array(61).fill('word').join(' '), 'answer').length > 0);
  assert.ok(checkSpeakable(Array(46).fill('word').join(' '), 'clarify').length > 0);
  assert.deepEqual(checkSpeakable(Array(60).fill('word').join(' '), 'answer'), []);
});

test('markdown, bullets, links and emoji are not speech', () => {
  for (const s of ['**Fees** vary.', '- first\n- second', 'See https://relaypay.example/fees', 'Happy to help \u{1F600}'])
    assert.ok(checkSpeakable(s, 'answer').length > 0, s);
});
