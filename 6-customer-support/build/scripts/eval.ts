import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.ts';
import { query, pool } from '../lib/db.ts';
import { SCENARIOS } from '../evals/scenarios.ts';
import { grade, verdict } from '../evals/grade.ts';
import { loadRecords, runLevelLogging } from '../evals/records.ts';
import { runScenario, type Reply } from '../evals/run.ts';

/**
 * Runs the scenarios through the real agent service (/chat, channel eval),
 * grades each from the rows it wrote, and stores one evaluations row per
 * scenario plus the run-level logging row.
 *
 *   npm run eval -- [--model claude-sonnet-5] [--scenario brief-1-grounded] [--local] [--agent https://...]
 *
 * --local adds rows 22 to 24, which need ALLOW_FAULT_INJECTION=true on both
 * the agent and the MCP server; never run it against production.
 */
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const model = arg('model') ?? config.models.agent;
const only = arg('scenario');
const local = process.argv.includes('--local');
const agent = (arg('agent') ?? config.web.agentUrl).replace(/\/$/, '');
const token = config.agent.internalToken;
if (!(config.models.allowed as readonly string[]).includes(model)) { console.error(`--model must be one of ${config.models.allowed.join(', ')}`); process.exit(1); }

const post = async (path: string, body: Record<string, unknown>): Promise<Reply> => {
  const res = await fetch(`${agent}${path}`, { method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

// A run graded against the wrong vectors measures nothing (2026-10-02). Refuse to start unless the live KB
// was embedded by the model the MCP server queries with.
const kb = await query<{ embedding_model: string; n: string }>('select embedding_model, count(*) n from public.kb_chunks where retired_at is null group by 1');
const want = process.env.EMBEDDINGS === 'fixture' ? 'fixture' : config.kb.voyageModel;
if (kb.length !== 1 || kb[0].embedding_model !== want) {
  console.error(`The knowledge base holds ${kb.map((k) => `${k.n} ${k.embedding_model}`).join(', ') || 'no'} vectors; expected only ${want}. Run npm run kb:ingest first.`);
  process.exit(1);
}

const runId = randomUUID();
const picked = SCENARIOS.filter((s) => (!s.localOnly || local) && (!only || s.key === only));
console.log(`eval run ${runId}: ${picked.length} scenarios on ${model} against ${agent}${local ? ' (local, faults on)' : ''}\n`);
const results: { row: number; key: string; passed: boolean }[] = [];
const conversations: string[] = [];
for (const s of picked) {
  const t0 = Date.now();
  const r = await runScenario(s, runId, model, post);
  let passed = false, actual = '', notes = r.error ?? '', cost: number | null = null, p50: number | null = null, p95: number | null = null;
  if (r.conversationId) {
    conversations.push(r.conversationId);
    const rec = await loadRecords(r.conversationId);
    const g = grade(s, rec);
    passed = g.passed && !r.error; actual = g.actual; notes = [r.error, g.notes].filter(Boolean).join('; ');
    cost = Number(rec.conversation?.cost_usd ?? 0);
    const lat = rec.turns.map((t) => t.latency_ms).filter((x): x is number => x != null);
    p50 = pct(lat, 50); p95 = pct(lat, 95);
  }
  await query(`insert into public.evaluations (eval_run_id, scenario_key, scenario_title, expected_behavior, actual_behavior, passed, notes, source,
      conversation_id, model, cost_usd, latency_p50_ms, latency_p95_ms)
    values ($1,$2,$3,$4,$5,$6,$7,'automated',$8,$9,$10,$11,$12)`,
    [runId, s.key, `Row ${s.row}: ${s.title}`, s.expected, actual || '(no turns recorded)', passed, notes || null, r.conversationId, model, cost, p50, p95]);
  results.push({ row: s.row, key: s.key, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  row ${String(s.row).padStart(2)}  ${s.key.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  $${(cost ?? 0).toFixed(4)}${passed ? '' : `\n      ${notes}`}`);
}
if (!only && conversations.length) {
  const l = await runLevelLogging(runId, conversations);
  await query(`insert into public.evaluations (eval_run_id, scenario_key, scenario_title, expected_behavior, actual_behavior, passed, notes, source, model)
    values ($1,'run-10-logging','Row 10: Logging','Every table the PRD lists has rows linked to this run''s conversations.',$2,$3,$4,'automated',$5)`,
    [runId, l.actual, l.passed, l.notes || null, model]);
  console.log(`${l.passed ? 'PASS' : 'FAIL'}  row 10  run-10-logging                ${l.actual}`);
  results.push({ row: 10, key: 'run-10-logging', passed: l.passed });
}
const passedCount = results.filter((r) => r.passed).length;
console.log(`\n${passedCount} of ${results.length} passed. Run ${runId}.`);
if (!only) console.log(verdict(results, model));
await pool().end();
