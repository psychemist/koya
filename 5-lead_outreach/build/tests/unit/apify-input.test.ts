import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildActorCall, toCandidate, headcountBuckets, settlementUsd,
  isShowcase, parseHeadcount, withinHeadcount, withinGeography,
} from '../../lib/providers/apify.ts';

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

/**
 * The input may carry a limit, but it is never the BILLING limit.
 *
 * `input.maxItems` tells the scraper when to stop collecting.
 * `options.maxItems` tells Apify when to stop charging. They are separate
 * mechanisms, and a pay-per-event actor needs both. What must never happen is
 * the two disagreeing, because then the run stops at one number and the bill
 * is capped at another.
 */
test('a limit in the actor input never disagrees with the billing cap', () => {
  const call = buildActorCall('saas', 7);
  assert.equal(call.input.maxItems, call.options.maxItems);
  assert.equal(call.input.maxItems, 7);
  // No charge cap belongs in the input, where the platform never reads it.
  assert.equal((call.input as any).maxTotalChargeUsd, undefined);
});

test('the input uses the pinned actor field names, not ones we invented', () => {
  const call = buildActorCall('B2B SaaS', 5);
  // A wrong key is not an error, it is an empty run: the first smoke run sent
  // `query` and the actor exited with "No search parameters provided".
  assert.equal(call.input.searchQuery, 'B2B SaaS');
  assert.equal((call.input as any).query, undefined);
});

test('full mode is requested, because short mode returns no website', () => {
  // Short mode returns only a linkedinUrl, which is rejected as an aggregator,
  // so every row from it is dropped and the run costs money for nothing.
  assert.equal(buildActorCall('saas', 5).input.scraperMode, 'full');
});

test('hard filters travel as filters, not as words in the query', () => {
  const call = buildActorCall('B2B SaaS', 5, {
    locations: ['United States'], companySize: ['11-50', '51-200'],
  });
  assert.deepEqual(call.input.locations, ['United States']);
  assert.deepEqual(call.input.companySize, ['11-50', '51-200']);
  assert.equal(call.input.searchQuery, 'B2B SaaS', 'the query stays keywords only');
});

test('an empty filter is omitted rather than sent as an empty array', () => {
  const call = buildActorCall('saas', 5, { locations: [], companySize: [] });
  assert.equal('locations' in call.input, false);
  assert.equal('companySize' in call.input, false);
});

test('a headcount range maps onto every LinkedIn bucket it overlaps', () => {
  assert.deepEqual(headcountBuckets('10 to 100'), ['1-10', '11-50', '51-200']);
  assert.deepEqual(headcountBuckets('11-50'), ['11-50']);
  assert.deepEqual(headcountBuckets('500+'), ['201-500', '501-1000', '1001-5000',
    '5001-10000', '10001+']);
  // Unparseable yields no filter rather than a guess: a bucket LinkedIn does
  // not recognise returns nothing at all.
  assert.deepEqual(headcountBuckets('mid-market'), []);
  assert.deepEqual(headcountBuckets(undefined), []);
});

test('a LinkedIn profile is never accepted as a company website', () => {
  assert.equal(toCandidate({
    name: 'Sales Force Europe',
    linkedinUrl: 'https://www.linkedin.com/company/sales-force-europe/',
  }), null);
});

test('a full-mode row parses, and keeps only what a verdict can use', () => {
  const c = toCandidate({
    id: '645750', universalName: 'acme', name: 'Acme',
    website: 'http://www.acme.co.uk', employeeCount: 42,
    employeeCountRange: { start: 11, end: 50 }, industries: ['Software Development'],
    description: 'Payroll software.', logo: 'https://media.licdn.com/x.png',
    backgroundCovers: ['https://media.licdn.com/y.png'], followerCount: 4000,
    similarOrganizations: [{ name: 'Other' }],
  });
  assert.equal(c?.companyDomain, 'acme.co.uk');
  assert.equal(c?.companyName, 'Acme');
  assert.equal((c!.meta as any).employeeCount, 42);
  assert.equal((c!.meta as any).description, 'Payroll software.');
  // Logos, covers and a similar-companies list say nothing about fit and would
  // sit on every candidate row for ever.
  for (const noise of ['logo', 'backgroundCovers', 'followerCount', 'similarOrganizations']) {
    assert.equal(noise in (c!.meta as any), false, `${noise} should not be stored`);
  }
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
  const c = toCandidate({
    title: 'Acme', url: 'https://www.acme.co.uk/pricing', employeeCount: 40,
  });
  assert.equal(c?.companyDomain, 'acme.co.uk');
  assert.equal(c?.companyName, 'Acme');
  assert.equal((c?.meta as any).employeeCount, 40);
});

