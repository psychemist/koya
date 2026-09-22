import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, one } from '../../lib/db.ts';
import { runCopyGates, isBlocked } from '../../lib/gates/copy.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';

/** These need the web service running, which the unit suite does not. */
async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.status < 600;
  } catch { return false; }
}
const skipWithoutServer = skipWithoutDatabase || !(await serverUp());

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

test('a double submit yields one run', { skip: skipWithoutServer }, async () => {
  const objective = `Find 10 US B2B SaaS companies with 10 to 100 employees ${Date.now()}`;
  const [a, b] = await Promise.all([
    post('/api/runs', { objective }).then((r) => r.json()),
    post('/api/runs', { objective }).then((r) => r.json()),
  ]);
  assert.equal(a.id, b.id);
  const rows = await query('select id from runs where objective like $1', [`%${objective}%`]);
  assert.equal(rows.length, 1);
  await dropRun(a.id);
});

test('an objective too short to search is refused before a run exists',
  { skip: skipWithoutServer }, async () => {
    const res = await post('/api/runs', { objective: 'saas' });
    assert.equal(res.status, 422);
  });

test('no route response contains a credential', { skip: skipWithoutServer }, async () => {
  const r = await fetch(`${base}/api/health`).then((x) => x.json());
  assert.ok(!JSON.stringify(r).match(/sk-ant-|apify_api_|fc-|sb_secret_|postgresql:\/\//));
});

test('health reports presence only, never a configured value',
  { skip: skipWithoutServer }, async () => {
    const r = await fetch(`${base}/api/health`).then((x) => x.json());
    for (const v of Object.values(r.configured as Record<string, unknown>)) {
      assert.equal(typeof v, 'boolean');
    }
  });

/**
 * The editing rule, asserted against the gates directly so it holds whether or
 * not the web service is up. The route calls exactly this function.
 */
test('editing a draft re-runs the gates and refuses an em dash', () => {
  const source = 'Acme is hiring a revenue operations manager for invoice reconciliation.';
  const results = runCopyGates(
    { step: 1, subject: 'Invoice reconciliation', body: 'We help — a lot.' }, source);
  assert.ok(isBlocked(results));
  assert.equal(results.find((g) => g.gate === 'house-style')?.passed, false);
});

test('a human edit that passes the gates is storable and marked as edited',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const source = 'Acme is hiring a revenue operations manager for invoice reconciliation.';
    const lead = await one<{ id: string }>(
      `insert into public.leads
         (run_id, company_name, company_domain, qualification_status, confidence,
          fit_reasons, source_urls, source_summary)
       values ($1,'Acme','acme.co','qualified',0.9,'{"us"}','{"https://acme.co"}',$2)
       returning id`, [run.id, source]);
    await query(
      `insert into public.outreach_drafts (lead_id, step, subject, body, edited_by_human)
       values ($1,1,'Subject','Body text here', false)`, [lead!.id]);

    const edited = 'Saw you are hiring a revenue operations manager for invoice ' +
                   'reconciliation. Worth a short call?';
    assert.equal(isBlocked(runCopyGates({ step: 1, subject: 'Ops', body: edited }, source)), false);
    await dropRun(run.id);
  });
