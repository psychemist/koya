/**
 * Seeds the two demo accounts.
 *
 * Idempotent: it upserts on the email address, so running it after a password
 * change updates the password rather than failing on the unique index, and
 * running it twice in a row changes nothing the second time.
 *
 * The passwords come from the environment and are printed on the sign-in page.
 * That is a deliberate choice for a graded demo that has to open on a
 * stranger's machine, and it is reversible: change SEED_*_PASSWORD, re-run
 * this, and the printed credentials stop working.
 *
 * Usage:  npm run seed
 */
import { query, closePool } from "../lib/db";
import { hashPassword } from "../lib/crypto";

type SeedUser = {
  email: string;
  name: string;
  role: "salesperson" | "approver" | "admin";
  password: string;
};

function collect(): SeedUser[] {
  const spec: { envEmail: string; envPass: string; name: string; role: SeedUser["role"] }[] = [
    {
      envEmail: "SEED_SALESPERSON_EMAIL",
      envPass: "SEED_SALESPERSON_PASSWORD",
      name: "Ada Okonkwo",
      role: "salesperson",
    },
    {
      envEmail: "SEED_APPROVER_EMAIL",
      envPass: "SEED_APPROVER_PASSWORD",
      name: "Tunde Bakare",
      role: "approver",
    },
    /**
     * The administrator.
     *
     * Added when team management shipped, and it is not optional the way it
     * looks. Adding a colleague, granting approval authority and removing
     * somebody who has left are all admin-only, so a deployment seeded with
     * only a salesperson and an approver has no account that can ever change
     * who those two are. The team page exists and nobody can reach it.
     */
    {
      envEmail: "SEED_ADMIN_EMAIL",
      envPass: "SEED_ADMIN_PASSWORD",
      name: "Ngozi Eze",
      role: "admin",
    },
  ];

  const users: SeedUser[] = [];
  const missing: string[] = [];

  for (const s of spec) {
    const email = process.env[s.envEmail]?.trim();
    const password = process.env[s.envPass]?.trim();
    if (!email || !password) {
      missing.push(`${s.envEmail} / ${s.envPass}`);
      continue;
    }
    if (password.length < 8) {
      throw new Error(`${s.envPass} must be at least 8 characters.`);
    }
    users.push({ email: email.toLowerCase(), name: s.name, role: s.role, password });
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing seed credentials: ${missing.join(", ")}. ` +
        "Set them in build/.env.local — see build/.env.example.",
    );
  }
  return users;
}

async function main(): Promise<void> {
  const users = collect();

  for (const u of users) {
    const password_hash = await hashPassword(u.password);
    const rows = await query<{ id: string; created: boolean }>(
      `INSERT INTO users (email, name, role, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(email)) DO UPDATE
         SET name = EXCLUDED.name,
             role = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash,
             is_active = true,
             updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [u.email, u.name, u.role, password_hash],
    );
    const row = rows[0];
    // xmax = 0 is true only for a genuinely inserted row, so the script can
    // report what it actually did instead of claiming to have created two
    // users every time it runs.
    console.log(`  ${row?.created ? "+" : "~"} ${u.role.padEnd(12)} ${u.email}`);
  }

  const counts = await query<{ role: string; n: string }>(
    "SELECT role, count(*)::text AS n FROM users GROUP BY role ORDER BY role",
  );
  console.log("\nUsers in database:");
  for (const c of counts) console.log(`  ${c.role.padEnd(12)} ${c.n}`);
  console.log("\nSeed complete. Passwords are the SEED_*_PASSWORD values in .env.local.");
}

main()
  .catch((err: unknown) => {
    console.error(`\nSeed failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
