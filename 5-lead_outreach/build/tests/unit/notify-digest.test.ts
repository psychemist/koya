import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../../lib/notify/index.ts';

const run = { objective: 'Find 10 US B2B SaaS companies', apify_spend_usd: 0.19,
              claude_cost_usd: 0.58, agent_turns: 41, shortfall_reason: null } as any;
const stats = { assessed: 38, qualified: 10, needsReview: 4, notQualified: 24,
                flaggedPages: 2, blockedDrafts: 1 };

test('the digest names the two counts a reviewer has to act on', () => {
  const d = buildDigest(run, stats).join('\n');
  assert.match(d, /2 pages were flagged/);
  assert.match(d, /1 lead has blocked drafts/);
});

test('zero counts are omitted rather than reported as zero', () => {
  const d = buildDigest(run, { ...stats, flaggedPages: 0, blockedDrafts: 0 }).join('\n');
  assert.ok(!d.includes('flagged'));
  assert.ok(!d.includes('blocked drafts'));
});

test('cost is labelled as an estimate, because the SDK says it is one', () => {
  assert.match(buildDigest(run, stats).join('\n'), /estimate/i);
});

test('a shortfall reason is carried into the digest verbatim', () => {
  const d = buildDigest({ ...run, shortfall_reason: 'Candidate budget exhausted at 38 of 40.' },
                        stats).join('\n');
  assert.match(d, /Candidate budget exhausted at 38 of 40\./);
});

test('no em dash reaches a person', () => {
  assert.ok(!buildDigest(run, stats).join('\n').match(/[—–]|(?<!-)--(?!-)/));
});

test('a single flagged page reads as singular, because a reviewer notices the seam', () => {
  const d = buildDigest(run, { ...stats, flaggedPages: 1, blockedDrafts: 2 }).join('\n');
  assert.match(d, /1 page was flagged/);
  assert.match(d, /2 leads have blocked drafts/);
});
