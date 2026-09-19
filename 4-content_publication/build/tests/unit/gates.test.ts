import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fleschKincaidGrade, checkReadability, checkSeo, checkX, checkLinkedIn,
  checkNewsletter, checkGrounding, checkLinksInSourceSet, checkVerbatim,
  checkComplete, longestCommonRun, extractUrls,
} from '../../lib/gates/tier0/index.js';

/**
 * The gates are tested against hand-written fixtures with PLANTED defects,
 * before any model output is ever judged by them. A gate nobody verified is
 * not a control, it is a decoration — and these are the checks that stand
 * between the system and a published invented statistic.
 */

const EXCERPTS = [
  { label: 'S1P1', text: 'Time per long-form post is now close to four hours according to the 2026 survey.' },
  { label: 'S1P2', text: 'Teams report spending 40% of their time in review cycles.' },
];

// ---------------------------------------------------------------- readability
test('Flesch-Kincaid: plain prose scores low, dense prose scores high', () => {
  const plain = 'The cat sat on the mat. It was warm. The sun was out. We were glad.';
  const dense = 'Notwithstanding the aforementioned considerations, the implementation of ' +
    'multifaceted organisational transformation initiatives necessitates comprehensive ' +
    'stakeholder alignment across heterogeneous functional departments.';
  assert.ok(fleschKincaidGrade(plain) < 5, `plain scored ${fleschKincaidGrade(plain)}`);
  assert.ok(fleschKincaidGrade(dense) > 12, `dense scored ${fleschKincaidGrade(dense)}`);
});

test('readability gate: blocks above grade 7, tolerates a point of slack', () => {
  const dense = 'Notwithstanding the aforementioned considerations, the implementation of ' +
    'multifaceted organisational transformation initiatives necessitates comprehensive ' +
    'stakeholder alignment across heterogeneous functional departments and subsidiaries.';
  const flags = checkReadability(dense, 'article');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].code, 'readability_too_complex');
  assert.equal(flags[0].severity, 'blocking');
  // The action must be usable as a revision instruction, not a complaint.
  assert.match(flags[0].action, /grade 7/);

  assert.equal(checkReadability('The cat sat on the mat. It was warm.', 'article').length, 0);
});

// ------------------------------------------------------------------ SEO gates
const article = (words: number, heading = 'What the data says') => ({
  title: 'Content operations in 2026',
  sections: [{ heading, body: Array(words).fill('word').join(' ') + '.' }],
});

test('SEO: section depth is checked against the DERIVED band, not a hard-coded one', () => {
  // Under the band
  const short = checkSeo(article(300), 'content operations', [700, 800]);
  assert.ok(short.some((f) => f.code === 'seo_section_too_short' && f.severity === 'advisory'));

  // Inside a band measured from competitors — the same 300-word section passes
  const measured = checkSeo(article(300), 'content operations', [250, 400]);
  assert.ok(!measured.some((f) => f.code === 'seo_section_too_short'));
});

test('SEO: keyword must be in the title and the first 100 words', () => {
  const flags = checkSeo(article(750), 'talent pipeline', [700, 800]);
  assert.ok(flags.some((f) => f.code === 'seo_keyword_not_in_title'));
  assert.ok(flags.some((f) => f.code === 'seo_keyword_not_in_intro'));
});

test('SEO: over-optimisation fails too, not just under-use', () => {
  const stuffed = {
    title: 'Content operations guide',
    sections: [{ heading: 'Content operations',
      body: Array(200).fill('content operations').join(' ') + '.' }],
  };
  const flags = checkSeo(stuffed, 'content operations', [100, 500]);
  assert.ok(flags.some((f) => f.code === 'seo_keyword_stuffing' && f.severity === 'blocking'));
});

// -------------------------------------------------------------- channel gates
test('X: the 312-character post that a JSON schema would happily return', () => {
  // This is exactly why Tier 0 exists. output_config.format supports no
  // maxLength, so the schema cannot express this rule at all.
  const tooLong = 'a'.repeat(312);
  const flags = checkX(tooLong);
  assert.ok(flags.some((f) => f.code === 'x_too_long' && f.severity === 'blocking'));
  assert.match(flags[0].action, /280/);
});

test('X: emoji count as one character, not four', () => {
  const post = '🔄'.repeat(280);
  assert.equal(checkX(post).filter((f) => f.code === 'x_too_long').length, 0);
});

