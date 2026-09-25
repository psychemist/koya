import { test } from 'node:test';
import assert from 'node:assert/strict';
import { industryIds } from '../../lib/industries.ts';
import { LINKEDIN_INDUSTRIES } from '../../lib/linkedin-industries.ts';

/**
 * Why this exists.
 *
 * Three smoke runs asking for "B2B SaaS" returned a fractional CS consultancy,
 * a sales training consultancy, an SEO agency and a video production service.
 * Every one of them was tagged "Business Consulting and Services" (id 11).
 * LinkedIn reads `searchQuery` as free text, so the words "B2B SaaS" match a
 * consultancy that sells TO B2B SaaS just as well as a B2B SaaS company.
 * `industryIds` is the hard filter that separates the two.
 */

test('an exact LinkedIn label resolves to its id', () => {
  assert.deepEqual(industryIds(['Software Development']).ids, ['4']);
  assert.deepEqual(industryIds(['Business Consulting and Services']).ids, ['11']);
});

test('case, punctuation and ampersands do not decide whether a filter is applied', () => {
  for (const v of ['software development', 'SOFTWARE DEVELOPMENT', '  Software  Development '])
    assert.deepEqual(industryIds([v]).ids, ['4'], `${v} did not resolve`);
  assert.deepEqual(industryIds(['Hospitals & Health Care']).ids, ['14']);
});

test('the phrasings an ICP actually uses resolve, because LinkedIn has no "SaaS"', () => {
  // LinkedIn's taxonomy has no SaaS, no fintech and no AI. An ICP written by a
  // human or by the agent will use all three, and an unmapped name means the
  // filter is simply not applied.
  assert.deepEqual(industryIds(['B2B SaaS']).ids, ['4']);
  assert.deepEqual(industryIds(['SaaS']).ids, ['4']);
  assert.deepEqual(industryIds(['artificial intelligence']).ids, ['4']);
  assert.deepEqual(industryIds(['cybersecurity']).ids, ['118']);
});

test('an unrecognised industry is reported, never guessed at', () => {
  // A bucket LinkedIn does not recognise returns nothing at all rather than
  // erroring, so a guess here is a silent empty run.
  const { ids, unmatched } = industryIds(['underwater basket weaving']);
  assert.deepEqual(ids, []);
  assert.deepEqual(unmatched, ['underwater basket weaving']);
});

test('a partly recognised list still filters, and says what it could not place', () => {
  // Sending only the matched ids narrows the search to those industries, so
  // the caller has to be told which part of the ICP is not being enforced.
  const { ids, unmatched } = industryIds(['Software Development', 'vibes']);
  assert.deepEqual(ids, ['4']);
  assert.deepEqual(unmatched, ['vibes']);
});

test('two names for one industry do not send it twice', () => {
  assert.deepEqual(industryIds(['SaaS', 'Software Development']).ids, ['4']);
});

test('no industries at all yields no filter rather than an empty array of ids', () => {
  assert.deepEqual(industryIds(undefined), { ids: [], unmatched: [] });
  assert.deepEqual(industryIds([]), { ids: [], unmatched: [] });
});

test('the id list is capped at what the actor accepts', () => {
  // industryIds has maxItems 20 in the pinned actor's input schema.
  const everyLabel = LINKEDIN_INDUSTRIES.map(([, label]) => label);
  assert.ok(everyLabel.length > 20);
  assert.equal(industryIds(everyLabel).ids.length, 20);
});

test('every id the mapping can emit is one the taxonomy actually contains', () => {
  const known = new Set(LINKEDIN_INDUSTRIES.map(([id]) => id));
  const aliasProbe = ['SaaS', 'fintech', 'healthtech', 'martech', 'edtech', 'insurtech',
    'proptech', 'legaltech', 'hr tech', 'ecommerce', 'devtools', 'cybersecurity',
    'data analytics', 'it consulting', 'staffing', 'logistics'];
  for (const name of aliasProbe)
    for (const id of industryIds([name]).ids)
      assert.ok(known.has(id), `alias "${name}" emits id ${id}, which is not in the taxonomy`);
});
