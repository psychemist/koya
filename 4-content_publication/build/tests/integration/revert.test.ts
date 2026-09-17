/**
 * The invariant a revert breaks if nobody re-checks: OPEN FINDINGS MUST
 * DESCRIBE THE REVISION THAT IS CURRENT NOW.
 *
 * A revert writes a new revision carrying the parent's body. The findings at
 * that moment describe the revision it just replaced. On a real run that left
 * a 338-character X post as the current revision with no length finding
 * against it, because the finding had been resolved by the 276-character
 * version the revert threw away. `approve` counts open blocking flags, so the
 * gate would have passed a post that breaks X's hard limit.
 *
 * This reconstructs that sequence, with no model call anywhere: `evaluate`
 * only reaches Tier 1 when an article exists, and this request has none.
 */
process.env.RESEND_API_KEY = '';
process.env.N8N_NOTIFY_WEBHOOK_URL = '';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { query, one, pool } = await import('../../lib/db.js');
const { evaluate } = await import('../../lib/pipeline/evaluate.js');

let requester: string;
const made: string[] = [];

before(async () => {
  const m = await one<{ id: string }>(`select id from public.users where role='manager' limit 1`);
  assert.ok(m, 'this test needs the seeded manager: npm run seed');
  requester = m!.id;
});

after(async () => {
  for (const id of made) {
    await query(`delete from public.content_requests where id=$1`, [id]).catch(() => {});
  }
  await pool().end();
});

test('a revert to a failing body re-raises the finding it had resolved', async () => {
  const row = await one<{ id: string }>(
    `insert into public.content_requests
       (idempotency_key, idea, audience, goal, channels, status, requester_id)
     values ($1,'Revert invariant','test audience','awareness',$2,'evaluating',$3)
     returning id`,
    [`test:${randomUUID()}`, ['x'], requester]);
  const id = row!.id;
  made.push(id);

  const tooLong = 'x'.repeat(338);   // the exact length from the real run
  const shortEnough = 'A post that fits inside the limit.';

  const put = (rev: number, body: string, origin: string) =>
    query(`insert into public.assets (request_id, kind, revision, body, origin)
           values ($1,'x',$2,$3,$4)`, [id, rev, body, origin]);

  // 1. The first draft is too long, and is flagged.
  await put(1, tooLong, 'generate');
  await evaluate({ requestId: id, correlationId: randomUUID() });
  const open1 = await query<any>(
    `select code from public.flags where request_id=$1 and status='open'`, [id]);
  assert.ok(open1.some((f) => f.code === 'x_too_long'));

  // 2. The revision fixes it, and the finding closes.
  await put(2, shortEnough, 'auto_revise');
  await evaluate({ requestId: id, correlationId: randomUUID() });
  const open2 = await query<any>(
    `select code from public.flags where request_id=$1 and status='open'`, [id]);
  assert.ok(!open2.some((f) => f.code === 'x_too_long'),
    'the fix should have closed the length finding');

  // 3. The monotonicity guard reverts, restoring the over-length body.
  await put(3, tooLong, 'revert');

  // Before re-evaluating, the database still says the post is fine. That is
  // precisely the state that would let approval through.
  const stale = await query<any>(
    `select code from public.flags where request_id=$1 and status='open'`, [id]);
  assert.ok(!stale.some((f) => f.code === 'x_too_long'),
    'sanity check: the stale verdict is what makes re-evaluation necessary');

  // 4. Re-evaluating after the revert is what restores the truth.
  await evaluate({ requestId: id, correlationId: randomUUID() });
  const open3 = await query<any>(
    `select code, severity from public.flags where request_id=$1 and status='open'`, [id]);
  assert.ok(
    open3.some((f) => f.code === 'x_too_long' && f.severity === 'blocking'),
    'after a revert the findings must describe the revision that is now current');
});

/**
 * A process that dies mid-run cannot wind back its own status. The route's
 * own catch block covers a thrown error; nothing covers a deploy, an OOM
 * kill, or a container recycle. The request is then stranded in a transient
 * status that no route accepts as a starting point, which is the dead end
 * that cost $0.196 and produced nothing the first time it happened.
 */
const { sweepStalledRequests } = await import('../../lib/pipeline/queue.js');

test('a request abandoned mid-flight is wound back to a state a person can act from', async () => {
  const mk = async (status: string, minutesAgo: number, withAngles: boolean) => {
    const row = await one<{ id: string }>(
      `insert into public.content_requests
         (idempotency_key, idea, audience, goal, channels, status, requester_id, updated_at)
       values ($1,'Stalled','test audience','awareness',$2,$3,$4, now() - ($5 || ' minutes')::interval)
       returning id`,
      [`test:${randomUUID()}`, ['x'], status, requester, String(minutesAgo)]);
    made.push(row!.id);
    if (withAngles) {
      await query(
        `insert into public.angles (request_id, ord, title, thesis, selected_at, selected_by)
         values ($1,0,'An angle','A thesis', now(), $2)`, [row!.id, requester]);
    }
    return row!.id;
  };

  const stuckWithAngles = await mk('drafting', 90, true);
  const stuckNoAngles = await mk('researching', 90, false);

  // Old status, but still emitting events: a long judge pass looks exactly
  // like this, and sweeping it would kill live work.
  const stillWorking = await mk('drafting', 90, true);
  await query(
    `insert into public.events (correlation_id, request_id, stage, outcome)
     values ($1,$2,'evaluate.tier1','ok')`, [randomUUID(), stillWorking]);

  await sweepStalledRequests(30);

  const statusOf = async (id: string) =>
    (await one<any>(`select status from public.content_requests where id=$1`, [id])).status;

  assert.equal(await statusOf(stuckWithAngles), 'angles_ready',
    'a stalled request with angles goes back to the picker');
  assert.equal(await statusOf(stuckNoAngles), 'draft',
    'with nothing to pick from, it goes back to where research starts');
  assert.equal(await statusOf(stillWorking), 'drafting',
    'a run that is still emitting events must not be interrupted');

  // The choice has to be retakeable, so the selection goes with it.
  const angle = await one<any>(
    `select selected_at from public.angles where request_id=$1`, [stuckWithAngles]);
  assert.equal(angle.selected_at, null);
});
