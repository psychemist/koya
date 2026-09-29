import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { chatTranscript } from '../../lib/chat-transcript.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

const turn = (conv: string, seq: number, you: string, relaypay: string) => query(
  `insert into public.conversation_turns (conversation_id, seq, user_transcript, assistant_response, answer_type, status)
   values ($1, $2, $3, $4, 'clarify', 'ok')`, [conv, seq, you, relaypay]);

test('restore returns the chat turns in order, with the references built from rows', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'web_text' });
  await turn(c.id, 2, 'q2', 'a2'); await turn(c.id, 1, 'q1', 'a1');
  await query(`insert into public.support_tickets (conversation_id, category, priority, summary, dedupe_key)
    values ($1, 'invoice', 'normal', 'Invoice payment failed and needs a look.', $1::uuid::text || ':invoice')`, [c.id]);
  const t = await chatTranscript(c.id);
  assert.deepEqual(t.turns.map((x) => [x.you, x.relaypay]), [['q1', 'a1'], ['q2', 'a2']]);
  assert.match(t.records.ticket_ref!, /^RP-T-\d{6}$/);
  assert.equal(t.ended, false);
  await dropConversation(c.id);
});

test('restore never returns a voice or eval conversation, even given its id', { skip: skipWithoutDatabase }, async () => {
  for (const channel of ['voice_web', 'eval'] as const) {
    const c = await newConversation({ channel });
    await turn(c.id, 1, 'secret question', 'secret answer');
    const t = await chatTranscript(c.id);
    assert.deepEqual([t.turns, t.ended], [[], true]);
    await dropConversation(c.id);
  }
});

test('an ended chat restores with ended true', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'web_text' });
  await turn(c.id, 1, 'q1', 'a1');
  await query(`update public.conversations set ended_at = now(), ended_reason = 'idle_timeout' where id = $1`, [c.id]);
  assert.equal((await chatTranscript(c.id)).ended, true);
  await dropConversation(c.id);
});
