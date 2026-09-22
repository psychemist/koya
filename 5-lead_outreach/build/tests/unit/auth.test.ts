import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'test-secret-not-a-real-one';

const { issue, verify, hashPassword, checkPassword, canSeeRun, canDeleteRun, roleLabel } =
  await import('../../lib/auth.ts');

const operator = { id: 'u-op', email: 'o@k.test', name: 'Ada', role: 'operator' as const };
const admin = { id: 'u-ad', email: 'a@k.test', name: 'Ike', role: 'admin' as const };

test('a session token round-trips', () => {
  assert.equal(verify(issue('u-op'))?.userId, 'u-op');
});

test('a tampered token is refused', () => {
  const token = issue('u-op');
  const [sub, exp, sig] = token.split('.');
  assert.equal(verify(`u-ad.${exp}.${sig}`), null, 'a swapped subject must not verify');
  assert.equal(verify(`${sub}.${exp}.${'a'.repeat(sig.length)}`), null);
  assert.equal(verify('nonsense'), null);
  assert.equal(verify(''), null);
});

test('an expired token is refused', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  // Signed correctly but already expired: the signature is not the only check.
  const forged = issue('u-op').split('.');
  assert.equal(verify(`u-op.${past}.${forged[2]}`), null);
});

test('passwords are salted, so two identical passwords do not collide', () => {
  const a = hashPassword('lead-desk-2026');
  const b = hashPassword('lead-desk-2026');
  assert.notEqual(a, b);
  assert.ok(checkPassword('lead-desk-2026', a));
  assert.ok(checkPassword('lead-desk-2026', b));
});

test('a wrong password, an empty one and a missing hash all fail', () => {
  const stored = hashPassword('correct-horse');
  assert.equal(checkPassword('wrong', stored), false);
  assert.equal(checkPassword('', stored), false);
  assert.equal(checkPassword('correct-horse', null), false);
  assert.equal(checkPassword('correct-horse', 'not-a-salted-hash'), false);
});

test('an operator sees only the runs they started', () => {
  assert.equal(canSeeRun(operator, { created_by: 'u-op' }), true);
  assert.equal(canSeeRun(operator, { created_by: 'u-someone-else' }), false);
  assert.equal(canSeeRun(operator, { created_by: null }), false);
});

test('an admin sees everything, because they answer for the shared budget', () => {
  assert.equal(canSeeRun(admin, { created_by: 'u-op' }), true);
  assert.equal(canSeeRun(admin, { created_by: null }), true);
});

test('deleting is narrower than seeing, and an unowned run is admin only', () => {
  assert.equal(canDeleteRun(operator, { created_by: 'u-op' }), true);
  assert.equal(canDeleteRun(operator, { created_by: 'u-other' }), false);
  assert.equal(canDeleteRun(operator, { created_by: null }), false);
  assert.equal(canDeleteRun(admin, { created_by: null }), true);
});

test('roles read as words a person would use', () => {
  assert.equal(roleLabel('operator'), 'Operator');
  assert.equal(roleLabel('admin'), 'Admin');
});
