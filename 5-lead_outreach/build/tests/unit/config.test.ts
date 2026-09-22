import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPostgresUrl, assertPinnedActor } from '../../lib/config.ts';

test('rejects the Supabase API URL where a Postgres URL is wanted', () => {
  assert.throws(
    () => assertPostgresUrl('https://abc.supabase.co'),
    /not a Postgres connection string/,
  );
});

test('accepts a pooled Postgres URI', () => {
  const u = 'postgresql://postgres.abc:pw@aws-0-eu.pooler.supabase.com:6543/postgres';
  assert.equal(assertPostgresUrl(u), u);
});

test('refuses an unpinned Apify actor id', () => {
  assert.throws(() => assertPinnedActor(''), /APIFY_ACTOR_ID is not pinned/);
});

test('the error names where to find the right value, not just that it is wrong', () => {
  assert.throws(() => assertPostgresUrl('https://abc.supabase.co'), /Connection string/);
});
