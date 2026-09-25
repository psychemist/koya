import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHumanVerdict } from '../../lib/review.ts';
import { runStats } from '../../lib/runs.ts';
import { query, one } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/**
 * The review action used to be a dead end.
 *
 * `human_status` was written, rendered back as "You marked this accepted", and
 * carried into the export. It did not change `qualification_status`, count
 * toward the target, produce drafts, reach the delivered list, or survive into
 * a later run. The run of 2026-09-25 finished at 8 of 10 with two needs_review
 * leads sitting next to a button that did nothing about it.
 */

type LeadSeed = {
  status?: string; confidence?: number;
  fit?: string[]; sources?: string[]; domain?: string;
};

async function seedLead(runId: string, s: LeadSeed = {}) {
  const row = await one<{ id: string; company_domain: string }>(
    `insert into public.leads
       (run_id, company_name, company_domain, qualification_status, confidence,
        fit_reasons, source_urls)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, company_domain`,
    [runId, 'Acme', s.domain ?? `acme-${Math.random().toString(36).slice(2, 8)}.com`,
     s.status ?? 'needs_review', s.confidence ?? 0.55,
     s.fit ?? ['Sells B2B SaaS, per the company site'],
     s.sources ?? ['https://acme.com/about']],
  );
  return row!;
}

const delivered = (domain: string) =>
  one<{ company_domain: string }>(
    'select company_domain from public.delivered_domains where company_domain = $1', [domain]);

test('accepting a needs_review lead qualifies it, so it counts toward the target',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ target_leads: 10 });
    const lead = await seedLead(run.id);

    assert.equal((await runStats(run.id)).qualified, 0);

    await applyHumanVerdict(lead.id, 'accepted', null);

    const stats = await runStats(run.id);
    assert.equal(stats.qualified, 1, 'the promotion did not reach the counter');
    assert.equal(stats.needsReview, 0);

    await dropRun(run.id);
  });

test('the verdict the agent wrote survives the override', { skip: skipWithoutDatabase },
  async () => {
    const run = await seedRun();
    const lead = await seedLead(run.id, { status: 'needs_review' });

    await applyHumanVerdict(lead.id, 'accepted', null);

    const [row] = await query<{ agent_verdict: string; human_decided_at: Date | null }>(
      'select agent_verdict, human_decided_at from public.leads where id = $1', [lead.id]);
    assert.equal(row.agent_verdict, 'needs_review',
      'the agent judgement was erased rather than overridden');
    assert.ok(row.human_decided_at, 'nothing records when a human decided');

    await dropRun(run.id);
  });

test('a second change does not rewrite the original agent verdict',
  { skip: skipWithoutDatabase }, async () => {
    // Otherwise the trail says the agent qualified it, when the agent did not.
    const run = await seedRun();
    const lead = await seedLead(run.id, { status: 'needs_review' });

    await applyHumanVerdict(lead.id, 'accepted', null);
    await applyHumanVerdict(lead.id, 'rejected', 'Looked again, it is an agency.');

    const [row] = await query<{ agent_verdict: string; qualification_status: string }>(
      'select agent_verdict, qualification_status from public.leads where id = $1', [lead.id]);
    assert.equal(row.agent_verdict, 'needs_review');
    assert.equal(row.qualification_status, 'not_qualified');

    await dropRun(run.id);
  });

test('a promoted lead reaches the delivered list, so a later run does not rediscover it',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun();
    const lead = await seedLead(run.id);
    assert.equal(await delivered(lead.company_domain), null);

    await applyHumanVerdict(lead.id, 'accepted', null);

    assert.ok(await delivered(lead.company_domain), 'the promotion never reached delivery');

    await query('delete from public.delivered_domains where company_domain = $1',
      [lead.company_domain]);
    await dropRun(run.id);
  });

