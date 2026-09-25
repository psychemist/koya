import { query as agentQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { query } from '../db.ts';
import { loadRun, transition, runStats, type RunRow, type RunStatus } from '../runs.ts';
import { recordSpend } from '../budget.ts';
import {
  capReached, agentCostFloorUsd, remainingRunBudgetUsd, tooLittleLeftToStart,
} from './caps.ts';
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
    model: config.models.agent,
    effort: config.models.effort,                       // Sonnet 5: judgment inside a frame
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
    // What is LEFT of this run's cap, not the whole cap. A reclaimed run has
    // already spent some of it, and handing over the full figure again is how
    // one run costs three times its ceiling. See remainingRunBudgetUsd.
    maxBudgetUsd: remainingRunBudgetUsd(run.claude_cost_usd),
    hooks: { PreToolUse: [{ hooks: [budgetHook] }] },
    systemPrompt: buildSystemPrompt(run),
  };
}

export type AgentOutcome = {
  subtype: string;
  costUsd: number;
  turns: number;
  skillsLoaded: string[];
  modelUsage: Record<string, unknown> | null;
};

/**
 * Sums `cache_read_input_tokens` across whatever shape the SDK reports usage
 * in. Zero means the frozen prefix was resent every turn, which is the
 * expensive failure this figure exists to catch.
 */
export function cacheReadTokens(modelUsage: unknown): number {
  if (!modelUsage || typeof modelUsage !== 'object') return 0;
  let total = 0;
  for (const entry of Object.values(modelUsage as Record<string, any>)) {
    const n = entry?.cache_read_input_tokens ?? entry?.cacheReadInputTokens;
    if (typeof n === 'number') total += n;
  }
  return total;
}

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

  /**
   * A reclaimed run that has already spent its cap stops here.
   *
   * Without this it would be invoked with an allowance of nothing, buy one
   * turn of thinking, and come back as a cap: money spent to produce a result
   * that reads in the record exactly like a genuine short run. Ending it
   * `partial` keeps everything the earlier attempts produced and says plainly
   * why there was no further attempt.
   */
  const remaining = remainingRunBudgetUsd(run.claude_cost_usd);
  if (tooLittleLeftToStart(remaining)) {
    const stats = await runStats(runId);
    await transition(runId,
      ['queued', 'refining_icp', 'discovering', 'researching', 'drafting'], 'partial', undefined, {
        shortfall_reason:
          `This run has already spent its $${config.limits.maxBudgetUsd} ceiling across ` +
          'earlier attempts, so it was not started again. ' +
          `It assessed ${stats.assessed} companies. Continue it to carry the criteria and ` +
          'the companies it never reached into a run with a fresh budget.',
        finished_at: new Date(),
      });
    return { subtype: 'error_max_budget_usd', costUsd: 0, turns: 0,
             skillsLoaded: [], modelUsage: null };
  }

  const options = agentOptions(run);

  let turns = 0;
  let costUsd = 0;
  let subtype = 'unknown';
  let skillsLoaded: string[] = [];
  let modelUsage: Record<string, unknown> | null = null;

  /**
   * The loop is wrapped because a cap arrives as a THROW, not only as a result
   * message. On 2026-09-25 the SDK raised "Reached maximum budget ($1.5)", the
   * exception escaped this loop, and every line below it was skipped: the cost
   * was never recorded, `model_usage` was never written, and a run holding 8
   * qualified leads was marked `failed` rather than `partial`.
   */
  let thrown: unknown = null;
  try {
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
      // modelUsage carries cache_read_input_tokens, which is the only evidence
      // that the cached prefix is working rather than merely intended.
      modelUsage = (message as any).modelUsage ?? null;
    }
  }
  } catch (e) {
    // Held, not rethrown yet. The accounting below has to happen first, and a
    // failure that is really a cap has to be reclassified before it is raised.
    thrown = e;
  }

  const thrownMessage = thrown instanceof Error ? thrown.message
    : thrown != null ? String(thrown) : undefined;
  const cap = capReached(subtype, thrownMessage);

  // A run stopped by the spend cap spent at least the cap. On the thrown path
  // no result message arrives, so the SDK's own figure never came back and
  // recording it unchanged books a $1.50 run at $0.00.
  const settledCostUsd = agentCostFloorUsd(costUsd, cap);

  await query('update public.runs set agent_turns = $2, model_usage = $3 where id = $1',
    [runId, turns, modelUsage ? JSON.stringify(modelUsage) : null]);
  // recordSpend refreshes runs.claude_cost_usd from the ledger, so the cost is
  // written in exactly one place rather than incremented here as well.
  if (settledCostUsd > 0) {
    await recordSpend(runId, 'claude', settledCostUsd,
      cap === 'error_max_budget_usd' && costUsd <= 0
        ? 'agent loop, stopped by the spend cap, priced at the cap'
        : 'agent loop');
  }
  costUsd = settledCostUsd;

  const WORKING: RunStatus[] =
    ['queued', 'refining_icp', 'discovering', 'researching', 'drafting'];

  // A cap is never reported as success. The run ends partial naming the cap,
  // with everything produced so far preserved.
  if (cap) {
    await transition(runId, WORKING, 'partial', undefined, {
      shortfall_reason: cap === 'error_max_turns'
        ? `The agent reached its turn cap of ${config.limits.maxTurns} before finishing.`
        : `The agent reached its spend cap of $${config.limits.maxBudgetUsd}.`,
      finished_at: new Date(),
    });
    subtype = cap;
  } else if (thrown) {
    // Not a cap, so it is a real failure. Raised only now that the cost and
    // the usage are on record, which is what the worker's catch then reports.
    throw thrown;
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

  return { subtype, costUsd, turns, skillsLoaded, modelUsage };
}
