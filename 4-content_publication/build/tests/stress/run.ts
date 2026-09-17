/**
 * Stress and concurrency harness.
 *
 * Unit tests prove a function is right when it runs alone. Every serious
 * failure this system can have is a failure of two things running at once:
 * two workers taking the same queue row and posting twice to a client's feed,
 * two editors approving the same draft, a double-clicked intake form raising
 * the same request twice. Those are the claims the schema and the queue are
 * built on, and not one of them is observable a single call at a time.
 *
 * So this runs them concurrently, against the real database, and checks the
 * invariant rather than the happy path.
 *
 * Safety:
 *  - both notification lanes are blanked before any import, so nothing can be
 *    emailed or posted to a webhook;
 *  - every row it creates is keyed `stress:<uuid>` and removed at the end;
 *  - no model call is made anywhere in here, so a run costs nothing.
 *
 * Usage: npm run test:stress          (the dev server must be on :3100)
 */
process.env.RESEND_API_KEY = '';
process.env.N8N_NOTIFY_WEBHOOK_URL = '';

import { randomUUID } from 'node:crypto';

const { query, one, pool } = await import('../../lib/db.js');
const { enqueue, tick } = await import('../../lib/pipeline/queue.js');
const { approve } = await import('../../lib/pipeline/approve.js');
const { connectorFor } = await import('../../lib/publish/index.js');

const BASE = process.env.STRESS_BASE_URL || 'http://localhost:3100';
const made: string[] = [];
const results: { scenario: string; expected: string; actual: string; pass: boolean }[] = [];

function check(scenario: string, expected: string, actual: string, pass: boolean) {
  results.push({ scenario, expected, actual, pass });
  console.log(
    `${pass ? '  ok  ' : ' FAIL '} ${scenario}\n` +
    `         expected  ${expected}\n` +
    `         actual    ${actual}\n`);
}

async function ids() {
  const m = await one<any>(`select id from public.users where role='manager' limit 1`);
  const e = await one<any>(`select id from public.users where role='editor' limit 1`);
  if (!m || !e) throw new Error('Run `npm run seed` first: this needs the manager and the editor.');
  return { requester: m.id, editor: e.id };
}

async function makeRequest(requester: string, status: string, channels: string[]) {
  const row = await one<{ id: string }>(
    `insert into public.content_requests
       (idempotency_key, idea, audience, goal, channels, status, requester_id)
     values ($1,$2,'stress audience','awareness',$3,$4,$5) returning id`,
    [`stress:${randomUUID()}`, `Stress ${randomUUID().slice(0, 8)}`, channels, status, requester]);
  made.push(row!.id);
  return row!.id;
}

const putAsset = (id: string, kind: string, rev: number, body: string) =>
  query(`insert into public.assets (request_id, kind, revision, body, origin)
         values ($1,$2,$3,$4,'generate')`, [id, kind, rev, body]);

const versionOf = async (id: string) =>
  (await one<any>(`select version from public.content_requests where id=$1`, [id]))!.version;

async function approveAsEditor(id: string, editor: string) {
  await approve({
    requestId: id, kind: 'x', actorId: editor, actorRole: 'editor',
    decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: await versionOf(id),
  });
}

/* ==================================================================
   1. TWO WORKERS, ONE QUEUE
   The claim: FOR UPDATE SKIP LOCKED means concurrent ticks take
   DISJOINT sets. If it does not hold, a post goes out twice.
   ================================================================== */
async function concurrentTicks(requester: string, editor: string, rows = 12, workers = 6) {
  const requestIds: string[] = [];
  for (let i = 0; i < rows; i++) {
    const id = await makeRequest(requester, 'needs_review', ['x']);
    await putAsset(id, 'x', 1, `Stress post ${i}.`);
    await approveAsEditor(id, editor);
    await enqueue({
      requestId: id, channel: 'x', assetRevision: 1,
      payload: { body: `Stress post ${i}.` }, dueAt: new Date(Date.now() - 1000),
    });
    requestIds.push(id);
  }

  const started = Date.now();
  const ticks = await Promise.all(Array.from({ length: workers }, () => tick(rows)));
  const elapsed = Date.now() - started;

  const totalClaimed = ticks.reduce((n, t) => n + t.claimed, 0);
  check(
    `${workers} workers tick ${rows} due rows at once`,
    `each row claimed exactly once, ${rows} in total`,
    `${totalClaimed} claims across ${workers} workers in ${elapsed}ms`,
    totalClaimed === rows,
  );

  // X has no credentials here, so the honest outcome is queued_manual: the
  // post exists and was approved, and a person copies it out. Never `sent`.
  const states = await query<any>(
    `select state, count(*)::int as n from public.publish_queue
      where request_id = any($1) group by state`, [requestIds]);
  const sent = states.find((s) => s.state === 'sent')?.n ?? 0;
  check(
    'an unconfigured channel, under load',
    'no row marked sent',
    `${sent} sent. States: ${states.map((s) => `${s.state}=${s.n}`).join(', ')}`,
    sent === 0,
  );
}

/* ==================================================================
   2. A CONNECTOR THAT THROWS
   The claim: one connector raising must not abandon its own row at
   `claimed`, nor skip the rest of the batch, which is other clients'
   posts.
   ================================================================== */
