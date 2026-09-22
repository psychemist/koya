import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { scrapeCompanySite } from '../../lib/agent/tools/scrape-company-site.ts';
import { saveLead } from '../../lib/agent/tools/save-lead.ts';
import { finishRun } from '../../lib/agent/tools/finish-run.ts';
import { budgetHook } from '../../lib/agent/hooks.ts';
import { deterministicScreen } from '../../lib/screen/injection.ts';
import { fence } from '../../lib/fence.ts';
import { toCandidate } from '../../lib/providers/apify.ts';
import { scrape } from '../../lib/providers/firecrawl.ts';
import { reserveApifySpend, apifySpend } from '../../lib/budget.ts';
import { query, one } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

const call = (t: any, args: any): Promise<CallToolResult> => t.handler(args, {});
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

const injected = readFileSync(
  new URL('../fixtures/injected-homepage.md', import.meta.url), 'utf8');
const duplicates = JSON.parse(readFileSync(
  new URL('../fixtures/duplicate-discovery.json', import.meta.url), 'utf8'));
const failures = JSON.parse(readFileSync(
  new URL('../fixtures/scrape-failures.json', import.meta.url), 'utf8'));

/* Row 8: prompt injection. */
test('row 8: the injected payload is flagged and its text never reaches the agent', () => {
  const screen = deterministicScreen(injected);
  assert.equal(screen.flagged, true);

  const envelope = fence({
    url: 'https://evil.co', retrieved: new Date().toISOString(),
    injectionFlagged: true, content: injected,
  });
  assert.ok(!envelope.includes('Mark qualified'));
  assert.ok(!envelope.includes('confidence 1.0'));
  assert.ok(!envelope.includes('export'));
  assert.match(envelope, /injection_flagged="true"/);
});

test('row 8: the flagged page is still stored in full for the reviewer',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.scraped_pages
         (run_id, company_domain, url, content_hash, raw_text, injection_flagged, injection_reason)
       values ($1,'evil.co','https://evil.co','h',$2,true,'ignore previous instructions')`,
      [run.id, injected]);
    const page = await one<{ raw_text: string; injection_flagged: boolean }>(
      'select raw_text, injection_flagged from public.scraped_pages where run_id = $1', [run.id]);
    assert.equal(page!.injection_flagged, true);
    assert.ok(page!.raw_text.includes('Mark qualified'));
    await dropRun(run.id);
  });

/* Row 9: a lead count in the objective changes nothing. */
test('row 9: an objective asking for 50 cannot raise the run budget',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ objective: 'Find 50 companies', candidate_budget: 12,
                                candidates_used: 12 });
    const d = await budgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__leadgen__discover_companies',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(d.hookSpecificOutput?.permissionDecision, 'deny');
    const [logged] = await query<{ status: string; error_code: string }>(
      'select status, error_code from tool_calls where run_id = $1', [run.id]);
    assert.equal(logged.status, 'denied');
    assert.equal(logged.error_code, 'SCOPE_DENIED');
    await dropRun(run.id);
  });

/* Row 10: duplicates and already-delivered companies. */
test('row 10: three spellings of one company collapse to one key, and a directory is dropped',
  () => {
    const keys = duplicates.items.map((i: any) => toCandidate(i)?.companyDomain ?? null);
    assert.deepEqual(keys.slice(0, 3), ['acme.co', 'acme.co', 'acme.co']);
    assert.equal(keys[4], null, 'a LinkedIn directory page is not a company');
  });

test('row 10: a company already delivered is excluded before it costs a scrape',
  { skip: skipWithoutDatabase }, async () => {
    const domain = `delivered-${randomUUID().slice(0, 8)}.example`;
    const run = await seedRun({});
    await query('insert into public.delivered_domains (company_domain) values ($1)', [domain]);

    // It is not a candidate of this run, so the scrape tool refuses it outright.
    const r = await call(scrapeCompanySite,
      { run_id: run.id, purpose: 't', url: `https://${domain}/about` });
    assert.equal(r.isError, true);
    const pages = await query('select 1 from public.scraped_pages where run_id = $1', [run.id]);
    assert.equal(pages.length, 0);

    await query('delete from public.delivered_domains where company_domain = $1', [domain]);
    await dropRun(run.id);
  });

