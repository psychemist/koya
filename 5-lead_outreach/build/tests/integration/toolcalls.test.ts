import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withToolCall } from '../../lib/toolcalls.ts';
import { reserveApifySpend } from '../../lib/budget.ts';
import { ProviderError } from '../../lib/errors.ts';
import { query } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

test('a thrown budget error is logged as denied, not lost', { skip: skipWithoutDatabase },
  async () => {
    const run = await seedRun({ candidate_budget: 0 });
    await assert.rejects(() => withToolCall(run.id, 'discover_companies', 'test', {},
      async () => { throw new ProviderError('BUDGET_RUN', 'cap reached'); }));
    const rows = await query<{ status: string; error_code: string }>(
      'select status, error_code from tool_calls where run_id=$1', [run.id]);
    assert.equal(rows[0].status, 'denied');
    assert.equal(rows[0].error_code, 'BUDGET_RUN');
    await dropRun(run.id);
  });

test('a provider failure is logged as error, which is a different thing',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await assert.rejects(() => withToolCall(run.id, 'scrape_company_site', 'test', {},
      async () => { throw new ProviderError('FIRECRAWL_429', 'rate limited', true); }));
    const rows = await query<{ status: string }>(
      'select status from tool_calls where run_id=$1', [run.id]);
    assert.equal(rows[0].status, 'error');
    await dropRun(run.id);
  });

test('a secret in a tool input never reaches the log', { skip: skipWithoutDatabase },
  async () => {
    const run = await seedRun({});
    await withToolCall(run.id, 't', 'p', { token: 'apify_api_SECRET123' },
      async () => ({ value: 1, resultSummary: {} }));
    const [row] = await query<{ input_summary: unknown }>(
      'select input_summary from tool_calls where run_id=$1', [run.id]);
    assert.ok(!JSON.stringify(row.input_summary).includes('SECRET123'));
    await dropRun(run.id);
  });

test('a started row exists even while the call is still running',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    let seen = '';
    await withToolCall(run.id, 't', 'p', {}, async () => {
      const [row] = await query<{ status: string }>(
        'select status from tool_calls where run_id=$1', [run.id]);
      seen = row.status;
      return { value: 1, resultSummary: {} };
    });
    assert.equal(seen, 'started');
    await dropRun(run.id);
  });

test('the run cap refuses a reservation that would cross it',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    await assert.rejects(
      () => reserveApifySpend(run.id, 99, 'deliberately over cap'),
      (e: any) => e.code === 'BUDGET_RUN');
    await dropRun(run.id);
  });