async function throwingConnector(requester: string, editor: string) {
  const id = await makeRequest(requester, 'needs_review', ['x']);
  await putAsset(id, 'x', 1, 'Body.');
  await approveAsEditor(id, editor);
  await enqueue({
    requestId: id, channel: 'x', assetRevision: 1,
    payload: { body: 'Body.' }, dueAt: new Date(Date.now() - 1000),
  });

  // Patch the live instance so it is available and raises on dispatch. This
  // is a provider SDK blowing up on a shape it did not expect.
  const x = connectorFor('x') as any;
  const [wasAvailable, wasPublish] = [x.available, x.publish];
  x.available = () => true;
  x.publish = async () => { throw new Error('simulated provider SDK explosion'); };

  let tickThrew = false;
  try {
    await tick(10);
  } catch {
    tickThrew = true;
  } finally {
    x.available = wasAvailable;
    x.publish = wasPublish;
  }

  const row = await one<any>(
    `select state, error_code from public.publish_queue where request_id=$1`, [id]);
  check(
    'a connector raises mid-dispatch',
    'the tick survives, and the row records failed rather than staying claimed',
    tickThrew ? 'the tick itself threw' : `state=${row?.state}, code=${row?.error_code}`,
    !tickThrew && row?.state === 'failed' && row?.error_code === 'x_connector_threw',
  );
}

/* ==================================================================
   3. TWO EDITORS, ONE DRAFT
   The claim that matters is not how many approval records exist. It
   is how many posts would go out.
   ================================================================== */
async function concurrentApprovals(requester: string, editor: string, actors = 8) {
  const id = await makeRequest(requester, 'needs_review', ['x']);
  await putAsset(id, 'x', 1, 'One draft, many reviewers.');
  const v = await versionOf(id);

  const settled = await Promise.allSettled(
    Array.from({ length: actors }, () => approve({
      requestId: id, kind: 'x', actorId: editor, actorRole: 'editor',
      decision: 'approved', evidenceHash: 'h'.repeat(32), expectedVersion: v,
    })),
  );
  const ok = settled.filter((s) => s.status === 'fulfilled').length;

  await Promise.all(Array.from({ length: actors }, () => enqueue({
    requestId: id, channel: 'x', assetRevision: 1,
    payload: { body: 'One draft, many reviewers.' }, dueAt: new Date('2026-01-01T00:00:00Z'),
  })));
  const queued = (await query<any>(
    `select id from public.publish_queue where request_id=$1`, [id])).length;

  check(
    `${actors} simultaneous approvals of one draft`,
    'exactly 1 queue row, whatever happens to the approval records',
    `${queued} queue row(s), ${ok} approval record(s) written`,
    queued === 1,
  );
}

/* ==================================================================
   4. A DOUBLE-CLICKED INTAKE FORM
   The claim: one idempotency key means one request, even when the
   submissions race. This goes through the real HTTP route, because
   the race is between two route handlers and not two SQL statements.
   ================================================================== */
async function concurrentIntake(attempts = 6) {
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'manager@koya.test',
      password: process.env.SEED_PASSWORD || 'desk-demo-2026',
    }),
  }).catch(() => null);

  if (!login?.ok) {
    check('one idempotency key, submitted concurrently',
      'a session', 'could not sign in. Is the dev server up on :3100?', false);
    return;
  }
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const key = `stress:${randomUUID()}`;

  const bodies = await Promise.all(Array.from({ length: attempts }, () =>
    fetch(`${BASE}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        idempotencyKey: key,
        idea: 'A stress test of the intake idempotency key, submitted many times at once.',
        audience: 'stress audience', goal: 'awareness', channels: ['x'],
        sourceUrls: [], publishToX: false, overrideCannibalisation: true,
      }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })),
  ));

  const rows = await query<any>(
    `select id from public.content_requests where idempotency_key=$1`, [key]);
  rows.forEach((r) => made.push(r.id));

  const distinctIds = new Set(bodies.map((b) => b.json?.data?.id).filter(Boolean));
  const errors = bodies.filter((b) => b.status >= 400);

  check(
    `${attempts} submissions of one idempotency key, at once`,
    '1 request created, and every caller told the same id',
    `${rows.length} request(s) in the database, ${distinctIds.size} distinct id(s) returned, ` +
    `${errors.length} error response(s)${errors.length ? ` [${errors.map((e) => e.status).join(', ')}]` : ''}`,
    rows.length === 1 && distinctIds.size === 1 && errors.length === 0,
  );
}

/* ================================================================== */

const { requester, editor } = await ids();
console.log(`\nStress run against ${BASE}\n`);

try {
  await concurrentTicks(requester, editor);
  await throwingConnector(requester, editor);
  await concurrentApprovals(requester, editor);
  await concurrentIntake();
} finally {
  for (const id of made) {
    await query(`delete from public.content_requests where id=$1`, [id]).catch(() => {});
  }
  await pool().end();
}

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length} of ${results.length} invariants held.`);
if (failed.length) {
  console.log('\nBroken invariants:');
  for (const f of failed) console.log(`  - ${f.scenario}: expected ${f.expected}, got ${f.actual}`);
}
process.exit(failed.length ? 1 : 0);
