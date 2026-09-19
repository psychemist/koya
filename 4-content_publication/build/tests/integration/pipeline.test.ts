/**
 * Integration tests, against a real Postgres.
 *
 * These cover the defects that unit tests structurally cannot reach, because
 * every one of them was a bug about STATE: a flag that outlived the draft it
 * described, a request wound into a status nothing could move it out of, a
 * queue row abandoned mid-dispatch. None of that is visible from a pure
 * function.
 *
 * Both notification lanes are disabled before anything is imported, so a run
 * cannot make an outbound call or send mail. `config` reads the environment
 * once at module load, which is exactly why the imports below are dynamic and
 * come after these two lines.
 *
 * Everything created here is keyed `test:<uuid>` and removed afterwards, by
 * the ids this run recorded itself.
 */
process.env.RESEND_API_KEY = '';
process.env.N8N_NOTIFY_WEBHOOK_URL = '';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { query, one, pool } = await import('../../lib/db.js');
const { evaluate } = await import('../../lib/pipeline/evaluate.js');
const { enqueue, tick } = await import('../../lib/pipeline/queue.js');
const { approve, approvalIsCurrent } = await import('../../lib/pipeline/approve.js');

let requester: string;
let editor: string;
const made: string[] = [];

before(async () => {
  const m = await one<{ id: string }>(`select id from public.users where role='manager' limit 1`);
  const e = await one<{ id: string }>(`select id from public.users where role='editor' limit 1`);
  assert.ok(m && e, 'these tests need the seeded manager and editor: npm run seed');
  requester = m!.id;
  editor = e!.id;
});

after(async () => {
  // Children cascade from content_requests, so one statement per id is enough.
  // Only ids created by this run are in `made`.
  for (const id of made) {
    await query(`delete from public.content_requests where id=$1`, [id]).catch(() => {});
  }
  await pool().end();
});

async function makeRequest(status = 'evaluating', channels = ['x']) {
  const row = await one<{ id: string }>(
    `insert into public.content_requests
       (idempotency_key, idea, audience, goal, channels, status, requester_id)
     values ($1,$2,'test audience','awareness',$3,$4,$5) returning id`,
    [`test:${randomUUID()}`, `Test request ${randomUUID().slice(0, 8)}`, channels, status, requester]);
  made.push(row!.id);
  return row!.id;
}

async function putAsset(requestId: string, kind: string, revision: number, body: string) {
  await query(
    `insert into public.assets (request_id, kind, revision, body, origin, image_slot)
     values ($1,$2,$3,$4,'generate',$5)`,
    [requestId, kind, revision, body,
     kind === 'article' ? JSON.stringify({ placement: 'top', alt: 'a', brief: 'b' }) : null]);
}

const openFlags = (id: string) =>
  query<any>(`select code, status from public.flags where request_id=$1 and status='open'`, [id]);

/* ===================================================================
   THE BUG NOTHING COULD BE APPROVED OUT OF
   =================================================================== */

test("a second evaluation supersedes the first run's flags instead of stacking them", async () => {
  const id = await makeRequest('evaluating', ['x']);
  // 312 characters: the exact case a JSON schema cannot express and will
  // happily return anyway.
  await putAsset(id, 'x', 1, 'x'.repeat(312));

  const first = await evaluate({ requestId: id, correlationId: randomUUID() });
  const afterFirst = await openFlags(id);
  assert.ok(afterFirst.some((f) => f.code.startsWith('x_')), 'the over-length post should flag');
  assert.ok(first.blocking > 0);

  // Nothing changed, so the second run must reach the same verdict with the
  // same number of rows, not twice as many.
  await evaluate({ requestId: id, correlationId: randomUUID() });
  const afterSecond = await openFlags(id);
  assert.equal(afterSecond.length, afterFirst.length,
    'flags accumulated across evaluations instead of being superseded');
});

