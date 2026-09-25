import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDomain } from '../../lib/domain.ts';

test('collapses forms of the same company to one key', () => {
  for (const v of [
    'https://WWW.Acme.co.uk/pricing?utm_source=x',
    'http://acme.co.uk',
    'acme.co.uk',
    'www.acme.co.uk/',
  ]) assert.equal(normaliseDomain(v), 'acme.co.uk');
});

test('keeps a multi-part public suffix intact', () => {
  assert.equal(normaliseDomain('https://foo.bar.com.au'), 'bar.com.au');
});

test('rejects aggregators and junk', () => {
  for (const v of ['https://linkedin.com/company/acme', 'https://crunchbase.com/x', 'not a url'])
    assert.equal(normaliseDomain(v), null);
});

test('rejects empty and non-domain input rather than returning a partial key', () => {
  for (const v of ['', '   ', 'localhost', 'https://', '192.168.0.1'])
    assert.equal(normaliseDomain(v), null);
});

/**
 * A booking link is not a company.
 *
 * LinkedIn's `website` field is whatever the company typed into it, and a
 * small company very often types its Calendly. The first smoke run returned
 * "NorthHarbor Growth Solutions" with `website` set to
 * `https://calendly.com/northharborgrowth/30min`, which parsed to the
 * candidate domain `calendly.com`.
 */
test('a booking, form or link-in-bio host is never a company website', () => {
  for (const v of [
    'https://calendly.com/northharborgrowth/30min',
    'https://cal.com/acme',
    'https://linktr.ee/acme',
    'https://bio.link/acme',
    'https://acme.typeform.com/to/abc',
    'https://docs.google.com/forms/d/e/xyz/viewform',
    'https://forms.gle/abc123',
    'https://lu.ma/acme-launch',
    'https://acme.eventbrite.com',
    'https://share.hsforms.com/abc',
  ]) assert.equal(normaliseDomain(v), null, `${v} was accepted as a company domain`);
});

/**
 * This is the expensive half of the bug.
 *
 * `normaliseDomain` is the deduplication key for the whole system, so a shared
 * host does not merely waste one scrape: it silently collapses two different
 * companies into one row, and the second company is dropped without anyone
 * being told it was ever found.
 */
test('two companies behind one booking host do not deduplicate into a single lead', () => {
  const a = normaliseDomain('https://calendly.com/company-a/30min');
  const b = normaliseDomain('https://calendly.com/company-b/30min');
  assert.equal(a, null);
  assert.equal(b, null);
});

test('a site-builder or hosting subdomain is not a registrable company identity', () => {
  for (const v of [
    'https://acme.vercel.app',
    'https://acme.netlify.app',
    'https://acme.pages.dev',
    'https://acme.webflow.io',
    'https://acme.myshopify.com',
    'https://acme.wixsite.com/home',
  ]) assert.equal(normaliseDomain(v), null, `${v} was accepted as a company domain`);
});

/**
 * The rejections above are registrable-domain wide, so they also reject the
 * handful of real companies that own those domains. That is the right trade:
 * none of them is a plausible lead for this ICP, whereas every one of them is
 * a highly plausible booking or form link pasted into a LinkedIn profile.
 * What must keep working is the company that merely uses such a tool.
 */
test('a real company website still parses, tool or no tool', () => {
  assert.equal(normaliseDomain('https://www.webflow.com'), 'webflow.com');
  assert.equal(normaliseDomain('https://sellsaasb2b.com'), 'sellsaasb2b.com');
  assert.equal(normaliseDomain('rocktherankings.com'), 'rocktherankings.com');
});

/**
 * Found live, by the smoke run of 2026-09-24.
 *
 * "SaaS Growth Strategies" came back with a `website` pointing at its beehiiv
 * newsletter, which resolved to `beehiiv.com`. Same class as the Calendly
 * case: a publishing host shared by every one of its customers, so it is both
 * a useless scrape and a deduplication key that merges unrelated companies.
 */
test('a newsletter or publishing host is not a company website', () => {
  for (const v of [
    'https://beehiiv.com/saas-growth',
    'https://saasgrowth.beehiiv.com',
    'https://acme.ghost.io',
    'https://buttondown.com/acme',
  ]) assert.equal(normaliseDomain(v), null, `${v} was accepted as a company domain`);
});
