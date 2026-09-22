import { query as agentQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { query } from '../db.ts';
import { loadRun, transition, runStats, type RunRow, type RunStatus } from '../runs.ts';
import { recordSpend } from '../budget.ts';
import { leadgenServer } from './server.ts';
import { budgetHook } from './hooks.ts';
import { buildSystemPrompt } from './prompt.ts';

/** The agent's working directory holds `.claude/skills/` and nothing else.
 *  No secret file lives under it, which is what makes `Read` safe to allow. */
export const WORKSPACE = fileURLToPath(new URL('../../agent-workspace/', import.meta.url));

export const SKILLS = ['icp-refinement', 'lead-qualification', 'outbound-copywriting',
                       'lead-list-quality', 'outreach-safety'];

export function agentOptions(run: RunRow): Options {
  return {
    model: config.models.agent,                       // Sonnet 5: judgment inside a frame
    cwd: WORKSPACE,
    settingSources: ['project'],
    skills: SKILLS,
    mcpServers: { leadgen: leadgenServer },
    allowedTools: ['mcp__leadgen__*', 'Skill'],
    // Availability, not permission: everything not listed here is gone from
    // the agent's context entirely rather than merely refused when called.
    tools: ['Skill', 'Read'],
    disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit',
                      'Task', 'Read(**/.env*)', 'Read(**/*.pem)'],
    permissionMode: 'default',
    maxTurns: config.limits.maxTurns,                 // backstop
    maxBudgetUsd: config.limits.maxBudgetUsd,         // backstop
    hooks: { PreToolUse: [{ hooks: [budgetHook] }] },
    systemPrompt: buildSystemPrompt(run),
  };
}

export type AgentOutcome = {
  subtype: string;
  costUsd: number;
  turns: number;
  skillsLoaded: string[];
};

/**
 * Runs the agent and records what it cost.
 *
 * Two things here are load bearing. The init message is checked for all five
 * skills, because a skill that did not load is a rule that is not in force.
 * And the result subtype is branched on, because hitting a cap is not success
 * and must never be reported as one.
 */
export async function runAgent(runId: string): Promise<AgentOutcome> {
  const run = await loadRun(runId);
  const options = agentOptions(run);

  let turns = 0;
  let costUsd = 0;
  let subtype = 'unknown';
  let skillsLoaded: string[] = [];

  for await (const message of agentQuery({
    prompt: 'Begin this run. Start by refining the objective into an ICP.',
    options,
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      skillsLoaded = ((message as any).skills ?? []).map(String);
      const missing = SKILLS.filter((s) => !skillsLoaded.some((l) => l.includes(s)));
      if (missing.length) {
        throw new Error(
          `The agent started without these skills: ${missing.join(', ')}. ` +
          'Those skills carry the qualification criteria and the safety rules, so the run ' +
          'is not trustworthy without them.',
        );
      }
    }

    if (message.type === 'assistant') turns++;

    if (message.type === 'result') {
      subtype = message.subtype;
      // total_cost_usd is subagent-inclusive, unlike usage. It is also a
      // client-side estimate, and the UI says so.
      costUsd = (message as any).total_cost_usd ?? 0;
    }
  }

  await query('update public.runs set agent_turns = $2 where id = $1', [runId, turns]);
  // recordSpend refreshes runs.claude_cost_usd from the ledger, so the cost is
  // written in exactly one place rather than incremented here as well.
  if (costUsd > 0) await recordSpend(runId, 'claude', costUsd, 'agent loop');

  const WORKING: RunStatus[] =
    ['queued', 'refining_icp', 'discovering', 'researching', 'drafting'];

  // A cap is never reported as success. The run ends partial naming the cap,
  // with everything produced so far preserved.
  if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd') {
    await transition(runId, WORKING, 'partial', undefined, {
      shortfall_reason: subtype === 'error_max_turns'
        ? `The agent reached its turn cap of ${config.limits.maxTurns} before finishing.`
        : `The agent reached its spend cap of $${config.limits.maxBudgetUsd}.`,
      finished_at: new Date(),
    });
  } else if (subtype !== 'success') {
    /**
     * Partial results are never discarded.
     *
     * An overload or a mid-flight error after seven good leads is a short run,
     * not a failed one. `failed` means the run produced nothing usable, and
     * reporting it that way would hide work a reviewer can still act on.
     */
    const stats = await runStats(runId);
    const produced = stats.assessed > 0;
    await transition(runId, WORKING, produced ? 'partial' : 'failed', undefined, {
      ...(produced
        ? { shortfall_reason:
              `The agent stopped early (${subtype}) after assessing ${stats.assessed} ` +
              `companies. The leads below are what it had finished.` }
        : { error_message: `Agent ended with ${subtype} before producing anything usable.` }),
      finished_at: new Date(),
    });
  }

  return { subtype, costUsd, turns, skillsLoaded };
}
