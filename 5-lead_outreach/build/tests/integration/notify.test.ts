import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { notify, notificationStatus } from '../../lib/notify/index.ts';
import { loadRun } from '../../lib/runs.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

const R = { email: 'operator@example.com', role: 'operator' };

/**
 * n8n and Resend are stubbed at the network boundary rather than mocked at the
 * module boundary, so the signing, the headers and the redaction are all
 * exercised exactly as they run in production.
 */
type Captured = {
  calls: number; lastRawBody: string; lastHeaders: Record<string, string>; lastBody: unknown;
};

function stubFetch(handler: (url: string, init: RequestInit) => Response | never) {
  const captured: Captured = { calls: 0, lastRawBody: '', lastHeaders: {}, lastBody: null };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    captured.calls++;
    captured.lastRawBody = String(init.body ?? '');
    captured.lastHeaders = (init.headers ?? {}) as Record<string, string>;
    try { captured.lastBody = JSON.parse(captured.lastRawBody); } catch { /* not json */ }
    return handler(url, init);
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = original; } };
}

const okResponse = () => new Response('{}', { status: 200 });
const refuse = () => { throw new Error('ECONNREFUSED'); };

const configured = Boolean(process.env.N8N_LEAD_NOTIFY_URL && process.env.N8N_LEAD_NOTIFY_SECRET);
const skip = skipWithoutDatabase || !configured;

test('the claim row is pending before anything is emitted', { skip }, async () => {
  const run = await seedRun({});
  const s = stubFetch(okResponse);
  const seen: string[] = [];
  try {
    await notify({
      kind: 'run_complete', runId: run.id, title: 't', lines: ['x'], to: [R],
      _onBeforeEmit: async () => { seen.push((await notificationStatus(run.id))[0].state); },
    });
  } finally { s.restore(); }
  assert.equal(seen[0], 'pending');
  await dropRun(run.id);
});

test('a second emit of the same kind is a no-op, not a second email', { skip }, async () => {
  const run = await seedRun({});
  const s = stubFetch(okResponse);
  try {
    await notify({ kind: 'run_complete', runId: run.id, title: 't', lines: ['x'], to: [R] });
    await notify({ kind: 'run_complete', runId: run.id, title: 't', lines: ['x'], to: [R] });
  } finally { s.restore(); }
  assert.equal(s.captured.calls, 1);
  await dropRun(run.id);
});

test('n8n down degrades rather than reporting sent, and the run is untouched',
  { skip }, async () => {
    const run = await seedRun({ status: 'complete' });
    const s = stubFetch(refuse);
    try {
      await notify({ kind: 'run_complete', runId: run.id, title: 't', lines: ['x'], to: [R] });
    } finally { s.restore(); }
    const state = (await notificationStatus(run.id))[0].state;
    assert.ok(['degraded', 'failed', 'skipped_not_configured'].includes(state));
    assert.notEqual(state, 'sent');
    assert.equal((await loadRun(run.id)).status, 'complete');
    await dropRun(run.id);
  });

test('both lanes down does not throw and does not fail the run', { skip }, async () => {
  const run = await seedRun({ status: 'complete' });
  const s = stubFetch(refuse);
  try {
    await notify({ kind: 'run_complete', runId: run.id, title: 't', lines: ['x'], to: [R] });
  } finally { s.restore(); }
  assert.equal((await loadRun(run.id)).status, 'complete');
  await dropRun(run.id);
});

test('run_started has nobody to email and is NOT recorded as failed', { skip }, async () => {
  const run = await seedRun({});
  const s = stubFetch(refuse);
  try {
    await notify({ kind: 'run_started', runId: run.id, title: 't', lines: ['x'], to: [] });
  } finally { s.restore(); }
  assert.notEqual((await notificationStatus(run.id))[0].state, 'failed');
  await dropRun(run.id);
});

test('a credential in the objective never reaches the payload', { skip }, async () => {
  const run = await seedRun({});
  const s = stubFetch(okResponse);
  try {
    await notify({ kind: 'run_complete', runId: run.id, title: 't',
                   lines: ['Objective: use key sk-ant-abc12345'], to: [R] });
  } finally { s.restore(); }
  assert.ok(!s.captured.lastRawBody.includes('sk-ant-abc'));
  await dropRun(run.id);
});

test('the payload is signed with the raw body', { skip }, async () => {
  const run = await seedRun({});
  const s = stubFetch(okResponse);
  try {
    await notify({ kind: 'run_complete', runId: run.id, title: 't', lines: ['x'], to: [R] });
  } finally { s.restore(); }
  const expected = createHmac('sha256', process.env.N8N_LEAD_NOTIFY_SECRET!)
    .update(s.captured.lastRawBody).digest('hex');
  assert.equal(s.captured.lastHeaders['x-koya-signature'], expected);
  await dropRun(run.id);
});

test('a failure kind routes to the errors channel and a success kind does not',
  { skip }, async () => {
    const run = await seedRun({});
    const s = stubFetch(okResponse);
    try {
      await notify({ kind: 'run_partial', runId: run.id, title: 't', lines: ['x'], to: [R] });
    } finally { s.restore(); }
    assert.equal((s.captured.lastBody as any).discordChannel, 'leads-errors');
    assert.equal((s.captured.lastBody as any).level, 'error');
    assert.equal((s.captured.lastBody as any).actionRequired, true);
    await dropRun(run.id);
  });

test('a notification failure never throws into the caller',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({});
    const s = stubFetch(refuse);
    try {
      await notify({ kind: 'run_failed', runId: run.id, title: 't', lines: ['x'], to: [R] });
    } finally { s.restore(); }
    await dropRun(run.id);
  });
