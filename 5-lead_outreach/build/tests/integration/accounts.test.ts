import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query, one } from '../../lib/db.ts';
import { hashPassword, checkPassword, canSeeRun } from '../../lib/auth.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

async function makeUser(role: 'operator' | 'admin') {
  const email = `${role}-${randomUUID().slice(0, 8)}@koya.test`;
  const row = await one<{ id: string; email: string; name: string; role: 'operator' | 'admin' }>(
    `insert into public.users (email, name, role, password_hash)
     values ($1,$2,$3,$4) returning id, email, name, role`,
    [email, 'Test Person', role, hashPassword('lead-desk-2026')],
  );
  return row!;
}

const cleanup = (id: string) => query('delete from public.users where id = $1', [id]);

test('a seeded account can be signed in against its stored hash',
  { skip: skipWithoutDatabase }, async () => {
    const user = await makeUser('operator');
    const stored = await one<{ password_hash: string }>(
      'select password_hash from public.users where id = $1', [user.id]);
    assert.ok(checkPassword('lead-desk-2026', stored!.password_hash));
    assert.equal(checkPassword('wrong', stored!.password_hash), false);
    await cleanup(user.id);
  });

test('the email uniqueness constraint makes re-seeding safe',
  { skip: skipWithoutDatabase }, async () => {
    const user = await makeUser('admin');
    await query(
      `insert into public.users (email, name, role, password_hash)
       values ($1,'Renamed','admin','x')
       on conflict (email) do update set name = excluded.name`,
      [user.email]);
    const rows = await query('select id from public.users where email = $1', [user.email]);
    assert.equal(rows.length, 1);
    await cleanup(user.id);
  });

test('only two roles are storable', { skip: skipWithoutDatabase }, async () => {
  await assert.rejects(() => query(
    `insert into public.users (email, name, role) values ($1,'X','superuser')`,
    [`bad-${randomUUID().slice(0, 8)}@koya.test`]));
});

test('a run records who started it, and one operator cannot see another one',
  { skip: skipWithoutDatabase }, async () => {
    const ada = await makeUser('operator');
    const tomi = await makeUser('operator');
    const admin = await makeUser('admin');

    const run = await seedRun({ created_by: ada.id } as any);
    const stored = await one<{ created_by: string }>(
      'select created_by from public.runs where id = $1', [run.id]);
    assert.equal(stored!.created_by, ada.id);

    assert.equal(canSeeRun(ada, stored!), true);
    assert.equal(canSeeRun(tomi, stored!), false);
    assert.equal(canSeeRun(admin, stored!), true);

    await dropRun(run.id);
    await cleanup(ada.id); await cleanup(tomi.id); await cleanup(admin.id);
  });

test('deleting a person leaves their runs standing, with the owner cleared',
  { skip: skipWithoutDatabase }, async () => {
    const ada = await makeUser('operator');
    const run = await seedRun({ created_by: ada.id } as any);
    await cleanup(ada.id);
    const after = await one<{ created_by: string | null }>(
      'select created_by from public.runs where id = $1', [run.id]);
    assert.ok(after, 'the run must survive the account being removed');
    assert.equal(after!.created_by, null);
    await dropRun(run.id);
  });

test('the admin spend rollup attributes a run to the person who started it',
  { skip: skipWithoutDatabase }, async () => {
    const ada = await makeUser('operator');
    const run = await seedRun({ created_by: ada.id } as any);
    await query(
      `insert into public.spend_ledger (run_id, provider, amount_usd, note)
       values ($1,'apify',0.12,'test')`, [run.id]);

    const [row] = await query<{ apify: string; runs: string }>(
      `select coalesce(sum(r.apify_spend_usd),0)::text as apify,
              count(distinct r.id)::text as runs
         from public.users u
         left join public.runs r on r.created_by = u.id
        where u.id = $1 group by u.id`, [ada.id]);
    assert.equal(row.runs, '1');

    await dropRun(run.id);
    await cleanup(ada.id);
  });
