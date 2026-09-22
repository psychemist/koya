import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, query } from '../../lib/db.ts';
import { loadRun } from '../../lib/runs.ts';
import { budgetHook } from '../../lib/agent/hooks.ts';
import { recomputeScorecard } from '../../lib/gates/list-quality.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/** The claim predicate, as the worker applies it. */
async function isClaimable(runId: string): Promise<boolean> {
  const rows = await query(
    `select id from public.runs
      where id = $1
        and needs_clarification is null
        and ((status = 'queued' and claimed_at is null)
             or (status not in ('complete','partial','failed')
                 and claimed_at < now() - interval '15 minutes'))`,
    [runId]);
  return rows.length === 1;
}

test('a parked run is frozen: not claimable, and no spending tool is permitted',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({
      status: 'refining_icp', needs_clarification: 'Which country?',
    } as any);
    assert.equal(await isClaimable(run.id), false);
    const d = await budgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__leadgen__discover_companies',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(d.hookSpecificOutput?.permissionDecision, 'deny');
    await dropRun(run.id);
  });

test('answering the question carries it into the objective and re-queues the run',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({
      status: 'refining_icp',
      needs_clarification: 'Which country should I search in?',
      claimed_by: 'w1', claimed_at: new Date(),
    } as any);

    // The route's update, asserted directly so the test does not need the web
    // service running.
    const updated = await one<{ id: string }>(
      `update public.runs
          set objective = objective || E'\\n\\n' || $2,
              needs_clarification = null, status = 'queued',
              claimed_by = null, claimed_at = null, version = version + 1
        where id = $1 and needs_clarification is not null
        returning id`,
      [run.id, 'The operator was asked: Which country should I search in?\n' +
               'They answered: United States only.'],
    );
    assert.ok(updated);

    const after = await loadRun(run.id);
    assert.equal(after.needs_clarification, null);
    assert.equal(after.status, 'queued');
    // The agent only ever reads the objective, so an answer it cannot read
    // would park the run again on the same question.
    assert.match(after.objective, /United States only/);
    assert.equal(await isClaimable(run.id), true);
    await dropRun(run.id);
  });

test('a second answer to the same question is refused rather than re-queueing twice',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'queued' });   // already answered, nothing pending
    const again = await one(
      `update public.runs set needs_clarification = null
        where id = $1 and needs_clarification is not null returning id`, [run.id]);
    assert.equal(again, null);
    await dropRun(run.id);
  });

test('the scorecard refuses a qualified lead whose sources this run never fetched',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.leads
         (run_id, company_name, company_domain, qualification_status, confidence,
          fit_reasons, source_urls, source_summary)
       values ($1,'Acme','acme.co','qualified',0.9,'{"US based"}',
               '{"https://acme.co/about"}','Acme builds payroll software.')`,
      [run.id]);

    const card = await recomputeScorecard(run.id);
    assert.equal(card.passed, false);
    const evidence = card.dimensions.find((d) => d.dimension === 'Evidence quality');
    assert.equal(evidence?.passed, false);
    assert.match(evidence!.detail, /Acme/);
    await dropRun(run.id);
  });

test('the scorecard passes a complete, evidenced, drafted lead',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.scraped_pages
         (run_id, company_domain, url, content_hash, screened_summary)
       values ($1,'acme.co','https://acme.co/about','h','Acme builds payroll software.')`,
      [run.id]);
    const lead = await one<{ id: string }>(
      `insert into public.leads
         (run_id, company_name, company_domain, qualification_status, confidence,
          fit_reasons, source_urls, source_summary)
       values ($1,'Acme','acme.co','qualified',0.9,'{"US based"}',
               '{"https://acme.co/about"}','Acme builds payroll software.')
       returning id`, [run.id]);
    await query(
      `insert into public.outreach_drafts (lead_id, step, subject, body)
       values ($1,1,'Payroll','Saw you build payroll software. Worth a short call?')`,
      [lead!.id]);

    const card = await recomputeScorecard(run.id);
    assert.equal(card.passed, true, JSON.stringify(card.dimensions, null, 2));
    assert.equal(card.qualified, 1);
    await dropRun(run.id);
  });

test('the scorecard catches a personal address that reached a stored draft',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.scraped_pages
         (run_id, company_domain, url, content_hash, screened_summary)
       values ($1,'acme.co','https://acme.co/about','h','Acme builds payroll software.')`,
      [run.id]);
    const lead = await one<{ id: string }>(
      `insert into public.leads
         (run_id, company_name, company_domain, qualification_status, confidence,
          fit_reasons, source_urls, source_summary)
       values ($1,'Acme','acme.co','qualified',0.9,'{"US based"}',
               '{"https://acme.co/about"}','Acme builds payroll software.')
       returning id`, [run.id]);
    // Written straight to the table, bypassing the gates, which is exactly the
    // case this recount exists to catch.
    await query(
      `insert into public.outreach_drafts (lead_id, step, body)
       values ($1,1,'Reach me and also jane.doe@acme.co about payroll.')`,
      [lead!.id]);

    const card = await recomputeScorecard(run.id);
    assert.equal(card.passed, false);
    assert.equal(card.dimensions.find((d) => d.dimension === 'Safety compliance')?.passed, false);
    await dropRun(run.id);
  });

test('a generic role address the company publishes is not a personal address',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.scraped_pages
         (run_id, company_domain, url, content_hash, screened_summary)
       values ($1,'acme.co','https://acme.co/about','h','Acme builds payroll software.')`,
      [run.id]);
    const lead = await one<{ id: string }>(
      `insert into public.leads
         (run_id, company_name, company_domain, qualification_status, confidence,
          fit_reasons, source_urls, source_summary)
       values ($1,'Acme','acme.co','qualified',0.9,'{"US based"}',
               '{"https://acme.co/about"}','Acme builds payroll software.')
       returning id`, [run.id]);
    await query(
      `insert into public.outreach_drafts (lead_id, step, body)
       values ($1,1,'Payroll software. Reply here or to hello@acme.co.')`,
      [lead!.id]);

    const card = await recomputeScorecard(run.id);
    assert.equal(card.dimensions.find((d) => d.dimension === 'Safety compliance')?.passed, true);
    await dropRun(run.id);
  });
