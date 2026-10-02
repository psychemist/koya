// Articles added in the console: searchable like the file, kept when the file is ingested again, and retirable.
// The fixture embedder makes vectors locally, so this never calls Voyage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureEmbedder } from '../../lib/kb/embed.ts';
import { ingestKb, searchKb } from '../../lib/kb/search.ts';
import { addArticle, listArticles, retireArticle } from '../../lib/kb/articles.ts';
import { query } from '../../lib/db.ts';
import { skipWithoutDatabase } from '../helpers.ts';

const md = readFileSync(new URL('../../../assets/relaypay-knowledge-base.md', import.meta.url), 'utf8');
const e = fixtureEmbedder();
const title = 'Can I cancel a payout after I send it zebra test';
let id = '';
before(async () => { if (!skipWithoutDatabase) await ingestKb(md, e); });
after(async () => { if (id) await query('delete from public.kb_chunks where id = $1', [id]); });

test('an article added in the console is searchable straight away', { skip: skipWithoutDatabase }, async () => {
  const r = await addArticle(title, 'A payout can be cancelled only while it is still scheduled. Once it is processing, contact a specialist.', e);
  id = r.id;
  assert.match(id, /^console-articles\//);
  const hits = await searchKb('can I cancel a payout after I send it zebra test', e);
  assert.ok(hits.chunks.some((c) => c.id === id), JSON.stringify(hits.chunks.map((c) => c.id)));
});

test('ingesting the help centre file again does not retire it', { skip: skipWithoutDatabase }, async () => {
  await ingestKb(md, e);
  const { articles } = await listArticles();
  assert.equal(articles.find((a) => a.id === id)?.retired, false);
});

test('the same title replaces the article instead of adding a second one', { skip: skipWithoutDatabase }, async () => {
  const r = await addArticle(title, 'A payout can be cancelled while it is scheduled. After that a specialist has to look at it with you.', e);
  assert.deepEqual([r.id, r.replaced], [id, true]);
  assert.equal((await listArticles()).articles.filter((a) => a.id === id).length, 1);
});

test('a retired article leaves search, and only console articles can be retired this way', { skip: skipWithoutDatabase }, async () => {
  assert.equal(await retireArticle(id), true);
  const hits = await searchKb('can I cancel a payout after I send it zebra test', e);
  assert.ok(!hits.chunks.some((c) => c.id === id));
  assert.equal(await retireArticle('frequently-asked-questions/how-does-relaypay-charge-fees'), false);
});
