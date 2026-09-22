import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActorInput, toCandidate } from '../../lib/providers/apify.ts';

test('every input carries a hard stop', () => {
  const i: any = buildActorInput('saas', 7);
  assert.equal(i.maxItems, 7);
  assert.ok(typeof i.maxTotalChargeUsd === 'number' && i.maxTotalChargeUsd > 0);
});

test('a zero limit is a refusal, not an uncapped run', () => {
  assert.throws(() => buildActorInput('saas', 0), /no candidate budget/i);
});

test('maxItems can never be omitted or made infinite', () => {
  for (const bad of [undefined, null, Infinity, -1, NaN] as any[])
    assert.throws(() => buildActorInput('saas', bad));
});

test('a fractional limit is floored, never rounded up', () => {
  assert.equal((buildActorInput('saas', 7.9) as any).maxItems, 7);
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
