import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { loadRun, isTerminal } from '../runs.ts';
import { query } from '../db.ts';

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
  if (input.tool_name === 'mcp__leadgen__discover_companies' &&
      run.candidates_used >= run.candidate_budget) {
    return logDenial(runId, input.tool_name,
      'Candidate budget exhausted. Work with what you have.');
  }
  if (input.tool_name === 'mcp__leadgen__scrape_company_site' &&
      run.scrapes_used >= run.scrape_budget) {
    return logDenial(runId, input.tool_name, 'Scrape budget exhausted.');
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
