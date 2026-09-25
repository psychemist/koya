import { readFileSync } from 'node:fs';
import { query, one } from './db.ts';
import { config } from './config.ts';
import { ProviderError } from './errors.ts';
import { anthropic, messageCostUsd, extractJson } from './providers/claude.ts';
import { runCopyGates, isBlocked, blockingReasons, COPY_LIMITS } from './gates/copy.ts';
import { claudeSpentToday, dailyClaudeRefusalFor, recordSpend } from './budget.ts';

/**
 * Write the outreach for one qualified lead, on request.
 *
 * `save_outreach` blocks a lead after two rejected attempts, and a lead a
 * reviewer promoted after the run has no drafts at all. Either way the page
 * said "copy needs writing by hand" and offered no way to ask for another
 * attempt, so the only route back was re-running the whole agent for a company
 * that was already qualified and already researched.
 *
 * The generator is injected for the same reason the Firecrawl fetcher is: a
 * provider you cannot substitute is one your tests either skip or quietly pay
 * for. That was the most expensive lesson of the first pass.
 */
export type GeneratedDraft = {
  step: number;
  subject?: string;
  body: string;
  personalization_note: string;
  source_url?: string;
};

export type Generator = (input: {
  company: string; domain: string; evidence: string;
  fitReasons: string[]; sourceUrls: string[]; guidance: string;
  previousFailure?: string;
}) => Promise<{ steps: GeneratedDraft[]; costUsd: number }>;

/** One redraft costs a single message, not a run. Reserving a whole run's
 *  ceiling against the daily cap would refuse it on a day with room left. */
const ESTIMATE_USD = 0.05;

/** Two attempts, matching `save_outreach`. A third is a person's job. */
const ATTEMPTS = 2;

/** The same file the agent reads, so the standard is one document rather than
 *  a copy of one that drifts. */
