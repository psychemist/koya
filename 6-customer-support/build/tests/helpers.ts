/**
 * Integration tests run against a real database, because the constraints are
 * the thing under test. A mocked create_support_ticket would happily accept a
 * duplicate, which is exactly the bug the partial unique index exists to make
 * impossible.
 *
 * TEST_DATABASE_URL, when set, wins over DATABASE_URL. It is assigned here, at
 * import, before lib/db.ts creates its pool on the first query.
 */
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { after } from 'node:test';
import { one, query } from '../lib/db.ts';
import type { Channel, ConversationRow } from '../lib/conversations.ts';

export const skipWithoutDatabase = !process.env.DATABASE_URL;

// Idle pooled connections keep a test file's process alive for the pool's 30 s
// idle timeout, which made every file in the suite wait half a minute to exit.
after(async () => { await globalThis.__relaypayPool?.end(); globalThis.__relaypayPool = undefined; });

/**
 * The default channel is eval, so a test that forgets to choose one can never
 * reach Cal.com, Discord or the inbox: eval conversations book in dry run (Task 10).
 */
export async function newConversation(patch: { channel?: Channel; verified_customer_id?: string } = {}): Promise<ConversationRow> {
  return (await one<ConversationRow>(
    `insert into public.conversations (channel, caller_identifier, verified_customer_id) values ($1, 'test', $2) returning *`,
    [patch.channel ?? 'eval', patch.verified_customer_id ?? null]))!;
}

/**
 * Deletes the conversation and, by cascade, everything attached to it.
 *
 * The ledger goes first and explicitly, because spend_ledger.conversation_id is
 * ON DELETE SET NULL: right in production, wrong in a test suite, where
 * synthetic spend would survive every run and count against the real daily cap
 * (the Week 5 dropRun lesson).
 */
export async function dropConversation(id: string): Promise<void> {
  await query('delete from public.spend_ledger where conversation_id = $1', [id]);
  await query('delete from public.conversations where id = $1', [id]);
}