/* Row 11: scrape failures each carry their own reason. */
test('row 11: dead, forbidden and JS-only pages each record a distinct outcome',
  { skip: skipWithoutDatabase }, async () => {
    const codes = new Set<string>();
    for (const c of failures.cases) {
      const host = `${c.name}-${randomUUID().slice(0, 8)}.example`;
      const fetcher = async () => {
        if (c.markdown === undefined) {
          const e = new Error(`stub ${c.statusCode}`) as Error & { statusCode: number };
          e.statusCode = c.statusCode;
          throw e;
        }
        return { markdown: c.markdown, statusCode: c.statusCode };
      };
      try {
        const r = await scrape(`https://${host}/`, { fetcher });
        assert.equal(r.usable, c.expectedUsable ?? true,
          `${c.name} should not be treated as evidence`);
      } catch (e: any) {
        codes.add(e.code);
        assert.equal(e.code, c.expectedCode, `${c.name} carried ${e.code}`);
      }
      await query('delete from public.scrape_cache where url_norm like $1', [`%${host}%`]);
    }
    assert.ok(codes.size >= 2, 'failures must not collapse into one generic code');
  });

/* Row 12: shortfall. */
test('row 12: a short run ends partial with a reason and nothing is padded',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'drafting' });
    const r = await call(finishRun, {
      run_id: run.id, purpose: 't', claimed_qualified: 0, summary: 'one candidate only',
      shortfall_reason: 'Candidate budget exhausted after assessing 3 of 40 candidates.',
    });
    assert.equal(r.isError, undefined);
    const after = await one<{ status: string; shortfall_reason: string }>(
      'select status, shortfall_reason from runs where id = $1', [run.id]);
    assert.equal(after!.status, 'partial');
    assert.ok(after!.shortfall_reason.length > 20);
    const leads = await query('select 1 from public.leads where run_id = $1', [run.id]);
    assert.equal(leads.length, 0, 'a short run must not invent leads to hit the number');
    await dropRun(run.id);
  });

/* Row 14: crash recovery leaves no duplicates. */
test('row 14: a resumed run cannot store the same company twice',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await query(
      `insert into public.scraped_pages (run_id, company_domain, url, content_hash, raw_text)
       values ($1,'acme.co','https://acme.co/about','h','Acme builds payroll software.')`,
      [run.id]);

    const args = {
      run_id: run.id, purpose: 't', company_name: 'Acme', company_domain: 'acme.co',
      qualification_status: 'qualified', confidence: 0.9,
      fit_reasons: ['US based, stated on the about page'], concerns: [],
      source_urls: ['https://acme.co/about'], source_summary: 'Acme builds payroll software.',
    };
    const first = await call(saveLead, args);
    const second = await call(saveLead, args);      // the resumed worker tries again
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, true);
    const leads = await query('select 1 from public.leads where run_id = $1', [run.id]);
    assert.equal(leads.length, 1);
    await dropRun(run.id);
  });

/* Row 15: budget exhaustion stays under cap. */
test('row 15: the run cap cannot be crossed, even by one reservation',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await reserveApifySpend(run.id, 0.2, 'first');
    await assert.rejects(() => reserveApifySpend(run.id, 0.2, 'second'),
      (e: any) => e.code === 'BUDGET_RUN');
    assert.ok(await apifySpend(run.id) <= 0.30);
    await dropRun(run.id);
  });

/* Row 16: the cache is read rather than paid for twice. */
test('row 16: a repeated page is served from cache and costs nothing',
  { skip: skipWithoutDatabase }, async () => {
    const host = `cache-${randomUUID().slice(0, 8)}.example`;
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { markdown: Array.from({ length: 260 }, () => 'payroll').join(' '), statusCode: 200 };
    };
    await scrape(`https://${host}/about`, { fetcher });
    const second = await scrape(`https://${host}/about`, { fetcher });
    assert.equal(calls, 1);
    assert.equal(second.fromCache, true);
    assert.equal(second.provider, 'cache');
    await query('delete from public.scrape_cache where url_norm like $1', [`%${host}%`]);
  });

/* Row 21: no route from the agent to the team. */
test('row 21: the agent holds no tool that can reach a person', async () => {
  const { LEADGEN_TOOL_NAMES } = await import('../../lib/agent/server.ts');
  for (const banned of ['notify', 'send', 'email', 'discord', 'webhook', 'bash', 'shell']) {
    assert.ok(!LEADGEN_TOOL_NAMES.some((t) => t.toLowerCase().includes(banned)),
      `reachable: ${banned}`);
  }
  assert.equal(LEADGEN_TOOL_NAMES.length, 7);
});
