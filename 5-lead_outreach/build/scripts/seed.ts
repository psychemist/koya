import { Pool } from 'pg';
import { hashPassword } from '../lib/auth.ts';
import { assertPostgresUrl } from '../lib/config.ts';

/**
 * Two demo accounts. All data here is SYNTHETIC.
 *
 * Two roles rather than one because the interesting question in this system is
 * not who may approve something, since nothing is sent and there is nothing to
 * approve. It is who can see where a shared budget went. An operator sees the
 * runs they started. An admin sees the team's history and the spend behind it,
 * because the person answerable for a cohort account cannot audit spend they
 * are not allowed to look at.
 */
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
try { assertPostgresUrl(url); } catch (e) { console.error((e as Error).message); process.exit(1); }

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const PASSWORD = process.env.SEED_PASSWORD || 'lead-pipe-2026';

const users = [
  { email: 'operator@koya.test', name: 'Ada Okafor', role: 'operator' },
  { email: 'admin@koya.test', name: 'Chukwu Dike', role: 'admin' },
];

for (const u of users) {
  await pool.query(
    `insert into public.users (email, name, role, password_hash)
     values ($1,$2,$3,$4)
     on conflict (email) do update
       set name = excluded.name, role = excluded.role, password_hash = excluded.password_hash`,
    [u.email, u.name, u.role, hashPassword(PASSWORD)],
  );
  console.log(`seeded ${u.role.padEnd(8)} ${u.email}`);
}

console.log(`\nPassword for both: ${PASSWORD}`);
console.log('Set SEED_PASSWORD before running this anywhere that is reachable.');

await pool.end();
