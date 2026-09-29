import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recomputeScorecard } from '../../lib/gates/list-quality.ts';
import { query, one } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/**
 * A scorecard nobody can satisfy is a trap, not a standard.
 *
 * `finish_run` refuses to end a run whose list does not pass, which is right.
 * It stops an agent declaring a bad list finished. But it means every
 * dimension has to be satisfiable by a run doing its job properly, and one of
 * them stopped being so the moment drafting moved out of the run: Outreach
 * relevance demanded that every qualified lead carry drafts or a stated
 * blocker, and a run that writes no copy can supply neither.
 *
 * Run 64a17413 paid for that: ten calls to finish_run, eight refused on this
 * dimension, seventy turns and $1.57 spent on a run that could not be allowed
 * to end. These tests are the reason it cannot happen again.
 */
const SOURCE = 'Acme runs onboarding for mid-market payroll teams and is hiring a '
  + 'revenue operations manager to handle manual invoice reconciliation.';

async function seedQualified(runId: string, domain: string) {
  await query(
    `insert into public.scraped_pages
       (run_id, company_domain, url, content_hash, screened_summary, http_status)
     values ($1,$2,$3,'h',$4,200)`,
    [runId, domain, `https://${domain}/about`, SOURCE]);
  const lead = await one<{ id: string }>(
    `insert into public.leads
       (run_id, company_name, company_domain, qualification_status, confidence,
        fit_reasons, source_urls, source_summary)
     values ($1,'Acme',$2,'qualified',0.8,ARRAY['Hiring a revenue operations manager'],
             ARRAY[$3],$4)
     returning id`,
    [runId, domain, `https://${domain}/about`, SOURCE]);
  return lead!.id;
}

test('a qualified lead with no copy passes the list scorecard',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await seedQualified(run.id, 'no-copy.test');

    const card = await recomputeScorecard(run.id);
    const outreach = card.dimensions.find((d) => d.dimension === 'Outreach relevance');
    assert.ok(outreach, 'the dimension disappeared rather than being satisfiable');
    assert.equal(outreach!.passed, true, outreach!.detail);
    assert.equal(card.passed, true,
      `a run that qualified a lead and wrote no copy could not finish: ` +
      card.dimensions.filter((d) => !d.passed).map((d) => d.detail).join(' | '));
    await dropRun(run.id);
  });

test('a draft stored with no body still fails, because that is a real fault',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const leadId = await seedQualified(run.id, 'hollow-copy.test');
    await query(
      `insert into public.outreach_drafts (lead_id, step, subject, body, personalization_note)
       values ($1, 1, 'Subject', '   ', 'note')`, [leadId]);

    const card = await recomputeScorecard(run.id);
    const outreach = card.dimensions.find((d) => d.dimension === 'Outreach relevance');
    assert.equal(outreach!.passed, false, 'an empty draft passed as copy');
    await dropRun(run.id);
  });

test('copy written on request passes, and says how much it judged',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const leadId = await seedQualified(run.id, 'real-copy.test');
    await query(
      `insert into public.outreach_drafts (lead_id, step, subject, body, personalization_note)
       values ($1, 1, 'Manual reconciliation at Acme', $2, 'Hiring an ops manager')`,
      [leadId, 'You are hiring a revenue operations manager to handle reconciliation.']);

    const card = await recomputeScorecard(run.id);
    const outreach = card.dimensions.find((d) => d.dimension === 'Outreach relevance');
    assert.equal(outreach!.passed, true, outreach!.detail);
    assert.match(outreach!.detail, /carries copy/);
    await dropRun(run.id);
  });
