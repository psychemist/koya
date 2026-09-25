import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPostgresUrl, assertPinnedActor, baseUrl } from '../../lib/config.ts';

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

/**
 * A dashboard field is exactly where a URL picks up a trailing slash, and the
 * notification lane concatenates a path straight on to this value. On
 * 2026-09-25 that shipped `https://koya-lead-agent.vercel.app//runs/<id>` in
 * an email that had already gone out.
 */
test('a base URL never keeps a trailing slash, however many it arrives with', () => {
  assert.equal(baseUrl('https://koya-lead-agent.vercel.app/'),
               'https://koya-lead-agent.vercel.app');
  assert.equal(baseUrl('https://koya-lead-agent.vercel.app///'),
               'https://koya-lead-agent.vercel.app');
  assert.equal(baseUrl('https://koya-lead-agent.vercel.app'),
               'https://koya-lead-agent.vercel.app');
});

test('a base URL with a path keeps the path and loses only the slash', () => {
  assert.equal(baseUrl('https://example.com/app/'), 'https://example.com/app');
});

test('surrounding whitespace from a pasted dashboard value is dropped', () => {
  assert.equal(baseUrl('  https://example.com/  '), 'https://example.com');
});

test('an unset base URL falls back to local development rather than empty', () => {
  assert.equal(baseUrl(undefined), 'http://localhost:3000');
  assert.equal(baseUrl(''), 'http://localhost:3000');
  assert.equal(baseUrl('   '), 'http://localhost:3000');
});
