import { callClaude } from "../claude/client";
import { stableHash, canonicalJson } from "../hash";
import { query, queryOne } from "../db";
import { recordEvent } from "../audit";
import { neutraliseDelimiters } from "../sanitise";
import { checkStyle, type StyleFindingKind } from "../gates/style";
import { firstNameOf } from "./message";
import type { Intake } from "../proposal/intake";

/**
 * One generated sentence for the top of the client covering email.
 *
 * WHY ONLY A SENTENCE. The covering note is a template, and most of it should
 * stay one. It is an envelope rather than the artefact, spending Opus output
 * tokens on five lines a template gets right is spending the budget where
 * nobody looks, and determinism is what lets the style gate run over the text
 * at all — which is how two defects in it were found. What a template cannot
 * do is know anything about the deal, so a ten-week build and a one-day
 * workshop arrived under identical words. Generating the opener and nothing
 * else buys the part that was missing and keeps everything the template was
 * good for.
 *
 * WHY IT IS CACHED ON A HASH. Without it this is a model call on every send,
 * for a sentence that cannot have changed since the last one. The hash covers
 * exactly the fields the prompt is built from, so editing the intake produces
 * a new sentence and re-sending an untouched proposal produces no call. Same
 * mechanism as `content_hash` on a draft.
 *
 * WHY IT NEVER THROWS. The caller is the approval route. A model call that
 * times out must not stop a proposal being approved, and a missing opener is
 * invisible: the email falls back to the templated first line, which is the
 * one every proposal used until now and is perfectly serviceable.
 */

/** The templated opener, used whenever there is no generated one. */
export const FALLBACK_OPENER = "Here is the proposal, written around what you told us on the call.";

/**
 * The fields the sentence is built from, and therefore the fields that
 * invalidate it.
 *
 * Deliberately narrow. Including the whole intake would regenerate the
 * opener when the price changed, which the sentence never mentions, and the
 * point of the hash is to avoid calls that cannot change the answer.
 */
function openerInputs(intake: Intake): { client_name: string; company_name: string; client_needs_summary: string; goals_and_objectives: string } {
  return {
    client_name: intake.client_name ?? "",
    company_name: intake.company_name ?? "",
    client_needs_summary: intake.client_needs_summary ?? "",
    goals_and_objectives: intake.goals_and_objectives ?? "",
  };
}

export function openerHash(intake: Intake): string {
  return stableHash(canonicalJson(openerInputs(intake)));
}

const SYSTEM = `You write one sentence. Nothing else.

It is the opening line of a short email from a salesperson at Koya Talent to a client, attached to a proposal the client is about to read.

# What the sentence does

It shows the client that the proposal was written about their situation rather than assembled from a template. It does that by naming the problem they described, in their own terms, in one plain sentence.

# Hard constraints

- ONE sentence. Not two. No greeting, no sign-off, no preamble, no quotation marks.
- Under 30 words.
- Use ONLY what appears in the CLIENT NOTES below. You know nothing else about this client, this company or this work.
- Never state a price, a date, a duration, a team size, a percentage, a metric, or a named tool or vendor, even if the notes contain one. Those belong in the proposal, not in a covering line.
- Do not promise a result, and do not say the proposal will solve anything.
- Do not address the reader by name. The greeting is added separately.
- Write British English.

# Voice

Plain and specific. Write as a person who was on the call, not as a company.

Never use: an em dash, a rule of three, "we don't just X, we Y", "in today's landscape", "excited", "delighted", "journey", "seamless", "leverage", "unlock", "robust", "transform".

Do not open with "As we discussed", "Following our call", "Thank you for" or "I hope this finds you well". Start on the substance.

# Examples

CLIENT NOTES: Dispatch team rekeys delivery notes by hand into the order system and the finance system. Two people, most of the morning. Errors cost them credit notes.
GOOD: Your dispatch team is typing every delivery note twice, and the errors that get through are costing you credit notes.

CLIENT NOTES: Maintenance across 40 commercial sites tracked in spreadsheets. Nobody can say what is outstanding at a site without half an hour of digging. Compliance reporting done from memory.
GOOD: Nobody can answer what is outstanding at a site without half an hour in the spreadsheets, and the compliance reporting is running on memory.

Return the sentence and nothing else.`;

