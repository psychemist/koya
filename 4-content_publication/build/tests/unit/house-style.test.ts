import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHouseStyle } from '../../lib/gates/tier0/house-style.js';

/**
 * The prompts ask for this. The gate is what makes it true.
 */
test('house style: an em dash blocks, and the action names the span', () => {
  const body = 'Forward deployed engineers sit with the customer — that is the whole job.';
  const flags = checkHouseStyle(body, 'linkedin');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'blocking');
  assert.equal(flags[0].code, 'house_style_em_dash');
  // A revision instruction that does not say WHERE is a coin flip.
  assert.ok(flags[0].action.includes('with the customer'));
});

test('house style: a double hyphen standing in for one is caught too', () => {
  // What a model reaches for when told not to use the character.
  assert.equal(checkHouseStyle('The pay bands disagree -- by six figures.', 'x').length, 1);
});

test('house style: clean copy passes, and hyphenated words are not em dashes', () => {
  const body = 'A well-written, end-to-end guide for mid-market talent teams. '
    + 'The range is 162,000-400,000 depending on the employer.';
  assert.deepEqual(checkHouseStyle(body, 'article'), []);
});

test('house style: several occurrences are reported together, not one flag each', () => {
  const body = 'One — two — three — four — five — six.';
  const flags = checkHouseStyle(body, 'newsletter');
  assert.equal(flags.length, 1);
  assert.ok(flags[0].message.includes('4 times'));   // capped, still actionable
});
