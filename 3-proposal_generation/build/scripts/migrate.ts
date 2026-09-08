/**
 * Migration runner.
 *
 * Run it as many times as you like: applied migrations are recorded in
 * `schema_migrations` and skipped. Three properties make it safe under the
 * "automations may run more than once" rule:
 *
 * 1. An advisory lock is taken first, so two runners — a deploy hook and a
 *    developer, say — serialise instead of both executing 001 and racing on
 *    CREATE TABLE.
 * 2. Each migration runs inside its own transaction together with the INSERT
 *    that records it. A migration cannot be half-applied, and cannot be applied
 *    without being recorded.
 * 3. Checksums are compared on every run. If a file that has already been
 *    applied is edited, the runner stops and says so rather than silently
 *    letting the database and the repository disagree — the failure mode where
 *    production has a column your migrations do not mention.
 *
 * Usage:  npm run migrate            apply pending
 *         npm run migrate -- --status  report only, change nothing
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "../lib/db";

// A constant, arbitrary key. Any two processes using this same number contend.
const LOCK_KEY = 0x4b_4f_59_41; // "KOYA"

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

type Applied = { version: string; checksum: string };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadFiles(): Promise<{ version: string; sql: string; checksum: string }[]> {
  const names = (await readdir(MIGRATIONS_DIR))
    .filter((n) => n.endsWith(".sql"))
    // Zero-padded numeric prefixes, so a plain lexical sort is the right order.
    .sort();
  const out = [];
  for (const name of names) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    out.push({ version: name.replace(/\.sql$/, ""), sql, checksum: sha256(sql) });
  }
  return out;
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes("--status");
  const client = await pool().connect();

  try {
    // Ledger first, and outside the lock: it is idempotent and every path needs it.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = await loadFiles();
    const { rows: applied } = await client.query<Applied>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const appliedBy = new Map(applied.map((r) => [r.version, r.checksum]));

    // Drift check before doing any work — a mismatch means the repository and
    // the database disagree about what has already run, and guessing which is
    // right is exactly the wrong move.
    const drifted = files.filter(
      (f) => appliedBy.has(f.version) && appliedBy.get(f.version) !== f.checksum,
    );
    if (drifted.length > 0) {
      for (const f of drifted) {
        console.error(
          `  ✗ ${f.version}: already applied, but the file has changed since.\n` +
            `      in database ${appliedBy.get(f.version)}\n` +
            `      on disk     ${f.checksum}`,
        );
      }
      throw new Error(
        `${drifted.length} migration(s) edited after being applied. ` +
          "Add a new migration instead of editing an applied one.",
      );
    }

    const pending = files.filter((f) => !appliedBy.has(f.version));

    if (statusOnly) {
      console.log(`applied: ${applied.length}   pending: ${pending.length}`);
      for (const f of files) {
        console.log(`  ${appliedBy.has(f.version) ? "✓" : "·"} ${f.version}`);
      }
      return;
    }

    if (pending.length === 0) {
      console.log(`Nothing to do — ${applied.length} migration(s) already applied.`);
      return;
    }

    // Serialise concurrent runners. pg_advisory_lock is session-scoped and this
    // is a dedicated client, so it is held for exactly this run.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      // Re-read under the lock: another runner may have applied everything
      // while we were queueing for it.
      const { rows: fresh } = await client.query<Applied>("SELECT version FROM schema_migrations");
      const freshSet = new Set(fresh.map((r) => r.version));

      for (const f of pending) {
        if (freshSet.has(f.version)) {
          console.log(`  ↷ ${f.version} applied by another runner while waiting`);
          continue;
        }
        const started = Date.now();
        await client.query("BEGIN");
        try {
          await client.query(f.sql);
          await client.query(
            "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
            [f.version, f.checksum],
          );
          await client.query("COMMIT");
          console.log(`  ✓ ${f.version}  (${Date.now() - started}ms)`);
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`  ✗ ${f.version} failed and was rolled back`);
          throw err;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }

    console.log("Migrations up to date.");
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error(`\nMigration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