/**
 * Generates the sentence, or returns null.
 *
 * Null is a normal outcome, not a failure to report to the user: the caller
 * falls back to the templated opener.
 */
async function generate(args: {
  intake: Intake;
  proposalId: string;
  correlationId: string;
}): Promise<string | null> {
  const inputs = openerInputs(args.intake);
  if (inputs.client_needs_summary.trim().length < 40) {
    // Nothing to write from. A sentence generated out of two words of notes
    // would be padding, and padding in the first line is worse than the
    // template it replaced.
    return null;
  }

  /**
   * The notes are framed and neutralised like any other untrusted text.
   *
   * A salesperson types the intake, but they type it having read documents the
   * client sent, and text pasted out of one of those carries whatever was in
   * it. This sentence goes into an email to a client under the firm's name,
   * which makes it the highest-consequence short string in the system.
   */
  const notes = neutraliseDelimiters(
    [inputs.client_needs_summary, inputs.goals_and_objectives].filter(Boolean).join("\n\n"),
  );

  const result = await callClaude({
    purpose: "email_opener",
    correlationId: args.correlationId,
    proposalId: args.proposalId,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `CLIENT NOTES:\n${notes}\n\nThe sentence:` }],
  });

  const sentence = tidy(result.text);
  return sentence && isAcceptableOpener(sentence) ? sentence : null;
}

/** Strips the ways a model wraps a single sentence despite being told not to. */
function tidy(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^["'“”']+|["'“”']+$/g, "").trim();
  // A leading label, if one survived the instruction.
  text = text.replace(/^(GOOD|The sentence|Sentence|Opening line)\s*:\s*/i, "").trim();
  // First sentence only, whatever arrived.
  const firstStop = text.search(/[.!?](\s|$)/);
  if (firstStop !== -1) text = text.slice(0, firstStop + 1).trim();
  return text;
}

/**
 * Style findings that disqualify a generated opener.
 *
 * A SUBSET of what `checkStyle` reports, and the subset is the decision worth
 * explaining. In a proposal every finding is advisory, because blocking over
 * a word choice teaches people to waive without reading. Here there is no
 * waiving and nothing to block: a failed sentence is silently replaced by the
 * templated line, which is what every proposal used until now. Discarding
 * costs nothing, so the bar can be higher.
 *
 * The kinds left out are the ones that cannot be judged on one sentence.
 * `uniform_rhythm`, `repeated_opener` and `parallel_structure` all need
 * several sentences to mean anything, and `parataxis` reads a deliberate
 * two-clause opener as a fault. Including them would reject good sentences
 * for a shape the format requires.
 */
const DISQUALIFYING: readonly StyleFindingKind[] = [
  "em_dash",
  "banned_phrase",
  "intensifier",
  "performed_enthusiasm",
  "throat_clearing",
  "hedging",
  "nominalisation",
  "rule_of_three",
  "corrective_negation",
  "relative_time",
  "self_reference",
];

/**
 * The gate on the generated line.
 *
 * This is the one piece of model output in the system that can reach a client
 * without a person necessarily having read it: the salesperson may edit the
 * covering email and will not always. So it is checked against the project's
 * OWN style gate rather than a hand-written imitation of it — a second,
 * smaller copy of those rules would drift from the real ones, and the whole
 * argument of `house-text.test.ts` is that a rule applied to Claude applies
 * to the text this codebase writes itself.
 *
 * Anything failing is discarded in favour of the template rather than
 * repaired. A sentence is cheap to throw away; a repair loop is another model
 * call on the approval path.
 */
