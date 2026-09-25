import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContinuation } from '../../lib/continuation.ts';
import { query } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/**
 * A run that falls short has already paid for its ICP and for every company it
 * discovered. Starting again from the objective throws all of that away and
 * pays Apify and Claude to reach the same place.
 */
const ICP = {
  industries: ['Software Development'], geography: ['United States'],
  headcount_range: '10 to 100', hard_filters: ['Company is B2B'], disqualifiers: [],
};

test('a continuation inherits the criteria and records its parent',
  { skip: skipWithoutDatabase }, async () => {
    const parent = await seedRun({
      status: 'partial', icp: ICP as any, objective: 'Find B2B SaaS', target_leads: 10,
    });

    const child = await createContinuation(parent.id, parent.created_by ?? null);

    assert.equal(child.parent_run_id, parent.id);
    assert.deepEqual(child.icp, ICP, 'the ICP was re-derived instead of inherited');
    assert.equal(child.objective, parent.objective);
    assert.equal(child.target_leads, parent.target_leads);
    assert.equal(child.status, 'queued');

    await dropRun(child.id);
    await dropRun(parent.id);
  });

test('a continuation starts with its own full budget', { skip: skipWithoutDatabase },
  async () => {
    // Reopening the parent would make its finished_at a lie and its spend
    // unattributable. A child is a separate run, so it is separately bounded.
    const parent = await seedRun({
      status: 'partial', icp: ICP as any, candidates_used: 40, scrapes_used: 30,
    });

    const child = await createContinuation(parent.id, parent.created_by ?? null);

    assert.equal(child.candidates_used, 0);
    assert.equal(child.scrapes_used, 0);

    await dropRun(child.id);
    await dropRun(parent.id);
  });

test('candidates the parent never assessed carry over, and assessed ones do not',
  { skip: skipWithoutDatabase }, async () => {
    const parent = await seedRun({ status: 'partial', icp: ICP as any });
    await query(
      `insert into public.candidates (run_id, company_name, company_domain, assessed)
       values ($1,'Unseen','unseen-co.com',false), ($1,'Judged','judged-co.com',true)`,
      [parent.id]);

    const child = await createContinuation(parent.id, parent.created_by ?? null);

    const carried = await query<{ company_domain: string }>(
      'select company_domain from public.candidates where run_id = $1 order by 1', [child.id]);
    assert.deepEqual(carried.map((c) => c.company_domain), ['unseen-co.com'],
      'the child re-discovers work the parent already paid for');

    await dropRun(child.id);
    await dropRun(parent.id);
  });

test('a run that is still working cannot be continued', { skip: skipWithoutDatabase },
  async () => {
    // Two runs on one ICP at once would double the spend and race each other
    // to the same companies.
    const parent = await seedRun({ status: 'discovering', icp: ICP as any });
    await assert.rejects(
      () => createContinuation(parent.id, parent.created_by ?? null),
      (e: any) => e.code === 'CONTINUE_NOT_FINISHED');
    await dropRun(parent.id);
  });

test('a run with no ICP has nothing to continue from', { skip: skipWithoutDatabase },
  async () => {
    const parent = await seedRun({ status: 'failed' });
    await assert.rejects(
      () => createContinuation(parent.id, parent.created_by ?? null),
      (e: any) => e.code === 'CONTINUE_NO_ICP');
    await dropRun(parent.id);
  });