test('fixing the draft clears the flag in the DATABASE, not just in the return value', async () => {
  const id = await makeRequest('evaluating', ['x']);
  await putAsset(id, 'x', 1, 'x'.repeat(312));
  await evaluate({ requestId: id, correlationId: randomUUID() });
  assert.ok((await openFlags(id)).some((f) => f.code === 'x_too_long'));

  // The revision the loop would write.
  await putAsset(id, 'x', 2, 'A short, well behaved post about hiring.');
  await evaluate({ requestId: id, correlationId: randomUUID() });

  const still = await openFlags(id);
  assert.ok(!still.some((f) => f.code === 'x_too_long'),
    'the old length flag stayed open, so approval would be refused forever');

  const resolved = await query<any>(
    `select count(*)::int as n from public.flags
      where request_id=$1 and code='x_too_long' and status='resolved'`, [id]);
  assert.ok(resolved[0].n > 0, 'the superseded flag should be kept as history, not dropped');
});

/* ===================================================================
   APPROVAL
   =================================================================== */

test('an author cannot approve their own request, whatever the UI sent', async () => {
  const id = await makeRequest('needs_review', ['x']);
  await putAsset(id, 'x', 1, 'Fine.');
  const v = (await one<any>(`select version from public.content_requests where id=$1`, [id]))!.version;

  await assert.rejects(
    () => approve({
      requestId: id, kind: 'x', actorId: requester, actorRole: 'manager',
      decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: v,
    }),
    /cannot approve it/,
  );
});

test('an open blocking flag refuses approval in the database, not in the UI', async () => {
  const id = await makeRequest('needs_review', ['x']);
  await putAsset(id, 'x', 1, 'Fine.');
  await query(
    `insert into public.flags (request_id, asset_kind, code, severity, message)
     values ($1,'x','test_blocking','blocking','planted by a test')`, [id]);
  const v = (await one<any>(`select version from public.content_requests where id=$1`, [id]))!.version;

  await assert.rejects(
    () => approve({
      requestId: id, kind: 'x', actorId: editor, actorRole: 'editor',
      decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: v,
    }),
    /blocking issue/,
  );
});

test('editing an asset after approval voids that approval before dispatch', async () => {
  const id = await makeRequest('needs_review', ['x']);
  await putAsset(id, 'x', 1, 'The approved words.');
  const v = (await one<any>(`select version from public.content_requests where id=$1`, [id]))!.version;

  await approve({
    requestId: id, kind: 'x', actorId: editor, actorRole: 'editor',
    decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: v,
  });
  assert.equal((await approvalIsCurrent(id, 'x')).valid, true);

  // The whole attack on "a human approved it": approve something clean, then
  // change it before the queue runs.
  await putAsset(id, 'x', 2, 'Completely different words.');
  const after = await approvalIsCurrent(id, 'x');
  assert.equal(after.valid, false);
  assert.match(after.reason!, /voided the approval/);
});

/* ===================================================================
   THE QUEUE
   =================================================================== */

test('a queue row for an unapproved asset is blocked, never sent', async () => {
  const id = await makeRequest('scheduled', ['x']);
  await putAsset(id, 'x', 1, 'Never approved.');
  await enqueue({
    requestId: id, channel: 'x', assetRevision: 1,
    payload: { body: 'Never approved.' }, dueAt: new Date(Date.now() - 1000),
  });

  await tick(10);
  const row = await one<any>(
    `select state, error_code from public.publish_queue where request_id=$1`, [id]);
  assert.equal(row.state, 'blocked');
  assert.equal(row.error_code, 'approval_not_current');
});

test('a row abandoned mid-dispatch is reclaimed, not stranded at claimed forever', async () => {
  const id = await makeRequest('scheduled', ['x']);
  await putAsset(id, 'x', 1, 'Body.');
  await enqueue({
    requestId: id, channel: 'x', assetRevision: 1,
    payload: { body: 'Body.' }, dueAt: new Date(Date.now() - 1000),
  });

  // Exactly what a worker killed between claiming and dispatching leaves.
  await query(
    `update public.publish_queue
        set state='claimed', claimed_at = now() - interval '30 minutes'
      where request_id=$1`, [id]);

  assert.equal(
    (await one<any>(`select state from public.publish_queue where request_id=$1`, [id])).state,
    'claimed');

  await tick(10);

  const after = await one<any>(
    `select state from public.publish_queue where request_id=$1`, [id]);
  assert.notEqual(after.state, 'claimed',
    'the stranded row was never picked back up, so the post would never go out');
});