export function isAcceptableOpener(sentence: string): boolean {
  /**
   * The length ceiling matches what the prompt asks for.
   *
   * It did not: the prompt said "under 30 words" and this allowed 34, so a
   * sentence that had ignored the instruction still passed. A gate looser
   * than the instruction it enforces is not a gate. The sentences this
   * actually produces run 21 to 24 words, so 30 is headroom rather than a
   * squeeze.
   */
  if (sentence.length < 20 || sentence.length > 200) return false;
  if (sentence.split(/\s+/).length > 30) return false;

  // A price, a percentage or a date in the opening line means the model used a
  // figure it was told to leave to the proposal. Not a style rule, a grounding
  // one, so it is checked here rather than looked for in the findings.
  if (/[£$€]\s?\d|\d\s?%|\b\d{4}-\d{2}-\d{2}\b/.test(sentence)) return false;

  /**
   * Run through the real gate, as a one-section document.
   *
   * `introduction` is the closest section in register: opening prose, written
   * to the client, about their situation. The key only selects which
   * per-section rules apply; the vocabulary and rhythm checks are the same
   * either way.
   */
  const findings = checkStyle([{ key: "introduction", body: sentence }]);
  return !findings.some((f) => DISQUALIFYING.includes(f.kind));
}

/**
 * Ensures the proposal has a current opener, generating one only when the
 * inputs have changed since the last generation.
 *
 * Returns the sentence to use, which may be the fallback. Never throws.
 */
export async function ensureEmailOpener(args: {
  proposalId: string;
  intake: Intake;
  correlationId: string;
  actorId?: string | null;
}): Promise<string> {
  const wanted = openerHash(args.intake);

  try {
    const row = await queryOne<{ email_opener: string | null; email_opener_hash: string | null }>(
      "SELECT email_opener, email_opener_hash FROM proposals WHERE id = $1",
      [args.proposalId],
    );

    if (row?.email_opener && row.email_opener_hash === wanted) {
      return row.email_opener;
    }

    const sentence = await generate({
      intake: args.intake,
      proposalId: args.proposalId,
      correlationId: args.correlationId,
    });

    /**
     * The hash is stored even when nothing was generated.
     *
     * Otherwise an intake the model declines to write from is retried on every
     * approval for ever, paying each time to be refused again. Storing the
     * hash with a NULL sentence records that this exact input was tried.
     */
    await query(
      "UPDATE proposals SET email_opener = $2, email_opener_hash = $3 WHERE id = $1",
      [args.proposalId, sentence, wanted],
    );

    await recordEvent({
      correlationId: args.correlationId,
      action: "proposal.email_opener",
      outcome: sentence ? "ok" : "skipped",
      actorId: args.actorId ?? null,
      proposalId: args.proposalId,
      detail: sentence
        ? { words: sentence.split(/\s+/).length }
        : { reason: "nothing usable was produced; the templated opener is used" },
    });

    return sentence ?? FALLBACK_OPENER;
  } catch (err) {
    // See the module note: this must never stop an approval.
    await recordEvent({
      correlationId: args.correlationId,
      action: "proposal.email_opener",
      outcome: "error",
      actorId: args.actorId ?? null,
      proposalId: args.proposalId,
      errorCode: "AI_CALL_FAILED",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    return FALLBACK_OPENER;
  }
}

/** The stored sentence, or the fallback. Reads only; never generates. */
export async function readEmailOpener(proposalId: string, intake: Intake): Promise<string> {
  try {
    const row = await queryOne<{ email_opener: string | null; email_opener_hash: string | null }>(
      "SELECT email_opener, email_opener_hash FROM proposals WHERE id = $1",
      [proposalId],
    );
    // A stale sentence is worse than a generic one: it describes an intake
    // that has since been edited.
    if (row?.email_opener && row.email_opener_hash === openerHash(intake)) return row.email_opener;
  } catch {
    // Fall through. An unreadable opener is not worth failing a page render.
  }
  return FALLBACK_OPENER;
}