test('X: at most two hashtags', () => {
  const flags = checkX('A good idea.\n\n#one #two #three');
  assert.ok(flags.some((f) => f.code === 'x_too_many_hashtags'));
});

test('LinkedIn: emoji ceiling and a required CTA', () => {
  const noCta = 'Problem.\n\nAgitation.\n\nSolution. 🎯🎯🎯🎯🎯🎯';
  const flags = checkLinkedIn(noCta);
  assert.ok(flags.some((f) => f.code === 'linkedin_too_many_emoji'));
  assert.ok(flags.some((f) => f.code === 'linkedin_no_cta'));

  const good = 'Problem.\n\nAgitation.\n\nSolution.\n\nWhat would you add? ☀️';
  assert.equal(checkLinkedIn(good).filter((f) => f.severity === 'blocking').length, 0);
});

/**
 * The cap used to be 1000 and it was wrong in a way that cost content.
 *
 * Eleven of the twelve posts the generator ever produced came out between
 * 1008 and 1771 characters, so the blocking flag fired on almost every
 * request and the revision loop spent a pass cutting prose LinkedIn would
 * have accepted untouched. A blocking gate has to mean the provider refuses
 * this; LinkedIn refuses over 3000 and nothing below it.
 */
test('LinkedIn: length blocks only where LinkedIn actually refuses', () => {
  const tail = '\n\nWhat would you add?';
  const post = (n: number) => 'x'.repeat(n - tail.length) + tail;

  // The length that used to be blocked, and is the generator's normal output.
  const typical = checkLinkedIn(post(1500));
  assert.equal(typical.filter((f) => f.code === 'linkedin_too_long').length, 0,
    '1500 characters is well inside LinkedIn\'s limit and must not block');
  assert.equal(typical.filter((f) => f.code === 'linkedin_long').length, 0,
    '1500 characters is not even long enough to be worth mentioning');

  // Long enough to be worth saying, not long enough to refuse.
  const long = checkLinkedIn(post(2500));
  assert.ok(long.some((f) => f.code === 'linkedin_long' && f.severity === 'advisory'),
    'past the readable length it should advise');
  assert.equal(long.filter((f) => f.severity === 'blocking').length, 0,
    'advice must never block: the post publishes exactly as written');

  // Past LinkedIn's hard limit, where the API returns FIELD_LENGTH_TOO_LONG.
  const over = checkLinkedIn(post(3400));
  assert.ok(over.some((f) => f.code === 'linkedin_too_long' && f.severity === 'blocking'),
    'over 3000 the provider refuses it, so this must block');
  assert.equal(over.filter((f) => f.code === 'linkedin_long').length, 0,
    'one length complaint, not two');
});

test('newsletter: 250-600 words, plus a subject line', () => {
  const short = checkNewsletter(Array(100).fill('word').join(' '), 'A subject');
  assert.ok(short.some((f) => f.code === 'newsletter_length'));
  const noSubject = checkNewsletter(Array(300).fill('word').join(' ') + ' Reply and tell me.', null);
  assert.ok(noSubject.some((f) => f.code === 'newsletter_no_subject'));
});

// ------------------------------------------------------------------- grounding
test('grounding: a planted statistic absent from every excerpt blocks approval', () => {
  const draft = 'Teams waste 73% of their week on review cycles.';
  const { flags, claims } = checkGrounding(draft, EXCERPTS, 'article');
  assert.ok(flags.some((f) => f.code === 'grounding_unsupported_percent' && f.severity === 'blocking'));
  assert.ok(claims.some((c) => c.text === '73%' && c.status === 'unsupported'));
  // Blank beats invented: the instruction says so explicitly.
  assert.match(flags[0].action, /marked gap is the correct answer/);
});

test('grounding: a figure that IS in an excerpt passes and records its label', () => {
  const draft = 'Teams report spending 40% of their time in review cycles.';
  const { flags, claims } = checkGrounding(draft, EXCERPTS, 'article');
  assert.equal(flags.filter((f) => f.severity === 'blocking').length, 0);
  assert.equal(claims.find((c) => c.text === '40%')?.label, 'S1P2');
});

test('grounding: small integers are not treated as claims', () => {
  const { flags } = checkGrounding('There are 3 things to know.', EXCERPTS, 'article');
  assert.equal(flags.length, 0);
});

