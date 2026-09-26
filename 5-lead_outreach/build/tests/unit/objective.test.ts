import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeObjective, splitObjective } from '../../lib/objective.ts';

test('compose appends only the qualifiers that were given', () => {
  assert.equal(composeObjective('automation agencies'), 'automation agencies');
  assert.equal(composeObjective('automation agencies', 'united kingdom'),
    'automation agencies. Geography: united kingdom');
  assert.equal(composeObjective('automation agencies', '', '2-15'),
    'automation agencies. Headcount: 2-15');
});

test('compose ignores whitespace-only qualifiers', () => {
  assert.equal(composeObjective('automation agencies', '   ', '  '), 'automation agencies');
});

test('split undoes compose, which is the only contract that matters', () => {
  const composed = composeObjective(
    'automation agencies that are looking for staffing',
    'united kingdom and united states', '2-15');
  const { brief, qualifiers } = splitObjective(composed);
  assert.equal(brief, 'automation agencies that are looking for staffing');
  assert.deepEqual(qualifiers, [
    { label: 'Geography', value: 'united kingdom and united states' },
    { label: 'Headcount', value: '2-15' },
  ]);
});

test('an objective with no qualifiers is returned whole', () => {
  const { brief, qualifiers } = splitObjective('Find US B2B SaaS companies');
  assert.equal(brief, 'Find US B2B SaaS companies');
  assert.deepEqual(qualifiers, []);
});

/** A brief is prose. Splitting on every full stop would cut it in half. */
test('full stops inside the brief are not treated as separators', () => {
  const composed = composeObjective(
    'Find B2B SaaS companies. They should be scaling revenue ops. Growth stage preferred',
    'United States', '10-100');
  const { brief, qualifiers } = splitObjective(composed);
  assert.equal(brief,
    'Find B2B SaaS companies. They should be scaling revenue ops. Growth stage preferred');
  assert.equal(qualifiers.length, 2);
});

test('only one qualifier still splits correctly', () => {
  const { brief, qualifiers } = splitObjective(composeObjective('edtechs expanding', '', '5-50'));
  assert.equal(brief, 'edtechs expanding');
  assert.deepEqual(qualifiers, [{ label: 'Headcount', value: '5-50' }]);
});

/**
 * The failure that matters: a brief carrying a colon must never be truncated.
 * Losing what somebody typed is far worse than printing it on one line.
 */
test('an unrecognised label leaves the text whole rather than cutting it', () => {
  const text = 'Find agencies. Budget: under ten thousand';
  const { brief, qualifiers } = splitObjective(text);
  assert.equal(brief, text);
  assert.deepEqual(qualifiers, []);
});

test('empty and blank input do not throw', () => {
  assert.deepEqual(splitObjective(''), { brief: '', qualifiers: [] });
  assert.deepEqual(splitObjective('   '), { brief: '', qualifiers: [] });
});

test('a trailing full stop is not kept on the last value', () => {
  const { qualifiers } = splitObjective('edtechs. Geography: United Kingdom.');
  assert.deepEqual(qualifiers, [{ label: 'Geography', value: 'United Kingdom' }]);
});