function copyGuidance(): string {
  try {
    return readFileSync(new URL(
      '../agent-workspace/.claude/skills/outbound-copywriting/SKILL.md',
      import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

/**
 * What the drafting model is told, separated so it can be asserted on.
 *
 * The gates are the standard and they are not negotiable, so the limits they
 * enforce are stated here rather than left to be discovered by rejection.
 */
export function draftingSystemPrompt(guidance: string, previousFailure?: string): string {
  return `${guidance}\n\n` +
    'Write a 3 step email sequence and one LinkedIn message for the company below. ' +
    'Ground every claim in the supplied evidence and nothing else.\n\n' +
    'HARD LIMITS, checked in code and rejected if missed:\n' +
    `- Email body: ${COPY_LIMITS.emailBodyWords} words maximum. Count them.\n` +
    `- Email subject: ${COPY_LIMITS.subjectChars} characters maximum.\n` +
    `- LinkedIn message: ${COPY_LIMITS.linkedInChars} characters maximum.\n` +
    '- No em dash and no double hyphen anywhere.\n' +
    '- No email address, no urgency language, and nothing implying a message will be sent.\n\n' +
    'Return JSON only, as {"steps":[{"step":0|1|2|3,"subject":"emails only","body":"...",' +
    '"personalization_note":"which detail this uses","source_url":"..."}]}. ' +
    'Step 0 is the LinkedIn message; 1, 2 and 3 are the emails in order.' +
    (previousFailure
      ? `\n\nA previous attempt was rejected: ${previousFailure}. Fix exactly that and ` +
        'change nothing else.'
      : '');
}

const liveGenerator: Generator = async (input) => {
  const model = config.models.agent;
  const msg = await anthropic().messages.create({
    model,
    /**
     * `max_tokens` is a backstop, not a tuning knob: hitting it truncates
     * mid-thought and the whole response is wasted. A live attempt on
     * 2026-09-25 stopped at 4,000 with 3,323 of them spent thinking, leaving
     * the JSON cut off halfway through the second draft. Twice.
     */
    max_tokens: 16_000,
    /**
     * This is constrained writing against supplied evidence, not reasoning.
     * Deep thinking here buys nothing and was crowding out the answer.
     */
    output_config: { effort: 'low' },
    system: draftingSystemPrompt(input.guidance, input.previousFailure),
    messages: [{
      role: 'user',
      content:
        `Company: ${input.company} (${input.domain})\n` +
        `Why it qualified: ${input.fitReasons.join('; ')}\n` +
        `Sources: ${input.sourceUrls.join(', ')}\n\n` +
        `Evidence:\n${input.evidence}`,
    }],
  });

  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const parsed = extractJson<{ steps?: GeneratedDraft[] }>(text);
  return {
    steps: Array.isArray(parsed?.steps) ? parsed!.steps : [],
    costUsd: messageCostUsd(model, msg.usage),
  };
};

export async function draftForLead(
  leadId: string,
  opts: { generate?: Generator; attempts?: number } = {},
): Promise<{ saved: number; costUsd: number }> {
  const lead = await one<{
    id: string; run_id: string; company_name: string; company_domain: string;
    qualification_status: string; fit_reasons: string[]; source_urls: string[];
    source_summary: string | null;
  }>(
    `select id, run_id, company_name, company_domain, qualification_status,
            fit_reasons, source_urls, source_summary
       from public.leads where id = $1`,
    [leadId],
  );
  if (!lead) throw new ProviderError('DRAFT_NO_LEAD', 'No such lead.');

  // Copy for a company nobody qualified is how a rejected company reaches a
  // reviewer looking ready to send.
  if (lead.qualification_status !== 'qualified') {
    throw new ProviderError('DRAFT_NOT_QUALIFIED',
      `${lead.company_name} is ${lead.qualification_status.replace(/_/g, ' ')}. ` +
      'Only a qualified lead gets outreach. Accept it first if you disagree with the verdict.');
  }

  /**
   * Screened summaries only. NEVER raw_text.
   *
   * The quarantine is the whole injection defence: the model that reads raw
   * page text holds no tools, and the model that writes holds no raw page
   * text. An earlier version of this function fell back to `raw_text` when a
   * summary was missing, which would have handed unscreened third-party text
   * straight to the drafting model. The `injection_flagged = false` filter is
   * not a substitute, because an unflagged page is merely one the screen did
   * not object to, not one the agent is allowed to read directly.
   */
  const pages = await query<{ screened_summary: string | null }>(
    `select screened_summary from public.scraped_pages
      where run_id = $1 and company_domain = $2
        and injection_flagged = false and screened_summary is not null`,
    [lead.run_id, lead.company_domain],
  );
  const evidence = [
    ...pages.map((p) => p.screened_summary ?? ''),
    lead.source_summary ?? '',
  ].filter(Boolean).join('\n\n');

  if (!evidence.trim()) {
    throw new ProviderError('DRAFT_NO_EVIDENCE',
      `Nothing was stored about ${lead.company_name} that a draft could be grounded in, ` +
      'so any copy written now would be invented. Research it first.');
  }

  const spent = await claudeSpentToday();
  const refusal = dailyClaudeRefusalFor(spent, ESTIMATE_USD);
  if (refusal) throw new ProviderError('BUDGET_DAY', refusal);

  const generate = opts.generate ?? liveGenerator;
  const guidance = copyGuidance();
  const maxAttempts = opts.attempts ?? ATTEMPTS;

  let costUsd = 0;
  let lastFailure = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await generate({
      company: lead.company_name, domain: lead.company_domain, evidence,
      fitReasons: lead.fit_reasons ?? [], sourceUrls: lead.source_urls ?? [],
      guidance, previousFailure: lastFailure || undefined,
    });
    costUsd += out.costUsd ?? 0;

    if (!out.steps.length) { lastFailure = 'the model returned no drafts'; continue; }

    // Gated exactly as `save_outreach` gates them. A second path to the same
    // table with a weaker standard is how the standard stops meaning anything.
    const gated = out.steps.map((d) => ({ draft: d, results: runCopyGates(d, evidence) }));
    const failed = gated.filter((g) => isBlocked(g.results));

    if (failed.length) {
      lastFailure = failed
        .map((g) => `step ${g.draft.step}: ${blockingReasons(g.results).join('; ')}`)
        .join(' | ');
      continue;
    }

    // Replace rather than append: a redraft supersedes what was there, and a
    // reviewer opening the lead should not have to work out which is current.
    await query('delete from public.outreach_drafts where lead_id = $1', [leadId]);
    for (const { draft, results } of gated) {
      await query(
        `insert into public.outreach_drafts
           (lead_id, step, subject, body, personalization_note, source_url, gate_results)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [leadId, draft.step, draft.subject ?? null, draft.body,
         draft.personalization_note ?? '', draft.source_url ?? null,
         JSON.stringify(results)],
      );
    }
    await query('update public.leads set drafts_blocked = null where id = $1', [leadId]);
    if (costUsd > 0) {
      await recordSpend(lead.run_id, 'claude', costUsd,
        `redraft on request for ${lead.company_domain}`);
    }
    return { saved: gated.length, costUsd };
  }

  // Blocked again, and the reason is kept so the next reader knows which gate
  // to argue with rather than only that something failed.
  const reason = `Rejected after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}. ` +
    `${lastFailure}. Write this one by hand.`;
  await query('update public.leads set drafts_blocked = $2 where id = $1', [leadId, reason]);
  if (costUsd > 0) {
    await recordSpend(lead.run_id, 'claude', costUsd,
      `redraft on request for ${lead.company_domain}, rejected`);
  }
  throw new ProviderError('DRAFT_GATES_FAILED', reason);
}
