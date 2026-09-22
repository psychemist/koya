import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactString, stripInvisible } from '../../lib/sanitise.ts';

test('redacts every provider key shape we hold', () => {
  const s = 'sk-ant-abc12345 apify_api_XYZ98765 fc-abcdef12 sb_secret_aaaabbbb';
  const out = redactString(s);
  for (const leak of ['sk-ant-abc', 'apify_api_X', 'fc-abcdef', 'sb_secret_a'])
    assert.ok(!out.includes(leak), `leaked: ${leak}`);
});

test('redacts by key name as well as by value shape', () => {
  assert.deepEqual(redact({ apiKey: 'whatever', nested: { token: 'x' } }),
    { apiKey: '[REDACTED]', nested: { token: '[REDACTED]' } });
});

test('strips the characters that hide an injection', () => {
  assert.equal(stripInvisible('ig​nore‮ all'), 'ignore all');
});

test('a Discord webhook URL never survives redaction', () => {
  const s = 'https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOp';
  assert.ok(!redactString(s).includes('AbCdEfGhIjKlMnOp'));
});
