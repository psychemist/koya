import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRevertTargets } from '../../lib/pipeline/revise.js';

/**
 * The monotonicity guard used to revert EVERY asset a pass had touched,
 * because Tier 1 scores only the article. A real run cut the X post from 338
 * characters to 276, the article's prose score dipped from 4.40 to 4.17, the
 * guard fired, and the 338-character version went back. Passing X's hard
 * limit was undone by a judgment about the article's prose.
 */
const blocking = (assetKind: string) => ({ assetKind, severity: 'blocking' });

test('a dip in the article score does not undo a channel fix made in the same pass', () => {
  // The X post went from one blocking length finding to none. The article
  // still has its own problem, and its judge score fell.
  const before = [blocking('x'), blocking('article')];
  const after = [blocking('article')];

  const targets = selectRevertTargets([{ kind: 'article' }, { kind: 'x' }], before, after);
  assert.deepEqual(targets.map((t) => t.kind), ['article']);
});

test('a channel asset that genuinely got worse does go back', () => {
  const targets = selectRevertTargets([{ kind: 'x' }], [], [blocking('x')]);
  assert.deepEqual(targets.map((t) => t.kind), ['x']);
});

test('a channel asset that stayed the same is left alone', () => {
  // No improvement, but no regression either, so there is nothing to undo.
  const targets = selectRevertTargets([{ kind: 'linkedin' }], [blocking('linkedin')], [blocking('linkedin')]);
  assert.deepEqual(targets, []);
});

test('the article always goes back, because the judge only ever scored the article', () => {
  // Even with its deterministic findings unchanged, the prose score is the
  // evidence, and the guard only runs when that score fell.
  const targets = selectRevertTargets([{ kind: 'article' }], [], []);
  assert.deepEqual(targets.map((t) => t.kind), ['article']);
});

test('advisory findings do not count as getting worse', () => {
  // Only blocking findings decide this. Advisories are worth knowing and stop
  // nothing, so a pass that adds one has not regressed.
  const targets = selectRevertTargets(
    [{ kind: 'x' }], [], [{ assetKind: 'x', severity: 'advisory' }]);
  assert.deepEqual(targets, []);
});
