import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getRunState } from '../../lib/agent/tools/get-run-state.ts';
import { saveIcp } from '../../lib/agent/tools/save-icp.ts';
import { discoverCompanies } from '../../lib/agent/tools/discover-companies.ts';
import { scrapeCompanySite } from '../../lib/agent/tools/scrape-company-site.ts';
import { saveLead } from '../../lib/agent/tools/save-lead.ts';
import { saveOutreach } from '../../lib/agent/tools/save-outreach.ts';
import { finishRun } from '../../lib/agent/tools/finish-run.ts';
import { query, one } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

const call = (t: any, args: any): Promise<CallToolResult> => t.handler(args, {});
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

const SOURCE = 'Acme runs onboarding for mid-market payroll teams and is hiring a ' +
               'revenue operations manager to handle manual invoice reconciliation.';

/**
 * This one costs nothing and is the strongest assertion in the file: an
 * argument that does not exist cannot be inflated. Clamping a limit the model
 * can pass is weaker than never accepting one.
 *
 * `headcount_range` is deliberately allowed: it describes the target company,
 * not a limit on this system.
 */
test('no tool accepts a system limit from the model', () => {
  const forbidden = new RegExp(
    '^(max_results|max_items|maxItems|limit|n|top_k|candidate_budget|scrape_budget|' +
    'budget_usd|target_leads|max_turns)$', 'i');
  for (const t of [getRunState, saveIcp, discoverCompanies, scrapeCompanySite,
                   saveLead, saveOutreach, finishRun] as any[]) {
    for (const key of Object.keys(t.inputSchema)) {
      assert.ok(!forbidden.test(key), `${t.name} exposes "${key}" to the model`);
    }
  }
});

test('the tool surface contains no route to a person', () => {
  for (const t of [getRunState, saveIcp, discoverCompanies, scrapeCompanySite,
                   saveLead, saveOutreach, finishRun] as any[]) {
    assert.ok(!/notify|send|email|discord|webhook/i.test(t.name), `reachable: ${t.name}`);
  }
});

test('discover_companies refuses when the candidate budget is gone, before spending',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ candidate_budget: 5, candidates_used: 5 });
    const r = await call(discoverCompanies,
      { run_id: run.id, purpose: 't', query: 'saas', max_results: 999 });
    assert.equal(r.isError, true);
    assert.match(text(r), /BUDGET_RUN/);
    const [logged] = await query<{ status: string; error_code: string }>(
      'select status, error_code from tool_calls where run_id=$1', [run.id]);
    assert.equal(logged.status, 'denied');
    await dropRun(run.id);
  });

test('save_icp refuses an ICP with no hard filter', { skip: skipWithoutDatabase }, async () => {
  const run = await seedRun({});
  const r = await call(saveIcp, {
    run_id: run.id, purpose: 't', target_company_type: 'B2B SaaS', industries: [],
    geography: ['United States'], headcount_range: '10-100', buyer_persona: 'Head of Ops',
    business_problem: 'manual work', hard_filters: [], soft_preferences: [], disqualifiers: [],
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /hard_filters/);
  await dropRun(run.id);
});

test('save_icp parks the run instead of guessing when the objective is too vague',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'refining_icp' });
    const r = await call(saveIcp, {
      run_id: run.id, purpose: 't', target_company_type: '', industries: [], geography: [],
      headcount_range: '', buyer_persona: '', business_problem: '', hard_filters: [],
      soft_preferences: [], disqualifiers: [],
      needs_clarification: 'Which country should I search in?',
    });
    assert.equal(r.isError, undefined);
    const after = await one<{ needs_clarification: string }>(
      'select needs_clarification from runs where id=$1', [run.id]);
    assert.match(after!.needs_clarification, /country/);
    await dropRun(run.id);
  });

test('save_lead refuses a qualified verdict with no evidence',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(saveLead, {
      run_id: run.id, purpose: 't', company_name: 'Acme', company_domain: 'acme.co',
      qualification_status: 'qualified', confidence: 0.9,
      fit_reasons: [], concerns: [], source_urls: [], source_summary: '',
    });
    assert.equal(r.isError, true);
    assert.match(text(r), /fit_reasons|source_urls/);
    await dropRun(run.id);
  });

test('save_lead refuses qualified below the confidence floor',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(saveLead, {
      run_id: run.id, purpose: 't', company_name: 'Acme', company_domain: 'acme.co',
      qualification_status: 'qualified', confidence: 0.2,
      fit_reasons: ['x'], concerns: [], source_urls: ['https://acme.co'], source_summary: 's',
    });
    assert.equal(r.isError, true);
    assert.match(text(r), /0\.40/);
    await dropRun(run.id);
  });

test('save_lead refuses a source URL this run never retrieved',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(saveLead, {
      run_id: run.id, purpose: 't', company_name: 'Acme', company_domain: 'acme.co',
      qualification_status: 'qualified', confidence: 0.9,
      fit_reasons: ['US based, stated on the site'], concerns: [],
      source_urls: ['https://acme.co/about'], source_summary: SOURCE,
    });
    assert.equal(r.isError, true);
    assert.match(text(r), /actually scraped|retrieved/i);
    await dropRun(run.id);
  });

