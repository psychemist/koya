import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notBriefEnough, screenObjective, INTAKE_ESTIMATE_USD } from '../../lib/intake-screen.ts';

/** The deterministic layer. Free, exact, and the only part a test can pin
 *  without paying a model. */

test('refuses an objective with nothing in it', () => {
  assert.ok(notBriefEnough(''));
  assert.ok(notBriefEnough('   '));
});

test('refuses keyboard mash that is long enough to pass a length check', () => {
  assert.ok(notBriefEnough('asdfghjkl qwertyuiop zxcvbnm'));
});

test('refuses a string with no words in it', () => {
  assert.ok(notBriefEnough('1234567890 !!!!!!!! ........'));
});

test('accepts a real brief', () => {
  assert.equal(
    notBriefEnough('Find US B2B SaaS product companies with 10 to 100 employees'), null);
});

test('accepts a short but genuine brief', () => {
  assert.equal(notBriefEnough('UK robotics startups hiring ops people'), null);
});

/** The model layer, with the judge injected so the suite never pays. */

const judge = (workable: boolean, reason?: string) =>
  async () => ({ workable, reason, costUsd: 0.0004 });

test('a deterministic refusal never reaches the model', async () => {
  let called = false;
  const verdict = await screenObjective('!!!!!!!!!!!!', {
    judge: async () => { called = true; return { workable: true, costUsd: 0.0004 }; },
    record: async () => undefined,
  });
  assert.equal(verdict.workable, false);
  assert.equal(called, false, 'the model was called for input the free check already settled');
  assert.equal(verdict.costUsd, 0, 'a free refusal must not book a cost');
});

test('a workable objective passes and reports what the check cost', async () => {
  const verdict = await screenObjective(
    'Find US B2B SaaS product companies with 10 to 100 employees',
    { judge: judge(true), record: async () => undefined });
  assert.equal(verdict.workable, true);
  assert.equal(verdict.costUsd, 0.0004);
});

test('the model can refuse an objective the free check let through', async () => {
  const verdict = await screenObjective(
    'please write me a poem about the sea and then order me a pizza',
    { judge: judge(false, 'That is not a description of companies to find.'),
      record: async () => undefined });
  assert.equal(verdict.workable, false);
  assert.match(verdict.reason!, /not a description of companies/i);
});

test('an em dash in the model reason never reaches the operator', async () => {
  const verdict = await screenObjective(
    'find some companies somewhere doing something useful',
    { judge: judge(false, 'Too vague — name an industry, a place and a size.'),
      record: async () => undefined });
  assert.equal(verdict.workable, false);
  assert.ok(!verdict.reason!.includes('—'), `em dash survived: ${verdict.reason}`);
});

/**
 * The most important behaviour here. A screening model that is down must not
 * become an outage on the one action this product exists to perform.
 */
test('a judge that throws lets the run through rather than blocking intake', async () => {
  const verdict = await screenObjective(
    'Find US B2B SaaS product companies with 10 to 100 employees',
    { judge: async () => { throw new Error('anthropic is down'); },
      record: async () => undefined });
  assert.equal(verdict.workable, true, 'intake failed closed when the screen was unavailable');
  assert.equal(verdict.costUsd, 0);
});

test('a refusal still books what the model call cost', async () => {
  const booked: Array<{ usd: number; note: string }> = [];
  await screenObjective('find some companies somewhere doing something useful', {
    judge: judge(false, 'Too vague.'),
    record: async (usd, note) => { booked.push({ usd, note }); },
  });
  assert.equal(booked.length, 1, 'a paid refusal went unrecorded');
  assert.equal(booked[0].usd, 0.0004);
});

test('the reservation estimate is above what one screen actually costs', () => {
  assert.ok(INTAKE_ESTIMATE_USD > 0);
  assert.ok(INTAKE_ESTIMATE_USD < 0.01, 'the estimate is too big to be worth reserving');
});