test('a promoted lead with no drafts says so rather than shipping with no copy',
  { skip: skipWithoutDatabase }, async () => {
    // The agent only writes copy for leads it qualified itself, so a lead
    // promoted afterwards has none. Silence here would hand a reviewer a
    // qualified company with nothing to send.
    const run = await seedRun();
    const lead = await seedLead(run.id);

    await applyHumanVerdict(lead.id, 'accepted', null);

    const [row] = await query<{ drafts_blocked: string | null }>(
      'select drafts_blocked from public.leads where id = $1', [lead.id]);
    assert.ok(row.drafts_blocked && /hand/i.test(row.drafts_blocked),
      `a promoted lead with no drafts was left silent: ${row.drafts_blocked}`);

    await dropRun(run.id);
  });

test('a lead with no evidence cannot be promoted, and is told why',
  { skip: skipWithoutDatabase }, async () => {
    /**
     * `leads_qualified_needs_evidence` refuses to store a qualified lead
     * without a fit reason, a source and confidence of at least 0.40. That
     * constraint is the point of the system, so a human cannot click past it
     * either. What must not happen is a raw constraint violation reaching the
     * reviewer as a 500.
     */
    const run = await seedRun();
    const lead = await seedLead(run.id, { sources: [], confidence: 0.2 });

    await assert.rejects(
      () => applyHumanVerdict(lead.id, 'accepted', null),
      (e: any) => e.code === 'REVIEW_NO_EVIDENCE' && /source/i.test(e.message));

    // And it stayed where it was.
    const [row] = await query<{ qualification_status: string; agent_verdict: string | null }>(
      'select qualification_status, agent_verdict from public.leads where id = $1', [lead.id]);
    assert.equal(row.qualification_status, 'needs_review');
    assert.equal(row.agent_verdict, null, 'a refused promotion still stamped provenance');

    await dropRun(run.id);
  });

test('rejecting a qualified lead demotes it and withdraws it from delivery',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun();
    const lead = await seedLead(run.id, { status: 'qualified' });
    await query(
      `insert into public.delivered_domains (company_domain, first_run_id) values ($1,$2)`,
      [lead.company_domain, run.id]);

    await applyHumanVerdict(lead.id, 'rejected', 'Consumer product, not B2B.');

    const [row] = await query<{ qualification_status: string; human_note: string }>(
      'select qualification_status, human_note from public.leads where id = $1', [lead.id]);
    assert.equal(row.qualification_status, 'not_qualified');
    assert.match(row.human_note, /Consumer product/);
    assert.equal(await delivered(lead.company_domain), null,
      'a withdrawn lead stayed on the delivered list and will be suppressed for ever');

    await dropRun(run.id);
  });

test('a rejection does not withdraw a domain an earlier run delivered',
  { skip: skipWithoutDatabase }, async () => {
    // Delivery is global. Removing a domain this run did not deliver would
    // resurface a company somebody else already handed over.
    const earlier = await seedRun();
    const run = await seedRun();
    const lead = await seedLead(run.id, { status: 'qualified' });
    await query(
      `insert into public.delivered_domains (company_domain, first_run_id) values ($1,$2)`,
      [lead.company_domain, earlier.id]);

    await applyHumanVerdict(lead.id, 'rejected', 'Not a fit.');

    assert.ok(await delivered(lead.company_domain),
      "another run's delivery was withdrawn by this run's reviewer");

    await query('delete from public.delivered_domains where company_domain = $1',
      [lead.company_domain]);
    await dropRun(run.id);
    await dropRun(earlier.id);
  });

test('a note with no verdict is still saved', { skip: skipWithoutDatabase }, async () => {
  const run = await seedRun();
  const lead = await seedLead(run.id);

  await applyHumanVerdict(lead.id, null, 'Checking with the founder first.');

  const [row] = await query<{ human_note: string; qualification_status: string }>(
    'select human_note, qualification_status from public.leads where id = $1', [lead.id]);
  assert.match(row.human_note, /founder/);
  assert.equal(row.qualification_status, 'needs_review', 'a bare note changed the verdict');

  await dropRun(run.id);
});