/**
 * What a finished run is recorded as having cost.
 *
 * `usageTotalUsd` reads LOW at the moment a run finishes. A pay-per-event
 * actor's per-event charges are aggregated after the fact, so the smoke run
 * that returned two full company records reported $0.001, which is the actor
 * start fee on its own with both `full-company` events still missing. An
 * earlier run reported $0 outright.
 *
 * Believing that figure records a run as very nearly free, which leaves the
 * run cap and the shared daily cap enforcing nothing.
 */
test('a provider figure below the priced cost is a floor to rise to, not a ceiling', () => {
  const priced = settlementUsd(undefined, 2);
  assert.ok(priced > 0.001, 'two charged items must cost more than a start fee alone');
  assert.equal(settlementUsd(0.001, 2), priced, 'an under-reported figure was believed');
  assert.equal(settlementUsd(0, 2), priced, 'a reported zero was believed');
});

test('a provider figure above the priced cost is believed, because it is the bill', () => {
  // Over-recording trips a cap early. Under-recording lets a run exceed a cap
  // it believed it was under, on an account shared across the cohort.
  assert.equal(settlementUsd(0.07, 2), 0.07);
});

test('a missing or nonsense figure settles at the priced cost, never at zero', () => {
  const priced = settlementUsd(undefined, 2);
  for (const v of [undefined, null, 'free', NaN, Infinity, -1])
    assert.equal(settlementUsd(v, 2), priced, `${String(v)} was treated as a real charge`);
});

test('a run that returned nothing still settles above zero, because starting is billed', () => {
  assert.ok(settlementUsd(0, 0) > 0);
});

/**
 * Pinned against the actor's published input schema, read from the Apify API
 * on 2026-09-24. A bucket LinkedIn does not recognise returns nothing at all
 * rather than erroring, so a drift here is a silent empty run.
 */
test('every headcount bucket is a label the pinned actor actually accepts', () => {
  const ACTOR_ENUM = new Set(['1-10', '11-50', '51-200', '201-500', '501-1000',
    '1001-5000', '5001-10000', '10001+']);
  for (const range of ['1-5', '10 to 100', '50-2000', '20000+', '201-500'])
    for (const bucket of headcountBuckets(range))
      assert.ok(ACTOR_ENUM.has(bucket), `"${bucket}" is not a bucket the actor accepts`);
});

test('a query longer than the actor accepts is trimmed, not sent to fail the run', () => {
  // searchQuery has maxLength 300 in the pinned actor's schema, and the agent
  // writes that string, so nothing else bounds it.
  const call = buildActorCall('x'.repeat(400), 5);
  assert.equal(call.input.searchQuery.length, 300);
});

/**
 * A showcase page is a sub-brand, not a company.
 *
 * The smoke run of 2026-09-24 returned
 * `linkedin.com/showcase/advids-b2b-saas-enterprise-software-video-production-service`
 * as its top result. A showcase page belongs to a parent company, carries the
 * parent's website, and has its own follower count and headcount range, so it
 * arrives looking like a separate company and either duplicates the parent or
 * spends a scrape on a marketing sub-page.
 */
test('a showcase page is not a company', () => {
  assert.equal(isShowcase({ showcase: true }), true);
  assert.equal(isShowcase({
    linkedinUrl: 'https://www.linkedin.com/showcase/advids-b2b-saas/',
  }), true);
  assert.equal(isShowcase({ pageType: 'SHOWCASE' }), true);
});

test('an ordinary company page is not mistaken for a showcase', () => {
  assert.equal(isShowcase({
    showcase: false,
    pageType: 'COMPANY',
    linkedinUrl: 'https://www.linkedin.com/company/acme/',
  }), false);
  assert.equal(isShowcase({}), false);
});

/**
 * The headcount buckets widen the ICP, so the range has to be re-checked.
 *
 * "10 to 100" spans three LinkedIn buckets, and asking for `1-10` through
 * `51-200` is asking for 1 to 200. Discovery returned companies with
 * `employeeCountRange` of `{ start: 0, end: 1 }` against exactly that ICP.
 */
