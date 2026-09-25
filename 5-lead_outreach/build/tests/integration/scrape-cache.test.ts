import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scrape } from '../../lib/providers/firecrawl.ts';
import { query } from '../../lib/db.ts';
import { skipWithoutDatabase } from '../helpers.ts';

const throwing = (status: number) => async () => {
  const e = new Error(`stub ${status}`) as Error & { statusCode: number };
  e.statusCode = status;
  throw e;
};

const long = (word: string) => Array.from({ length: 260 }, () => word).join(' ');

test('the second fetch of a URL is served from cache and costs nothing',
  { skip: skipWithoutDatabase }, async () => {
    const host = `acme-${randomUUID().slice(0, 8)}.example`;
    let calls = 0;
    const fake = async () => { calls++; return { markdown: long('payroll'), statusCode: 200 }; };

    const a = await scrape(`https://${host}/about`, { fetcher: fake });
    const b = await scrape(`https://${host.toUpperCase()}/about/`, { fetcher: fake });

    assert.equal(calls, 1);
    assert.equal(b.fromCache, true);
    assert.equal(a.contentHash, b.contentHash);
    await query('delete from public.scrape_cache where url_norm like $1', [`%${host}%`]);
  });

test('a 402 and a 429 carry distinct codes', { skip: skipWithoutDatabase }, async () => {
  const host = `x-${randomUUID().slice(0, 8)}.example`;
  await assert.rejects(() => scrape(`https://${host}/a`, { fetcher: throwing(402) }),
    (e: any) => e.code === 'FIRECRAWL_402');
  await assert.rejects(() => scrape(`https://${host}/b`, { fetcher: throwing(429) }),
    (e: any) => e.code === 'FIRECRAWL_429' && e.retryable === true);
  await assert.rejects(() => scrape(`https://${host}/c`, { fetcher: throwing(403) }),
    (e: any) => e.code === 'SCRAPE_403');
});

test('a boilerplate-only page is unusable, not empty-but-fine',
  { skip: skipWithoutDatabase }, async () => {
    const host = `y-${randomUUID().slice(0, 8)}.example`;
    const r = await scrape(`https://${host}/`, {
      fetcher: async () => ({ markdown: 'Home About Contact', statusCode: 200 }),
    });
    assert.equal(r.usable, false);
    await query('delete from public.scrape_cache where url_norm like $1', [`%${host}%`]);
  });

test('a failed fetch leaves nothing in the cache to be served later',
  { skip: skipWithoutDatabase }, async () => {
    const host = `z-${randomUUID().slice(0, 8)}.example`;
    await assert.rejects(() => scrape(`https://${host}/`, { fetcher: throwing(500) }));
    const rows = await query('select 1 from public.scrape_cache where url_norm like $1',
      [`%${host}%`]);
    assert.equal(rows.length, 0);
  });

/**
 * The cache had no upper age.
 *
 * `fetched_at` was written on every insert and read by nobody, so a page
 * fetched in March was served as current evidence in September. Qualification
 * judges a company on this text, and a company's site is exactly the thing
 * that changes.
 */
test('a cache entry past its age is refetched rather than served',
  { skip: skipWithoutDatabase }, async () => {
    const host = `stale-${randomUUID().slice(0, 8)}.example`;
    let calls = 0;
    const fake = async () => { calls++; return { markdown: long('payroll'), statusCode: 200 }; };

    await scrape(`https://${host}/about`, { fetcher: fake });
    assert.equal(calls, 1);

    // Age the row past any plausible freshness window.
    await query(
      `update public.scrape_cache set fetched_at = now() - interval '400 days'
        where url_norm like $1`, [`%${host}%`]);

    const stale = await scrape(`https://${host}/about`, { fetcher: fake });
    assert.equal(calls, 2, 'a year-old page was served as current evidence');
    assert.equal(stale.fromCache, false);

    await query('delete from public.scrape_cache where url_norm like $1', [`%${host}%`]);
  });

/**
 * A cache hit must carry the time the page was actually fetched.
 *
 * `scrape_company_site` stamps the retrieval time into the evidence envelope
 * the qualification model reads. Stamping "now" on a cached page tells the
 * model the page was read this second when it may be weeks old, which is a
 * false citation in the one place the build promises sourced evidence.
 */
test('a cached page reports when it was really fetched, not when it was served',
  { skip: skipWithoutDatabase }, async () => {
    const host = `dated-${randomUUID().slice(0, 8)}.example`;
    const fake = async () => ({ markdown: long('payroll'), statusCode: 200 });

    const fresh = await scrape(`https://${host}/about`, { fetcher: fake });

    await query(
      `update public.scrape_cache set fetched_at = now() - interval '5 days'
        where url_norm like $1`, [`%${host}%`]);

    const served = await scrape(`https://${host}/about`, { fetcher: fake });
    assert.equal(served.fromCache, true);

    const ageMs = Date.now() - served.retrievedAt.getTime();
    assert.ok(ageMs > 4 * 24 * 3600_000,
      `a five day old page reported an age of ${Math.round(ageMs / 1000)}s`);
    assert.ok(fresh.retrievedAt instanceof Date);

    await query('delete from public.scrape_cache where url_norm like $1', [`%${host}%`]);
  });
