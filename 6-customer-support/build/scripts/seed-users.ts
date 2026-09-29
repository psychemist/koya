import { one, pool } from '../lib/db.ts';
import { hashPassword } from '../lib/auth.ts';

/**
 * Creates or updates the two console accounts from SEED_* variables. Safe to
 * re-run: an existing account keeps its id and gets the new password. A
 * missing password skips that account rather than creating one nobody can use.
 */
const accounts = [
  { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD, name: 'Support Admin', role: 'admin' },
  { email: process.env.SEED_AGENT_EMAIL, password: process.env.SEED_AGENT_PASSWORD, name: 'Support Agent', role: 'support_agent' },
];
for (const a of accounts) {
  if (!a.email || !a.password) { console.log(`skipped ${a.role}: SEED_${a.role === 'admin' ? 'ADMIN' : 'AGENT'}_EMAIL or _PASSWORD is not set`); continue; }
  if (a.password.length < 12) { console.error(`refused ${a.email}: use a password of at least 12 characters`); continue; }
  const row = await one<{ email: string; role: string }>(
    `insert into public.users (email, name, role, password_hash) values (lower($1), $2, $3, $4)
     on conflict (email) do update set role = excluded.role, password_hash = excluded.password_hash returning email, role`,
    [a.email.trim(), a.name, a.role, hashPassword(a.password)]);
  console.log(`ready: ${row!.email} (${row!.role})`);
}
await pool().end();
