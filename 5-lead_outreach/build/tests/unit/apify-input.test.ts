import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildActorCall, toCandidate } from '../../lib/providers/apify.ts';

/**
 * The caps are ActorStartOptions, not actor input.
 *
 * The earlier version of this test asserted that `maxItems` existed on the
 * object handed to `.start()` as its FIRST argument, which is the actor's own
 * input. That assertion passed while the cap was reaching nobody: the client
 * validates the options object against an exact shape and builds the billing
 * query string from it, so a cap sitting in the input is simply discarded.
 * These tests assert where the values land, not merely that they exist.
 */
test('the caps are in the start options, where Apify reads them', () => {
  const call = buildActorCall('saas', 7);
  assert.equal(call.options.maxItems, 7);
  assert.ok(typeof call.options.maxTotalChargeUsd === 'number'
    && call.options.maxTotalChargeUsd > 0);
});

test('the actor input carries no cap, because a cap there is enforced by nobody', () => {
  const call = buildActorCall('saas', 7);
  for (const key of Object.keys(call.input)) {
    assert.ok(!/max|limit|charge|budget/i.test(key),
      `"${key}" is in the actor input, where it is not a billing cap`);
  }
  assert.deepEqual(Object.keys(call.input), ['query']);
});

test('a zero limit is a refusal, not an uncapped run', () => {
  assert.throws(() => buildActorCall('saas', 0), /no candidate budget/i);
});

test('maxItems can never be omitted or made infinite', () => {
  for (const bad of [undefined, null, Infinity, -1, NaN] as any[])
    assert.throws(() => buildActorCall('saas', bad));
});

test('a fractional limit is floored, never rounded up', () => {
  assert.equal(buildActorCall('saas', 7.9).options.maxItems, 7);
});

test('the run is given a wall clock, so an overrun cannot spend indefinitely', () => {
  const call = buildActorCall('saas', 5);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= 600);
});

/**
 * A source-level guard. The bug was not a wrong value, it was a right value
 * passed to the wrong parameter, and no assertion on a return value catches
 * that. This one reads the call site.
 */
test('discover passes the options object to start, not the input alone', () => {
  const source = readFileSync(new URL('../../lib/providers/apify.ts', import.meta.url), 'utf8');
  assert.match(source, /\.start\(\s*call\.input\s*,\s*call\.options\s*\)/,
    'start() must receive the built options as its second argument');
});

test('a discovered row without a usable domain is dropped, not stored empty', () => {
  assert.equal(toCandidate({ name: 'Aggregator', url: 'https://linkedin.com/company/x' }), null);
  assert.equal(toCandidate({ name: 'No domain' }), null);
});

test('a discovered row is normalised to its registrable domain', () => {
  const c = toCandidate({ title: 'Acme', url: 'https://www.acme.co.uk/pricing', employees: 40 });
  assert.equal(c?.companyDomain, 'acme.co.uk');
  assert.equal(c?.companyName, 'Acme');
  assert.equal((c?.meta as any).employees, 40);
});
