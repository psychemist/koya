import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { assertPostgresUrl } from '../lib/config.ts';

/**
 * Applies db/migrations/*.sql in filename order, once each, then ALWAYS runs
 * db/lockdown.sql.
 *
 * Each migration runs in a transaction and is recorded in schema_migrations,
 * so a half-applied migration rolls back rather than leaving the schema in a
 * state no file describes. The lockdown runs every time, new migration or not,
 * because Supabase grants anon and authenticated CRUD on every new public
 * table by default: a table added next week is locked the moment it exists.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'db', 'migrations');
const lockdown = join(here, '..', 'db', 'lockdown.sql');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.\n\nSupabase > Project Settings > Database > Connection string > URI (pooled).\nPut it in .env.local. It is gitignored.');
  process.exit(1);
}
try { assertPostgresUrl(url); } catch (e) { console.error((e as Error).message); process.exit(1); }

const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

await pool.query(`create table if not exists public.schema_migrations (
  filename text primary key, applied_at timestamptz not null default now())`);
const applied = new Set((await pool.query<{ filename: string }>('select filename from public.schema_migrations')).rows.map((r) => r.filename));

let ran = 0;
for (const f of files) {
  if (applied.has(f)) { console.log(`- ${f} (already applied)`); continue; }
  const sql = await readFile(join(dir, f), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('insert into public.schema_migrations (filename) values ($1)', [f]);
    await client.query('COMMIT');
    console.log(`applied ${f}`);
    ran++;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`failed ${f}\n  ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  } finally {
    client.release();
  }
}

try {
  await pool.query(await readFile(lockdown, 'utf8'));
  console.log('lockdown applied');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') console.log('no db/lockdown.sql yet');
  else { console.error(`lockdown failed\n  ${(e as Error).message}`); process.exit(1); }
}

console.log(ran ? `\n${ran} migration(s) applied.` : '\nSchema already up to date.');
await pool.end();
