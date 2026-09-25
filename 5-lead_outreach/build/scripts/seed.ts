import { randomBytes } from 'node:crypto';
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
 *
 * THE TWO ACCOUNTS HAVE SEPARATE PASSWORDS, and there is no default in this
 * file. A committed default is a published credential the moment the app has a
 * public URL, and a password shared between the two roles makes the admin
 * boundary decorative: anyone who can sign in as the operator can read the
 * whole team's spend by typing the other address.
 *
 * Usage:
 *   npm run seed                  both accounts
 *   npm run seed -- operator      that account only, leaving the other alone
 *
 * Supply passwords as SEED_OPERATOR_PASSWORD and SEED_ADMIN_PASSWORD. Anything
 * not supplied is generated here and printed once.
 */
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
try { assertPostgresUrl(url); } catch (e) { console.error((e as Error).message); process.exit(1); }

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

type Seed = { email: string; name: string; role: string; envVar: string };

const ALL: Seed[] = [
  { email: 'operator@koya.test', name: 'Ada Okafor', role: 'operator',
    envVar: 'SEED_OPERATOR_PASSWORD' },
  { email: 'admin@koya.test', name: 'Chukwu Dike', role: 'admin',
    envVar: 'SEED_ADMIN_PASSWORD' },
];

const only = process.argv[2]?.trim().toLowerCase();
if (only && !ALL.some((u) => u.role === only)) {
  console.error(`Unknown role "${only}". Use one of: ${ALL.map((u) => u.role).join(', ')}.`);
  process.exit(1);
}
const users = only ? ALL.filter((u) => u.role === only) : ALL;

/** Readable enough to type off a screen during a demo, long enough not to be
 *  guessed. Base64url, so no character needs escaping in a shell. */
const generate = () => randomBytes(12).toString('base64url');

const resolved = users.map((u) => {
  const supplied = process.env[u.envVar]?.trim();
  return { ...u, password: supplied || generate(), generated: !supplied };
});

/**
 * The check this whole change exists for. Two roles behind one password is one
 * role, and it fails silently: everything works, and the admin boundary simply
 * is not there.
 */
const supplied = resolved.filter((u) => !u.generated);
if (supplied.length === 2 && supplied[0].password === supplied[1].password) {
  console.error(
    `${supplied[0].envVar} and ${supplied[1].envVar} are the same password.\n\n` +
    'The admin sees every run and the spend behind them. If the operator can sign in\n' +
    'with the admin password, that boundary does not exist. Set them differently.');
  process.exit(1);
}

for (const u of resolved) {
  await pool.query(
    `insert into public.users (email, name, role, password_hash)
     values ($1,$2,$3,$4)
     on conflict (email) do update
       set name = excluded.name, role = excluded.role, password_hash = excluded.password_hash`,
    [u.email, u.name, u.role, hashPassword(u.password)],
  );
  console.log(`seeded ${u.role.padEnd(8)} ${u.email}`);
}

console.log('');
for (const u of resolved) {
  // A password that came from the environment is already known to whoever ran
  // this, and echoing it only writes it into shell history and any log
  // scraping the output.
  console.log(u.generated
    ? `${u.role.padEnd(8)} ${u.password}   <- generated, not stored anywhere else`
    : `${u.role.padEnd(8)} (from ${u.envVar})`);
}

if (resolved.some((u) => u.generated)) {
  console.log('\nGenerated passwords are shown once. Re-running this rotates them.');
}
if (only) {
  console.log(`\nOnly the ${only} account was touched. The other keeps its current password.`);
}

await pool.end();
