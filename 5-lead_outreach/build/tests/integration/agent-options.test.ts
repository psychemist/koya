import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentOptions, SKILLS } from '../../lib/agent/run-agent.ts';
import { budgetHook } from '../../lib/agent/hooks.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';
import type { RunRow } from '../../lib/runs.ts';

const fakeRun = {
  id: '00000000-0000-0000-0000-000000000000',
  objective: 'Find 10 US B2B SaaS companies',
  target_leads: 10,
} as RunRow;

test('dangerous built-ins are not available at all', () => {
  const o = agentOptions(fakeRun);
  assert.deepEqual(o.tools, ['Skill', 'Read']);
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'Task'])
    assert.ok(o.disallowedTools!.includes(t), `${t} still reachable`);
  assert.ok(o.disallowedTools!.some((r) => r.includes('.env')));
});

test('caps are set and are not the primary control', () => {
  const o = agentOptions(fakeRun);
  assert.equal(o.maxTurns, 60);
  assert.equal(o.maxBudgetUsd, 1.5);
  assert.equal(o.model, 'claude-sonnet-5');
});

test('only the five project skills are enabled', () => {
  assert.deepEqual(agentOptions(fakeRun).skills, [
    'icp-refinement', 'lead-qualification', 'outbound-copywriting',
    'lead-list-quality', 'outreach-safety']);
  assert.equal(SKILLS.length, 5);
});

test('the agent workspace is the cwd, so no secret file is readable from it', () => {
  const o = agentOptions(fakeRun);
  assert.match(o.cwd as string, /agent-workspace\/$/);
  assert.deepEqual(o.settingSources, ['project']);
});

test('the system prompt states the run id and never carries a credential', () => {
  const p = agentOptions(fakeRun).systemPrompt as string;
  assert.ok(p.includes(fakeRun.id));
  assert.ok(!/sk-ant-|apify_api_|fc-|postgresql:\/\//.test(p));
});

test('the PreToolUse hook denies a write tool on a terminal run',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'complete' });
    const d = await budgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__leadgen__save_lead',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(d.hookSpecificOutput?.permissionDecision, 'deny');
    await dropRun(run.id);
  });

test('the hook still lets the agent read its own state on a terminal run',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'partial' });
    const d = await budgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__leadgen__get_run_state',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(d.hookSpecificOutput, undefined);
    await dropRun(run.id);
  });

test('the hook denies every spending tool while a run is parked on a question',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({
      status: 'refining_icp',
      needs_clarification: 'Which country should I search in?',
    } as any);
    for (const tool of ['mcp__leadgen__discover_companies',
                        'mcp__leadgen__scrape_company_site']) {
      const d = await budgetHook({
        hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { run_id: run.id },
      } as any);
      assert.equal(d.hookSpecificOutput?.permissionDecision, 'deny', `${tool} was allowed`);
      assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /waiting on an answer/i);
    }
    // Reading state is still allowed, or the agent cannot find its way out.
    const readOnly = await budgetHook({
      hook_event_name: 'PreToolUse', tool_name: 'mcp__leadgen__get_run_state',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(readOnly.hookSpecificOutput, undefined);
    await dropRun(run.id);
  });

test('the hook denies discovery until an ICP has been saved',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'refining_icp' });
    const d = await budgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__leadgen__discover_companies',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(d.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /save_icp/);
    await dropRun(run.id);
  });

test('the hook denies discovery once the candidate budget is spent',
  { skip: skipWithoutDatabase }, async () => {
    // An ICP is saved here so the budget refusal is what is under test rather
    // than the earlier refusal for a run that has not refined its criteria.
    const run = await seedRun({
      candidate_budget: 5, candidates_used: 5,
      icp: JSON.stringify({ hard_filters: ['United States'] }),
    } as any);
    const d = await budgetHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__leadgen__discover_companies',
      tool_input: { run_id: run.id },
    } as any);
    assert.equal(d.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /budget/i);
    await dropRun(run.id);
  });