test('a duplicate enqueue collides on the idempotency key instead of queueing twice', async () => {
  const id = await makeRequest('scheduled', ['x']);
  await putAsset(id, 'x', 1, 'Body.');
  const dueAt = new Date();

  const first = await enqueue({
    requestId: id, channel: 'x', assetRevision: 1, payload: { body: 'Body.' }, dueAt });
  const second = await enqueue({
    requestId: id, channel: 'x', assetRevision: 1, payload: { body: 'Body.' }, dueAt });

  assert.ok(first, 'the first enqueue should create a row');
  assert.equal(second, null, 'the replay must not create a second row');

  assert.equal(
    (await query<any>(`select id from public.publish_queue where request_id=$1`, [id])).length, 1);
});

/**
 * THE CASE THE TEST ABOVE DOES NOT COVER, AND THE ONE THAT ACTUALLY HAPPENED.
 *
 * That test passes the SAME `dueAt` object to both enqueues, so under the old
 * time-shaped key both calls produced the same string and collided. It
 * encoded the only scenario that already worked.
 *
 * Approvals do not arrive at the same instant. The approve route re-enqueues
 * every already-approved channel on each approval, and `dueAt` for immediate
 * publishing is `new Date()` read at approval time. A real run approved
 * LinkedIn at 02:27:59 and X at 02:28:26; the re-enqueue of LinkedIn 27
 * seconds later fell in the next minute, produced a key nothing had seen,
 * and put a second row on the queue for a post already queued. Both went to
 * LinkedIn, each carrying its own provider idempotency header, so the
 * provider saw two posts rather than one retried.
 *
 * The times below straddle a minute boundary on purpose. With a key built
 * from identity rather than from the clock, when the second enqueue happens
 * stops mattering.
 */
test('a re-enqueue in a later minute is still the same post, not a second one', async () => {
  const id = await makeRequest('scheduled', ['linkedin']);
  await putAsset(id, 'linkedin', 1, 'Body.');

  const first = await enqueue({
    requestId: id, channel: 'linkedin', assetRevision: 1,
    payload: { body: 'Body.' }, dueAt: new Date('2026-09-19T02:27:59.000Z') });
  const later = await enqueue({
    requestId: id, channel: 'linkedin', assetRevision: 1,
    payload: { body: 'Body.' }, dueAt: new Date('2026-09-19T02:28:26.000Z') });

  assert.ok(first, 'the first enqueue should create a row');
  assert.equal(later, null, 'a later minute must not create a second row for the same post');

  const rows = await query<any>(
    `select id from public.publish_queue where request_id=$1 and channel='linkedin'`, [id]);
  assert.equal(rows.length, 1, 'one approved revision is one post, however many times it is queued');
});

/** A genuinely new revision IS a different post and must get its own row. */
test('a new asset revision queues separately rather than collapsing', async () => {
  const id = await makeRequest('scheduled', ['linkedin']);
  await putAsset(id, 'linkedin', 1, 'First.');
  await putAsset(id, 'linkedin', 2, 'Second.');

  const r1 = await enqueue({
    requestId: id, channel: 'linkedin', assetRevision: 1,
    payload: { body: 'First.' }, dueAt: new Date('2026-09-19T02:27:59.000Z') });
  const r2 = await enqueue({
    requestId: id, channel: 'linkedin', assetRevision: 2,
    payload: { body: 'Second.' }, dueAt: new Date('2026-09-19T02:27:59.000Z') });

  assert.ok(r1, 'revision 1 should queue');
  assert.ok(r2, 'revision 2 is a different post and must not be swallowed by revision 1');
});

