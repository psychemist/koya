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