test('a headcount range parses to the bounds the ICP actually stated', () => {
  assert.deepEqual(parseHeadcount('10 to 100'), { min: 10, max: 100 });
  assert.deepEqual(parseHeadcount('11-50'), { min: 11, max: 50 });
  assert.equal(parseHeadcount('500+')?.min, 500);
  assert.equal(parseHeadcount('mid-market'), null);
  assert.equal(parseHeadcount(undefined), null);
});

test('a company whose stated size cannot overlap the ICP is dropped', () => {
  const icp = parseHeadcount('10 to 100');
  assert.equal(withinHeadcount({ employeeCountRange: { start: 0, end: 1 } }, icp), false);
  assert.equal(withinHeadcount({ employeeCountRange: { start: 501, end: 1000 } }, icp), false);
});

test('a company whose stated size overlaps the ICP is kept', () => {
  const icp = parseHeadcount('10 to 100');
  assert.equal(withinHeadcount({ employeeCountRange: { start: 11, end: 50 } }, icp), true);
  // A company of exactly 10 sits in the 1-10 bucket and does fit a 10-100 ICP,
  // which is the reason the bucket is requested at all.
  assert.equal(withinHeadcount({ employeeCountRange: { start: 1, end: 10 } }, icp), true);
});

test('an unknown size is kept, because absent evidence is not evidence of a miss', () => {
  // Dropping on missing data loses real companies, and the row is already paid
  // for. Qualification judges it later against the scraped site.
  const icp = parseHeadcount('10 to 100');
  assert.equal(withinHeadcount({}, icp), true);
  assert.equal(withinHeadcount({ employeeCount: 0 }, icp), true);
  // With no ICP range there is nothing to check against.
  assert.equal(withinHeadcount({ employeeCountRange: { start: 0, end: 1 } }, null), true);
});

test('the range is preferred over the profile count, which counts members not staff', () => {
  // `employeeCount` is how many LinkedIn members list the company. The range
  // is the size the company states in its About tab, which is what LinkedIn's
  // own size filter matches on.
  const icp = parseHeadcount('10 to 100');
  assert.equal(withinHeadcount(
    { employeeCount: 0, employeeCountRange: { start: 11, end: 50 } }, icp), true);
  assert.equal(withinHeadcount({ employeeCount: 40 }, icp), true);
  assert.equal(withinHeadcount({ employeeCount: 4000 }, icp), false);
});

/**
 * Geography leaks, and the metadata already says so.
 *
 * `locations: ["United States"]` was sent and LinkedIn returned channel.io
 * (HQ Seoul) and demodesk.ai (HQ Munich), because it matches a company with AN
 * office in the US rather than one headquartered there. Both were then
 * rejected by qualification at the cost of a model call, using the very field
 * discovery already paid for.
 */
const KR = { locations: [{ country: 'KR', headquarter: true,
  parsed: { country: 'South Korea', countryCode: 'KR' } }] };
const DE_WITH_US_OFFICE = { locations: [
  { country: 'US', headquarter: false, parsed: { country: 'United States', countryCode: 'US' } },
  { country: 'DE', headquarter: true, parsed: { country: 'Germany', countryCode: 'DE' } },
] };
const US = { locations: [{ country: 'US', headquarter: true,
  parsed: { country: 'United States', countryCode: 'US' } }] };

test('a company headquartered in the target country is kept', () => {
  assert.equal(withinGeography(US, ['United States']), true);
});

test('a company headquartered elsewhere is dropped', () => {
  assert.equal(withinGeography(KR, ['United States']), false);
});

test('an office in the target country is not a headquarters there', () => {
  // This is exactly what LinkedIn's own location filter got wrong.
  assert.equal(withinGeography(DE_WITH_US_OFFICE, ['United States']), false);
});

test('the country code and the country name mean the same thing', () => {
  assert.equal(withinGeography(US, ['US']), true);
  assert.equal(withinGeography(US, ['USA']), true);
  assert.equal(withinGeography(
    { locations: [{ country: 'GB', headquarter: true,
      parsed: { country: 'United Kingdom', countryCode: 'GB' } }] },
    ['United Kingdom']), true);
});

test('any one of several wanted countries is enough', () => {
  assert.equal(withinGeography(KR, ['United States', 'South Korea']), true);
});

test('an unknown location is kept, because absent evidence is not evidence of a miss', () => {
  // Same rule as headcount: only positive evidence disqualifies, and the row
  // is already paid for either way.
  assert.equal(withinGeography({}, ['United States']), true);
  assert.equal(withinGeography({ locations: [] }, ['United States']), true);
  assert.equal(withinGeography(US, []), true, 'no stated geography is no filter');
});