test('needs_review is storable without evidence, because it is the honest answer',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(saveLead, {
      run_id: run.id, purpose: 't', company_name: 'Acme', company_domain: 'acme.co',
      qualification_status: 'needs_review', confidence: 0.3,
      fit_reasons: [], concerns: ['headcount not stated anywhere'],
      source_urls: [], source_summary: 'Thin site.',
    });
    assert.equal(r.isError, undefined);
    await dropRun(run.id);
  });

/**
 * The agent is now told to save several verdicts in one turn, so two calls for
 * the same company can be genuinely in flight at once. Before the insert
 * became an upsert this raced: both calls read no existing row, both inserted,
 * and the loser surfaced a raw unique-violation instead of the refusal.
 */
test('two verdicts for one company in the same turn leave one lead and a clean refusal',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const verdict = {
      run_id: run.id, purpose: 't', company_name: 'Acme', company_domain: 'acme.co',
      qualification_status: 'needs_review', confidence: 0.3,
      fit_reasons: [], concerns: ['headcount not stated'], source_urls: [],
      source_summary: 'Thin site.',
    };
    const [a, b] = await Promise.all([call(saveLead, verdict), call(saveLead, verdict)]);

    const errors = [a, b].filter((r) => r.isError);
    assert.equal(errors.length, 1, 'exactly one of the two calls should be refused');
    assert.match(text(errors[0]), /appears once|already has a stored verdict/i);

    const rows = await query(
      'select id from public.leads where run_id = $1 and company_domain = $2',
      [run.id, 'acme.co']);
    assert.equal(rows.length, 1, 'the race stored the company twice');
    await dropRun(run.id);
  });

test('scrape_company_site refuses a domain that is not a candidate of this run',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(scrapeCompanySite,
      { run_id: run.id, purpose: 't', url: 'https://not-a-candidate.example/about' });
    assert.equal(r.isError, true);
    assert.match(text(r), /not a candidate/);
    await dropRun(run.id);
  });

test('save_outreach refuses a draft with an em dash and says which gate',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.scraped_pages
         (run_id, company_domain, url, content_hash, screened_summary)
       values ($1,'acme.co','https://acme.co/about','h',$2)`, [run.id, SOURCE]);
    const lead = await one<{ id: string }>(
      `insert into public.leads
         (run_id, company_name, company_domain, qualification_status, confidence,
          fit_reasons, source_urls, source_summary)
       values ($1,'Acme','acme.co','qualified',0.9,'{"us"}','{"https://acme.co/about"}',$2)
       returning id`, [run.id, SOURCE]);

    const r = await call(saveOutreach, {
      run_id: run.id, purpose: 't', lead_id: lead!.id,
      steps: [{ step: 1, subject: 'Hi',
                body: 'You build payroll tools — we can help.',
                personalization_note: 'from the about page' }],
    });
    assert.equal(r.isError, true);
    assert.match(text(r), /house-style/);
    await dropRun(run.id);
  });

test('finish_run refuses complete when the recount disagrees',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(finishRun,
      { run_id: run.id, purpose: 't', claimed_qualified: 10, summary: 'done' });
    assert.equal(r.isError, true);
    assert.match(text(r), /recount/i);
    await dropRun(run.id);
  });

test('finish_run refuses to end short without a stated reason',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(finishRun,
      { run_id: run.id, purpose: 't', claimed_qualified: 0, summary: 'nothing found' });
    assert.equal(r.isError, true);
    assert.match(text(r), /shortfall_reason/);
    await dropRun(run.id);
  });

test('finish_run ends partial with a reason, and does not pad',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'drafting' });
    const r = await call(finishRun, {
      run_id: run.id, purpose: 't', claimed_qualified: 0, summary: 'nothing found',
      shortfall_reason: 'Candidate budget exhausted at 38 of 40 assessed.',
    });
    assert.equal(r.isError, undefined);
    const after = await one<{ status: string; shortfall_reason: string }>(
      'select status, shortfall_reason from runs where id=$1', [run.id]);
    assert.equal(after!.status, 'partial');
    assert.match(after!.shortfall_reason, /Candidate budget/);
    await dropRun(run.id);
  });

test('get_run_state never throws, even on a run with nothing in it',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const r = await call(getRunState, { run_id: run.id, purpose: 't' });
    assert.equal(r.isError, undefined);
    await dropRun(run.id);
  });

test('get_run_state returns usable text rather than failing on an unknown run',
  { skip: skipWithoutDatabase }, async () => {
    const r = await call(getRunState,
      { run_id: '00000000-0000-0000-0000-000000000000', purpose: 't' });
    assert.equal(r.isError, undefined);
    assert.match(text(r), /unavailable/i);
  });