/**
 * AN ARTICLE NOBODY JUDGED IS NOT AN ARTICLE THAT PASSED.
 *
 * Tier 0 is deterministic and runs on every asset; Tier 1 is the model judge
 * and reads the article only. With no Tier 1 rows, an empty findings list
 * means the question was never asked — indistinguishable, on screen, from
 * having been asked and answered well.
 *
 * It is a real state: a hand edit re-runs Tier 0 with `skipJudge`, and a
 * revision pass that dies before its re-evaluate leaves the same shape. Three
 * article revisions in the live database sat at zero Tier 1 rows.
 */
test('an unjudged article cannot be approved, and can be once it is judged', async () => {
  const id = await makeRequest('needs_review', ['linkedin']);
  await putAsset(id, 'article', 1, '# Title\n\n## One\n\nBody.');
  const v = (await one<any>(`select version from public.content_requests where id=$1`, [id]))!.version;

  const attempt = () => approve({
    requestId: id, kind: 'article', actorId: editor, actorRole: 'editor',
    decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: v,
  });

  await assert.rejects(attempt, /judge has not scored/,
    'with no Tier 1 rows the article must be refused');

  // Score the CURRENT revision, which is what the gate asks about.
  const asset = await one<any>(
    `select id from public.assets where request_id=$1 and kind='article'
      order by revision desc limit 1`, [id]);
  await query(
    `insert into public.evaluations (asset_id, tier, criterion, score, verdict, evidence, required_action)
     values ($1,1,'grounding',4,'pass','evidence','none')`, [asset!.id]);

  const ok = await attempt();
  assert.equal(ok.revision, 1, 'once judged, the same approval goes through');
});

/**
 * The channel posts are never judged by design, so requiring a score would
 * make them permanently unapprovable — the gate has to be article-only.
 */
test('a channel post is approvable without a judge score', async () => {
  const id = await makeRequest('needs_review', ['linkedin']);
  await putAsset(id, 'linkedin', 1, 'Problem.\n\nSolution.\n\nWhat would you add?');
  const v = (await one<any>(`select version from public.content_requests where id=$1`, [id]))!.version;

  const ok = await approve({
    requestId: id, kind: 'linkedin', actorId: editor, actorRole: 'editor',
    decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: v,
  });
  assert.equal(ok.revision, 1);
});

/* ===================================================================
   THE MONOTONICITY GUARD

   The guard keeps the better draft when a revision scores worse. It
   threw every time it fired, because `sections` is a jsonb ARRAY and
   node-postgres formats a JS array as a Postgres array literal rather
   than as JSON. A real run scored 3.8 then 3.6, hit this, and lost
   the whole generate instead of keeping the 3.8.
   =================================================================== */

test('reverting to the better draft round-trips jsonb sections without throwing', async () => {
  const id = await makeRequest('evaluating', ['x']);

  const sections = [
    { heading: 'Why the FDE Loop Looks Different', body: 'Prose.', cites: ['S1P1'] },
    { heading: 'Gate One', body: 'More prose.', cites: [] },
  ];
  const slot = { placement: 'after the intro', alt: 'An engineer at a whiteboard', brief: 'brief' };

  await query(
    `insert into public.assets (request_id, kind, revision, body, sections, image_slot, origin)
     values ($1,'article',1,'# Parent',$2,$3,'generate')`,
    [id, JSON.stringify(sections), JSON.stringify(slot)]);

  const parent = await one<any>(
    `select sections, image_slot from public.assets where request_id=$1 and revision=1`, [id]);

  // The exact shape the driver hands back, written straight into a new row.
  // Without JSON.stringify this raises `invalid input syntax for type json`.
  await query(
    `insert into public.assets (request_id, kind, revision, parent_revision, body,
                                sections, image_slot, origin, cost_usd)
     values ($1,'article',2,1,'# Reverted',$2,$3,'revert',0)`,
    [id, JSON.stringify(parent.sections ?? []),
     parent.image_slot == null ? null : JSON.stringify(parent.image_slot)]);

  const reverted = await one<any>(
    `select sections, image_slot, origin from public.assets
      where request_id=$1 and revision=2`, [id]);

  assert.equal(reverted.origin, 'revert');
  assert.deepEqual(reverted.sections, sections, 'the section structure must survive the revert');
  assert.deepEqual(reverted.image_slot, slot);
});
