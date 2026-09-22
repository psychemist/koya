import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { loadRun, isTerminal } from '../runs.ts';
import { query } from '../db.ts';
import { apifySpend } from '../budget.ts';

/** The tools that cost money. Everything else is bookkeeping. */
const SPENDS = new Set([
  'mcp__leadgen__discover_companies',
  'mcp__leadgen__scrape_company_site',
]);

/** The SDK's HookJSONOutput is a union with an async variant that carries no
 *  decision. This is the half a PreToolUse hook actually returns. */
export type Decision = {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
};

const deny = (reason: string): Decision => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const allow: Decision = {};

const READ_ONLY = 'mcp__leadgen__get_run_state';

/**
 * Third line of defence, after the tool's own clamp and the database
 * constraint. It runs whether or not the tool behaved, which is the point of
 * having it: one implementation is a promise, three is a property.
 *
 * Every denial is also written to the tool-call log, so an attempt to exceed a
 * limit is visible in review rather than merely prevented.
 */
export async function budgetHook(input: HookInput): Promise<Decision> {
  if (input.hook_event_name !== 'PreToolUse') return allow;
  const runId = (input.tool_input as { run_id?: string } | null)?.run_id;
  if (!runId) return allow;

  const run = await loadRun(runId).catch(() => null);
  if (!run) return logDenial(runId, input.tool_name, 'Unknown run.');

  if (input.tool_name === READ_ONLY) return allow;

  if (isTerminal(run.status)) {
    return logDenial(runId, input.tool_name,
      `Run is ${run.status}. No further writes are accepted.`);
  }

  /**
   * A parked run is parked.
   *
   * `save_icp` tells the agent to stop, which is a request to a model and
   * therefore not a control. This is the control: while a run is waiting on a
   * person, nothing that costs money runs, whatever the agent decides next.
   */
  if (run.needs_clarification && SPENDS.has(input.tool_name)) {
    return logDenial(runId, input.tool_name,
      'This run is waiting on an answer from the operator. Nothing may be spent until ' +
      'that question is answered. Stop here.');
  }

  /**
   * The ICP is written before any paid call. That ordering is the first thing
   * the brief asks to see, and until now it lived only in the system prompt.
   */
  if (input.tool_name === 'mcp__leadgen__discover_companies' && run.icp === null) {
    return logDenial(runId, input.tool_name,
      'No ICP has been saved for this run. Refine the objective and call save_icp first: ' +
      'discovery costs money and a bad ICP spends it on the wrong companies.');
  }

  if (input.tool_name === 'mcp__leadgen__discover_companies' &&
      run.candidates_used >= run.candidate_budget) {
    return logDenial(runId, input.tool_name,
      'Candidate budget exhausted. Work with what you have.');
  }
  if (input.tool_name === 'mcp__leadgen__scrape_company_site' &&
      run.scrapes_used >= run.scrape_budget) {
    return logDenial(runId, input.tool_name, 'Scrape budget exhausted.');
  }

  // The dollar caps, re-checked here rather than only inside the reservation.
  // Three implementations is the point; two is a promise and a backstop.
  if (input.tool_name === 'mcp__leadgen__discover_companies') {
    const spent = await apifySpend(runId).catch(() => 0);
    if (spent >= Number(run.apify_cap_usd)) {
      return logDenial(runId, input.tool_name,
        `This run has spent $${spent.toFixed(4)} on discovery and its cap is ` +
        `$${Number(run.apify_cap_usd).toFixed(2)}.`);
    }
  }

  return allow;
}

async function logDenial(runId: string, toolName: string, reason: string) {
  await query(
    `insert into public.tool_calls (run_id, tool_name, purpose, status, error_code, error_message)
     values ($1,$2,'blocked by PreToolUse hook','denied','SCOPE_DENIED',$3)`,
    [runId, toolName, reason],
  ).catch(() => undefined);   // a hook that throws is a hook that stops the run
  return deny(reason);
}
