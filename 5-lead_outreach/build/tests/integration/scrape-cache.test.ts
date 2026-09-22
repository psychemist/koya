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
