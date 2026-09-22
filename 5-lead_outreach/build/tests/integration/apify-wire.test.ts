import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../../lib/providers/apify.ts';
import { clampCandidates, apifySpend } from '../../lib/budget.ts';
import { query } from '../../lib/db.ts';
import { apifySpy } from '../stubs.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/** The pinned-actor assertion runs before anything else, so the id must be set
 *  even though no real call is made. */
const withActor = (fn: () => Promise<void>) => async () => {
  const had = process.env.APIFY_ACTOR_ID;
  process.env.APIFY_ACTOR_ID ||= 'stub~actor';
  try { await fn(); } finally {
    if (had === undefined) delete process.env.APIFY_ACTOR_ID;
  }
};

/**
 * The test that would have caught the caps reaching nobody.
 *
 * It asserts WHERE the values land, not that they exist. `maxItems` and
 * `maxTotalChargeUsd` are ActorStartOptions, so they belong in the second
 * argument; anything in the first is actor input, which the platform hands to
 * the actor and never reads as a billing cap.
 */
test('the caps are passed as start options, never as actor input',
  { skip: skipWithoutDatabase }, withActor(async () => {
    const run = await seedRun({ candidate_budget: 5, candidates_used: 3 });
    const spy = apifySpy();

    await discover(run.id, 'saas', clampCandidates(run), { client: spy });

    const { input, options } = spy.lastStart();
    // 5 budget minus 3 used is 2.
    assert.equal(options.maxItems, 2);
    assert.ok(options.maxTotalChargeUsd > 0, 'no charge cap was sent');
    assert.equal(input.maxItems, undefined,
      'maxItems is in the actor input, where Apify discards it');
    assert.equal(input.maxTotalChargeUsd, undefined,
      'maxTotalChargeUsd is in the actor input, where Apify discards it');
    assert.equal(input.query, 'saas');
    assert.ok(options.timeout > 0, 'no wall clock was set on the run');

    await dropRun(run.id);
  }));

test('the limit comes from the run row, so a caller cannot ask for more',
  { skip: skipWithoutDatabase }, withActor(async () => {
    const run = await seedRun({ candidate_budget: 4, candidates_used: 1 });
    const spy = apifySpy();

    // Even handed an absurd number, the clamp is what reaches the provider.
    await discover(run.id, 'saas', clampCandidates(run, 999), { client: spy });
    assert.equal(spy.lastStart().options.maxItems, 3);

    await dropRun(run.id);
  }));

test('a rate limited start is retried, and the retries are bounded',
  { skip: skipWithoutDatabase }, withActor(async () => {
    const run = await seedRun({ candidate_budget: 10, candidates_used: 0 });

    // Fails twice with a 429, then succeeds.
    const recovers = apifySpy({ failStartWith: { statusCode: 429, times: 2 } });
    const found = await discover(run.id, 'saas', 5, { client: recovers });
    assert.equal(recovers.startCalls.length, 3, 'the retry did not happen');
    assert.equal(found.candidates.length, 1);

    // Fails every time: bounded, and surfaced as a non-retryable error so the
    // agent does not add a retry loop of its own on top.
    const run2 = await seedRun({ candidate_budget: 10, candidates_used: 0 });
    const alwaysFails = apifySpy({ failStartWith: { statusCode: 429 } });
    await assert.rejects(
      () => discover(run2.id, 'saas', 5, { client: alwaysFails }),
      (e: any) => e.code === 'APIFY_429' && e.retryable === false);
    assert.equal(alwaysFails.startCalls.length, 3, 'retries are not bounded at 3');

    await dropRun(run.id);
    await dropRun(run2.id);
  }));

test('a failed start settles its reservation, so the ledger holds no phantom spend',
  { skip: skipWithoutDatabase }, withActor(async () => {
    const run = await seedRun({ candidate_budget: 10, candidates_used: 0 });
    const spy = apifySpy({ failStartWith: { statusCode: 500 } });

    await assert.rejects(() => discover(run.id, 'saas', 5, { client: spy }));

    // Nothing ran, so nothing is owed.
    assert.equal(await apifySpend(run.id), 0);
    await dropRun(run.id);
  }));

test('a completed run settles to what the provider reported, not to the estimate',
  { skip: skipWithoutDatabase }, withActor(async () => {
    const run = await seedRun({ candidate_budget: 10, candidates_used: 0 });
    const spy = apifySpy({ usageUsd: 0.07 });

    await discover(run.id, 'saas', 5, { client: spy });

    assert.equal(await apifySpend(run.id), 0.07);
    // The denormalised column on the run is refreshed from the ledger, which
    // is what the digest and the run list read.
    const [after] = await query<{ apify_spend_usd: string }>(
      'select apify_spend_usd from public.runs where id = $1', [run.id]);
    assert.equal(Number(after.apify_spend_usd), 0.07);

    await dropRun(run.id);
  }));

test('an overrunning actor is aborted rather than waited out',
  { skip: skipWithoutDatabase }, withActor(async () => {
    const run = await seedRun({ candidate_budget: 10, candidates_used: 0 });
    const spy = apifySpy({ status: 'RUNNING' });

    // A zero wall clock makes the first poll an overrun.
    await assert.rejects(
      () => discover(run.id, 'saas', 5, { client: spy, wallClockMs: 0 }),
      (e: any) => e.code === 'APIFY_ABORTED');
    assert.deepEqual(spy.aborted, ['spy-run-1'], 'the run was not aborted');

    // An aborted run still settles: an unknown spend must not read as no spend.
    assert.ok(await apifySpend(run.id) > 0);
    await dropRun(run.id);
  }));
