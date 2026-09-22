import { randomUUID } from 'node:crypto';
import { query, one } from '../lib/db.ts';
import type { RunRow } from '../lib/runs.ts';

/**
 * Integration tests run against the real database, because the constraints
 * are the thing under test. A mocked `save_lead` would happily accept a
 * qualified lead with no evidence, which is exactly the bug the CHECK exists
 * to make impossible.
 */
export async function seedRun(patch: Partial<RunRow> = {}): Promise<RunRow> {
  const keys = Object.keys(patch);
  const cols = ['idempotency_key', 'objective', ...keys];
  const vals = [randomUUID(), 'test objective', ...keys.map((k) => (patch as any)[k])];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
  const row = await one<RunRow>(
    `insert into public.runs (${cols.join(',')}) values (${placeholders}) returning *`,
    vals,
  );
  if (!row) throw new Error('seedRun inserted nothing');
  return row;
}

/** Deletes the run and, by cascade, everything attached to it. */
export async function dropRun(runId: string): Promise<void> {
  await query('delete from public.runs where id = $1', [runId]);
}

export const skipWithoutDatabase = !process.env.DATABASE_URL;