// ----------------------------------------------------------------------- links
test('links: an invented URL is caught even though the page might exist', () => {
  const draft = 'See [the research](https://not-a-source.example/report).';
  const flags = checkLinksInSourceSet(draft, ['https://real-source.example/a'], 'article');
  assert.ok(flags.some((f) => f.code === 'link_not_in_source_set' && f.severity === 'blocking'));
});

test('links: same host as a supplied source is accepted', () => {
  const draft = 'See [the research](https://real-source.example/b).';
  const flags = checkLinksInSourceSet(draft, ['https://real-source.example/a'], 'article');
  assert.equal(flags.filter((f) => f.code === 'link_not_in_source_set').length, 0);
});

test('links: "click here" anchors are flagged', () => {
  const draft = 'See [click here](https://real-source.example/a).';
  const flags = checkLinksInSourceSet(draft, ['https://real-source.example/a'], 'article');
  assert.ok(flags.some((f) => f.code === 'link_weak_anchor'));
});

test('links: both markdown and bare URLs are extracted', () => {
  const urls = extractUrls('A [link](https://a.example/x) and https://b.example/y here.');
  assert.deepEqual(urls.map((u) => u.url).sort(), ['https://a.example/x', 'https://b.example/y']);
});

// -------------------------------------------------------------------- verbatim
test('verbatim: the check nobody builds — grounded must not become copied', () => {
  const source = { label: 'S1P1', text: Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') };
  const lifted = source.text; // reproduced wholesale
  const flags = checkVerbatim(lifted, [source], 'article');
  assert.ok(flags.some((f) => f.code === 'verbatim_lift' && f.severity === 'blocking'));
});

test('verbatim: a short paraphrase overlap is fine', () => {
  const source = { label: 'S1P1', text: 'Teams report spending forty percent of their time in review.' };
  assert.equal(checkVerbatim('Review cycles eat a large share of the week.', [source], 'article').length, 0);
});

test('longestCommonRun finds the actual shared span', () => {
  const r = longestCommonRun('the quick brown fox jumps over', 'a quick brown fox sat');
  assert.equal(r.words, 3);
  assert.equal(r.text, 'quick brown fox');
});

// ------------------------------------------------------------------ completeness
test('completeness: a missing channel asset blocks', () => {
  const flags = checkComplete(['article', 'linkedin', 'x'], [
    { kind: 'article', body: 'text' },
    { kind: 'linkedin', body: 'text' },
  ]);
  assert.ok(flags.some((f) => f.code === 'incomplete_missing_asset' && f.assetKind === 'x'));
});

/**
 * REGRESSION, from the first real article.
 *
 * House style sets headings in Title Case, so every heading is a run of
 * capitalised words. The proper-noun check read each one as an unverifiable
 * claim: the draft produced eight unsupported claims, seven of them fragments
 * of its own headings, with the one that mattered (an invented turnaround
 * figure) buried among them. A margin full of false positives is how a
 * reviewer learns to skim the list that exists to stop exactly this.
 */
test('grounding: headings are not mistaken for unverifiable proper nouns', () => {
  const draft = [
    '# Forward Deployed Engineer Interview: The Two Gates Where Most Candidates Get Cut',
    '',
    '## Why the FDE Loop Looks Different From a Normal Engineering Loop',
    '',
    'The role started at Palantir, and that idea still shapes the job today.',
  ].join('\n');

  const { claims } = checkGrounding(draft, [{ label: 'S1P1', text: 'The role started at Palantir.' }], 'article');
  const unsupported = claims.filter((c) => c.status === 'unsupported').map((c) => c.text);

  for (const fragment of ['Gate', 'Two Gates', 'Normal Engineering Loop', 'Candidates Get Cut']) {
    assert.ok(!unsupported.some((u) => u.includes(fragment)),
      `heading fragment "${fragment}" was reported as an unsupported claim`);
  }
});

test('grounding: a body proper noun that no excerpt carries is still reported', () => {
  // Narrowing the check must not switch it off.
  const draft = '## A Heading\n\nThe work was done at Northwind Logistics last spring.';
  const { claims } = checkGrounding(draft, [{ label: 'S1P1', text: 'Nothing relevant.' }], 'article');
  assert.ok(claims.some((c) => c.status === 'unsupported' && c.text.includes('Northwind')));
});
