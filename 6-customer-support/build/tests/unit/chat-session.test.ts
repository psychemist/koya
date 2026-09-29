import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
process.env.SESSION_SECRET = 's'.repeat(32);
const { issueChatToken, readChatToken, chatCookie, clearChatCookie } = await import('../../lib/chat-session.ts');
const id = '2b1f0c4e-6d0a-4c1e-9d55-0d6c6c1f5a11';

test('a chat token reads back as its conversation id', () => {
  assert.equal(readChatToken(issueChatToken(id)), id);
});

test('a tampered id or signature, or plain garbage, is refused without throwing', () => {
  const t = issueChatToken(id);
  assert.equal(readChatToken(t.replace('2b1f0c4e', '00000000')), null);
  assert.equal(readChatToken(t.slice(0, -2) + (t.endsWith('xx') ? 'yy' : 'xx')), null);
  for (const bad of ['garbage', '', undefined, null, 'a.b.c.d']) assert.equal(readChatToken(bad as any), null);
});

test('a token past twelve hours is refused', () => {
  const t = issueChatToken(id, 0);
  assert.equal(readChatToken(t, 43_200_000 - 1), id);
  assert.equal(readChatToken(t, 43_200_000 + 1), null);
});

test('a console-style signature over the same payload is not a chat token', () => {
  const [cid, exp] = issueChatToken(id).split('.');
  const consoleSig = createHmac('sha256', process.env.SESSION_SECRET!).update(`${cid}.${exp}`).digest('base64url');
  assert.equal(readChatToken(`${cid}.${exp}.${consoleSig}`), null);
});

test('a signed value that is not a UUID is refused', () => {
  assert.equal(readChatToken(issueChatToken('not-a-uuid')), null);
});

test('the cookie is httpOnly, SameSite=Lax, path /, twelve hours, and Secure only when asked', () => {
  const c = chatCookie('tok', true);
  for (const p of ['rp_chat=tok', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=43200', 'Secure']) assert.ok(c.includes(p), p);
  assert.ok(!chatCookie('tok', false).includes('Secure'));
  assert.match(clearChatCookie(false), /^rp_chat=;.*Max-Age=0/);
});
