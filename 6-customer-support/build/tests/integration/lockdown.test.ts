import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, tx } from '../../lib/db.ts';
import { skipWithoutDatabase } from '../helpers.ts';

test('every public table has row level security on', { skip: skipWithoutDatabase }, async () => {
  const rows = await query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
  assert.deepEqual(rows.map((r) => r.relname), []);
});

test('anon can read no table and execute no function, including search_kb', { skip: skipWithoutDatabase }, async () => {
  const rows = await query<{ what: string }>(
    `select 'table ' || tablename as what from pg_tables where schemaname='public'
       and (has_table_privilege('anon', 'public.' || quote_ident(tablename), 'select')
         or has_table_privilege('authenticated', 'public.' || quote_ident(tablename), 'select'))
     union all
     select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(rows, []);
});

test('as the anon role, a select is refused outright', { skip: skipWithoutDatabase }, async () => {
  await assert.rejects(() => tx(async (c) => { await c.query('set local role anon'); await c.query('select * from public.customers'); }),
    /permission denied/);
});
