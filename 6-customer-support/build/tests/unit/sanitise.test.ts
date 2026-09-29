import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactString } from '../../lib/sanitise.ts';

test('redacts every provider key shape we hold', () => {
  const out = redactString('sk-ant-abc12345 sb_secret_aaaabbbb');
  for (const leak of ['sk-ant-abc', 'sb_secret_a']) assert.ok(!out.includes(leak), `leaked: ${leak}`);
});

test('voyage, vapi and resend key shapes are redacted', () => {
  const s = redactString('pa-abc123def456ghi789 re_ABCdef123456 sk-ant-api03-xyz');
  assert.ok(!/pa-abc123|re_ABCdef|sk-ant-api03/.test(s));
});

test('a bare hyphenated word is not mistaken for a Voyage key', () => {
  assert.equal(redactString('a pa-rent company'), 'a pa-rent company');
});

test('redacts by key name as well as by value shape', () => {
  assert.deepEqual(redact({ apiKey: 'whatever', nested: { token: 'x' }, authorization: 'Bearer abc' }),
    { apiKey: '[REDACTED]', nested: { token: '[REDACTED]' }, authorization: '[REDACTED]' });
});

test('a Discord webhook URL never survives redaction', () => {
  assert.ok(!redactString('https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOp').includes('AbCdEfGhIjKlMnOp'));
});

test('a Postgres URL keeps its host but loses its password', () => {
  const s = redactString('postgresql://postgres.ref:s3cretPass@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
  assert.ok(!s.includes('s3cretPass'));
  assert.ok(s.includes('pooler.supabase.com'));
});
