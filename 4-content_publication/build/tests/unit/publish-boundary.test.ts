import test from 'node:test';
import assert from 'node:assert/strict';
import { stripCitations, hasCitationMarkers, citationMarkers } from '../../lib/publish/citations.js';
import { stripUrls, hasUrl, xPostCost } from '../../lib/publish/links.js';
import { checkCitationPlaceholders } from '../../lib/gates/tier0/citations.js';
import { decisionRefusal } from '../../lib/auth.js';
import { markBody, esc } from '../../app/ui/mark-body.js';

/* ------------------------------------------------- citation markers */

test('citation markers are recognised in the format research.ts actually writes', () => {
  // `S` + the first four chars of a source uuid + `P` + an ordinal.
  const body = 'Revenue grew 14% [S1d20P1] last year, and churn fell [S3417P4].';
  assert.equal(hasCitationMarkers(body), true);
  assert.deepEqual(citationMarkers(body), ['[S1d20P1]', '[S3417P4]']);
});

test('stripping a marker does not leave a space before the punctuation', () => {
  assert.equal(
    stripCitations('Revenue grew 14% [S1d20P1]. The next year was flat.'),
    'Revenue grew 14%. The next year was flat.',
  );
});

test('stripping a marker mid-sentence does not leave a double space', () => {
  assert.equal(
    stripCitations('Revenue grew 14% [S1d20P1] and churn fell.'),
    'Revenue grew 14% and churn fell.',
  );
});

test('several markers together come off as one', () => {
  assert.equal(
    stripCitations('Two sources agree [S1d20P1][S3417P4] on this.'),
    'Two sources agree on this.',
  );
  assert.equal(
    stripCitations('Two sources agree [S1d20P1, S3417P4] on this.'),
    'Two sources agree on this.',
  );
});

test('ORDINARY PROSE THAT LOOKS LIKE A MARKER IS LEFT ALONE', () => {
  // A greedy \[.*\] would have eaten all of these, quietly damaging the copy
  // it was meant to be cleaning. This is the case that makes the pattern
  // bounded rather than convenient.
  const safe = [
    'The [Q3 P1] milestone slipped.',
    'See [Some Product P1] for details.',
    'Use the [sic] marker sparingly.',
    'The range was [S1 to P4] on the chart.',
  ];
  for (const s of safe) assert.equal(stripCitations(s), s, s);
});

test('a NEEDS SOURCE placeholder is NOT stripped, because it has to block', () => {
  const body = 'Churn fell by [NEEDS SOURCE: the 2026 churn figure] over the year.';
  assert.equal(stripCitations(body), body);
});

test('the NEEDS SOURCE gate blocks, and names what is missing', () => {
  const flags = checkCitationPlaceholders(
    'Churn fell by [NEEDS SOURCE: the 2026 churn figure] over the year.', 'article');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'blocking');
  assert.match(flags[0].message, /the 2026 churn figure/);
});

test('the same missing fact twice is one finding, not two', () => {
  const flags = checkCitationPlaceholders(
    '[NEEDS SOURCE: a churn figure] and later [NEEDS SOURCE: a churn figure].', 'article');
  assert.equal(flags.length, 1);
});

test('a clean draft produces no placeholder findings', () => {
  assert.deepEqual(checkCitationPlaceholders('Nothing missing here.', 'article'), []);
});

/* ------------------------------------------------------------ X links */

test('X pricing follows the link, which is the whole point of the choice', () => {
  assert.equal(xPostCost('Read it: https://koya.example/x'), 0.2);
  assert.equal(xPostCost('No link in this one.'), 0.015);
});

test('stripping the URL also removes the lead-in that pointed at it', () => {
  // "Full breakdown here:" with the URL gone reads as a truncated post, which
  // is worse than either version.
  assert.equal(
    stripUrls('Hiring signals that predict performance.\n\nFull breakdown here: https://koya.example/blog/x'),
    'Hiring signals that predict performance.\n\nFull breakdown here',
  );
  assert.equal(hasUrl(stripUrls('See https://koya.example/a and https://koya.example/b')), false);
});

test('a parenthesised link does not leave empty brackets behind', () => {
  assert.equal(stripUrls('The study (https://koya.example/s) says so.'), 'The study says so.');
});

/* -------------------------------------------------- who may decide */

const EDITOR = { actorId: 'u-editor', actorRole: 'editor' };
const AUTHOR = 'u-author';

test('an editor who is not the author may take all three decisions', () => {
  for (const decision of ['approved', 'changes_requested', 'rejected'] as const) {
    assert.equal(decisionRefusal({ ...EDITOR, requesterId: AUTHOR, decision }), null, decision);
  }
});

test('A MANAGER CANNOT REJECT OR SEND BACK, not just cannot approve', () => {
  // The defect: the role check was gated on `decision === 'approved'`, so any
  // signed-in manager could reject somebody else's draft. Both of the other
  // two write an approvals row, notify the author and stop the work.
  for (const decision of ['approved', 'changes_requested', 'rejected'] as const) {
    const refusal = decisionRefusal({
      actorId: 'u-manager', actorRole: 'manager', requesterId: AUTHOR, decision });
    assert.ok(refusal, `manager should be refused for ${decision}`);
    assert.match(refusal!, /Only an editor/);
  }
});

test('an editor cannot decide on their own request, in any direction', () => {
  for (const decision of ['approved', 'changes_requested', 'rejected'] as const) {
    const refusal = decisionRefusal({
      actorId: AUTHOR, actorRole: 'editor', requesterId: AUTHOR, decision });
    assert.ok(refusal, decision);
    assert.match(refusal!, /cannot approve it/);
  }
});

test('the solo-operator override lifts both, and only when it is set', () => {
  assert.equal(decisionRefusal({
    actorId: AUTHOR, actorRole: 'manager', requesterId: AUTHOR,
    decision: 'approved', soloOverride: true }), null);
  assert.ok(decisionRefusal({
    actorId: AUTHOR, actorRole: 'manager', requesterId: AUTHOR,
    decision: 'approved', soloOverride: false }));
});

/* ---------------------------------------------------------- marking */

test('a citation marker is wrapped so it cannot be read as prose', () => {
  const html = markBody(esc('Revenue grew 14% [S1d20P1] last year.'), []);
  assert.match(html, /<span class="cite"/);
  assert.match(html, /\[S1d20P1\]/);
});

test('an unsupported claim is struck, and a marker inside it is not nested', () => {
  // A <mark> inside a <mark> is invalid and renders as a double strike. The
  // range merge is what makes nesting impossible by construction.
  const html = markBody(esc('Revenue grew 14% [S1d20P1] last year.'), ['14% [S1d20P1]']);
  assert.match(html, /<mark class="unsupported"/);
  assert.equal(html.match(/<mark/g)?.length, 1);
  assert.equal(html.includes('<span class="cite"'), false);
});

test('two overlapping unsupported claims produce one mark, not a nested pair', () => {
  const html = markBody(esc('Revenue grew 14% last year.'), ['grew 14%', '14% last year']);
  assert.equal(html.match(/<mark/g)?.length, 1);
});

test('a NEEDS SOURCE placeholder is marked as a gap, not as a citation', () => {
  const html = markBody(esc('Churn fell [NEEDS SOURCE: the figure] last year.'), []);
  assert.match(html, /<span class="gap"/);
  assert.equal(html.includes('<span class="cite"'), false);
});

test('angle brackets in a draft are escaped before any marking happens', () => {
  const html = markBody(esc('A <script>alert(1)</script> in the draft.'), []);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});
