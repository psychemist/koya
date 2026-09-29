import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'test-secret-not-a-real-one';

const { issue, verify, hashPassword, checkPassword, roleLabel, sessionUserId } = await import('../../lib/auth.ts');

test('a session token round-trips', () => {
  assert.equal(verify(issue('u-agent'))?.userId, 'u-agent');
});

test('a tampered token is refused', () => {
  const token = issue('u-agent');
  const [sub, exp, sig] = token.split('.');
  assert.equal(verify(`u-admin.${exp}.${sig}`), null, 'a swapped subject must not verify');
  assert.equal(verify(`${sub}.${exp}.${'a'.repeat(sig.length)}`), null);
  assert.equal(verify('nonsense'), null);
  assert.equal(verify(''), null);
});

test('an expired token is refused', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const forged = issue('u-agent').split('.');
  assert.equal(verify(`u-agent.${past}.${forged[2]}`), null);
});

test('a chat token is not a console session, even though both are signed with SESSION_SECRET', async () => {
  const { issueChatToken } = await import('../../lib/chat-session.ts');
  assert.equal(verify(issueChatToken('2b1f0c4e-6d0a-4c1e-9d55-0d6c6c1f5a11')), null);
});

test('the session is read from a Cookie header among other cookies', () => {
  const t = issue('u-agent');
  assert.equal(sessionUserId(`rp_chat=x; rp_console_session=${t}; other=1`), 'u-agent');
  assert.equal(sessionUserId('rp_chat=x'), null);
  assert.equal(sessionUserId(null), null);
});

test('passwords are salted, so two identical passwords do not collide', () => {
  const a = hashPassword('support-desk-2026');
  const b = hashPassword('support-desk-2026');
  assert.notEqual(a, b);
  assert.ok(checkPassword('support-desk-2026', a));
  assert.ok(checkPassword('support-desk-2026', b));
});

test('a wrong password, an empty one and a missing hash all fail', () => {
  const stored = hashPassword('correct-horse');
  assert.equal(checkPassword('wrong', stored), false);
  assert.equal(checkPassword('', stored), false);
  assert.equal(checkPassword('correct-horse', null), false);
  assert.equal(checkPassword('correct-horse', 'not-a-salted-hash'), false);
});

test('roles read as words a person would use', () => {
  assert.equal(roleLabel('support_agent'), 'Support agent');
  assert.equal(roleLabel('admin'), 'Admin');
});
