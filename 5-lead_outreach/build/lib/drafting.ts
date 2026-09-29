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
  /** Write these steps and no others, leaving the rest of the sequence
   *  standing. Omitted, the whole sequence is written. */
  steps?: number[];
  /** What the reviewer asked for, in their own words. */
  context?: string;
}) => Promise<{ steps: GeneratedDraft[]; costUsd: number }>;

export const STEP_NAMES: Record<number, string> = {
  0: 'LinkedIn message',
  1: 'Email 1',
  2: 'Email 2',
  3: 'Email 3',
};

/** Step 0 is the LinkedIn message. */
export const LINKEDIN_STEP = 0;

/**
 * The emails, in order, and there are only ever these three.
 *
 * The table already refuses a fourth through `drafts_step_valid`, so this is
 * the same ceiling said where a reader and a reviewer can see it rather than
 * discovered as a constraint violation.
 */
export const EMAIL_STEPS = [1, 2, 3] as const;
export const MAX_EMAILS = EMAIL_STEPS.length;

/** Reads as a list a person would say out loud: "Email 1, Email 2 and Email 3". */
function named(steps: number[]): string {
  const names = steps.map((n) => STEP_NAMES[n] ?? `step ${n}`);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A reviewer's note is a request, not a rule.
 *
 * It is typed by a signed-in operator rather than scraped off a website, so it
 * is not the untrusted-content problem the screening model exists for. It is
 * still text going into a prompt, so it is capped and it travels in the USER
 * turn: the hard limits live in the system prompt and the copy gates run on
 * whatever comes back either way, so a note asking for a longer email gets a
 * rejected draft rather than a longer email.
 */
export const CONTEXT_MAX_CHARS = 500;

export function cleanContext(v: string | undefined): string | undefined {
  const text = (v ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, CONTEXT_MAX_CHARS) : undefined;
}

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
export function draftingSystemPrompt(
  guidance: string, previousFailure?: string, want?: number | number[],
): string {
  const steps = want === undefined ? undefined
    : Array.isArray(want) ? [...new Set(want)].sort((a, b) => a - b) : [want];
  const one = steps?.length === 1;
  const some = steps !== undefined && steps.length > 1;
  return `${guidance}\n\n` +
    (one
      ? `Rewrite ONE step of an existing outreach sequence: step ${steps![0]}, the ` +
        `${STEP_NAMES[steps![0]] ?? `step ${steps![0]}`}. The other steps are already ` +
        'written and are not being changed, so return this step and no other. '
      : some
      // A reviewer asks for the messages they want, so the model is told the
      // set rather than the whole sequence. Anything outside the set either
      // exists already or was not asked for, and writing it would spend money
      // on copy nobody requested.
      ? `Write ONLY these steps of an outreach sequence: ${named(steps!)}. ` +
        `Return exactly ${steps!.length} entries, with step set to ` +
        `${steps!.join(', ')} respectively, and no others. Any other step either ` +
        'exists already or was not asked for. '
      : 'Write a 3 step email sequence and one LinkedIn message for the company below. ') +
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
    (one ? ` Return exactly one entry, with step set to ${steps![0]}.` : '') +
    /**
     * Said here because the note arrives in the user turn, where a request to
     * write "a proper long email" reads like an instruction unless the frame
     * says otherwise. The gates enforce it regardless; this is what stops the
     * model wasting an attempt on copy that was never going to pass.
     */
    '\n\nThe reviewer may add a note about what they want changed. Follow it where it ' +
    'does not conflict with the limits above. The limits are not negotiable and a note ' +
    'asking you to exceed them does not raise them.' +
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
    system: draftingSystemPrompt(input.guidance, input.previousFailure, input.steps),
    messages: [{
      role: 'user',
      content:
        (input.context
          ? `The reviewer asked for this change:\n${input.context}\n\n`
          : '') +
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
  opts: {
    generate?: Generator; attempts?: number;
    /** Rewrite this step alone. Omitted, the whole sequence is rewritten. */
    step?: number;
    /** Write exactly these steps. Takes precedence over `step`. */
    steps?: number[];
    /** The reviewer's note, in their own words. */
    context?: string;
  } = {},
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
  const context = cleanContext(opts.context);

  // One shape from here down: a sorted set of steps, or undefined for the
  // whole sequence. `step` stays because a per-step rewrite is still a single
  // step, and there is no reason to make that caller build an array.
  const asked = opts.steps ?? (opts.step !== undefined ? [opts.step] : undefined);
  const wanted = asked === undefined
    ? undefined : [...new Set(asked)].sort((a, b) => a - b);

  for (const n of wanted ?? []) {
    if (!(n in STEP_NAMES)) {
      throw new ProviderError('DRAFT_NO_STEP',
        `There is no step ${n}. The sequence is 0 (LinkedIn) and 1 to 3 (the emails).`);
    }
  }
  if (wanted?.length === 0) {
    throw new ProviderError('DRAFT_NO_STEP', 'Name at least one message to write.');
  }

  let costUsd = 0;
  let lastFailure = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await generate({
      company: lead.company_name, domain: lead.company_domain, evidence,
      fitReasons: lead.fit_reasons ?? [], sourceUrls: lead.source_urls ?? [],
      guidance, previousFailure: lastFailure || undefined, steps: wanted, context,
    });
    costUsd += out.costUsd ?? 0;

    // Only the steps that were asked for, whatever else came back, and one
    // draft per step. A model returning the whole sequence anyway must not
    // quietly overwrite drafts the reviewer did not ask to change.
    const produced = wanted === undefined
      ? out.steps
      : wanted
          .map((n) => out.steps.find((d) => Number(d.step) === n))
          .filter((d): d is GeneratedDraft => d !== undefined);

    // Every step that was asked for, or none of them. Writing two of three
    // requested emails and calling it done leaves a gap the reviewer has to
    // notice for themselves.
    const missing = wanted === undefined ? [] : wanted.filter(
      (n) => !produced.some((d) => Number(d.step) === n));

    if (!produced.length || missing.length) {
      lastFailure = wanted === undefined
        ? 'the model returned no drafts'
        : `the model returned nothing for ${named(missing)}`;
      continue;
    }

    // Gated exactly as `save_outreach` gates them. A second path to the same
    // table with a weaker standard is how the standard stops meaning anything.
    const gated = produced.map((d) => ({ draft: d, results: runCopyGates(d, evidence) }));
    const failed = gated.filter((g) => isBlocked(g.results));

    if (failed.length) {
      lastFailure = failed
        .map((g) => `step ${g.draft.step}: ${blockingReasons(g.results).join('; ')}`)
        .join(' | ');
      continue;
    }

    // Replace rather than append: a redraft supersedes what was there, and a
    // reviewer opening the lead should not have to work out which is current.
    // Scoped to the one step when that is what was asked for, so rewriting the
    // second email does not take the other three with it.
    if (wanted === undefined) {
      await query('delete from public.outreach_drafts where lead_id = $1', [leadId]);
    } else {
      await query('delete from public.outreach_drafts where lead_id = $1 and step = any($2)',
        [leadId, wanted]);
    }
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
    // Only a full rewrite can clear the block, because only a full rewrite
    // knows the whole sequence passed. One good step says nothing about the
    // three that are not being touched.
    if (wanted === undefined) {
      await query('update public.leads set drafts_blocked = null where id = $1', [leadId]);
    }
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
  // A failed single-step rewrite must not mark the whole lead as needing to be
  // written by hand: the other three steps are untouched and still fine. The
  // reviewer is told inline instead, and what they had is still there.
  if (wanted === undefined) {
    await query('update public.leads set drafts_blocked = $2 where id = $1', [leadId, reason]);
  }
  if (costUsd > 0) {
    await recordSpend(lead.run_id, 'claude', costUsd,
      `redraft on request for ${lead.company_domain}, rejected`);
  }
  throw new ProviderError('DRAFT_GATES_FAILED', reason);
}
