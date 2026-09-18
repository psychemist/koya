import { call } from '../claude/client';
import { MODELS } from '../claude/models';

/**
 * A sanity check on the IDEA, before anything else runs.
 *
 * This answers a different question from every other check in the pipeline,
 * and the difference matters enough to spell out.
 *
 *   The grounding gate (lib/gates/tier0/grounding.ts) asks: does this NUMBER,
 *   DATE, PERCENTAGE or QUOTE appear in a source excerpt? It is a pattern
 *   match, and a plain declarative sentence with no digits in it — "humans
 *   have four legs" — contains nothing the pattern matches, so it sails
 *   through untouched.
 *
 *   The judge's `factual_consistency` criterion (lib/claude/prompts.ts) asks:
 *   is this claim CONSISTENT WITH THE SUPPLIED SOURCES? If a low-quality or
 *   satirical source happens to assert the same false thing, the claim is
 *   "consistent" with what it was given, and the judge has no independent
 *   notion of truth to fall back on. A source being wrong does not stop a
 *   model from treating it as ground truth.
 *
 * Neither check can catch a false PREMISE, because neither is built to ask
 * "is this true", only "does this trace back to something you were shown".
 * This one asks the first question, using the model's own general knowledge,
 * and it runs at INTAKE, before research or drafting spends a cent. The
 * system deciding not to run is the cheapest cost control it has, the same
 * reasoning behind the cannibalisation check it sits beside.
 *
 * DELIBERATELY CONSERVATIVE. A false positive here blocks a legitimate
 * request outright, which is a worse failure than letting a genuinely
 * borderline idea through to a human. So the model is instructed to flag only
 * a claim asserted as true that conflicts with settled, uncontroversial fact:
 * flat-earth cosmology, human anatomy, basic physics and history of the kind
 * no reasonable person disputes. It is told explicitly NOT to flag contested
 * opinion, genuine expert disagreement, or an idea that is ABOUT a false
 * belief rather than asserting it — "why some people still believe the earth
 * is flat" is a true premise about a false one, and must pass.
 */
const SYSTEM =
  'You screen content briefs for one thing only: does the core idea require the writer to ' +
  'assert something as TRUE that is false by settled, uncontroversial fact.\n\n' +
  'Flag it ONLY when the brief asks for an article built on a premise that plainly conflicts ' +
  'with basic, universally accepted fact: elementary anatomy, physics, geography, arithmetic, ' +
  'or a historical event with no serious dispute. "Humans have four legs" or "the earth is ' +
  'flat" are the shape of what you are looking for.\n\n' +
  'DO NOT flag: a contested political, economic or social opinion; a claim experts genuinely ' +
  'disagree on; forward-looking predictions; satire, comedy, or fiction that is not presented ' +
  'as fact; or an idea that is ABOUT a false belief rather than asserting it — "why some ' +
  'people still believe the earth is flat" has a TRUE premise and must not be flagged, because ' +
  'it is examining a myth rather than repeating it as fact.\n\n' +
  'When genuinely unsure, do not flag it. A person reviews every angle before anything is ' +
  'written; your job is only to catch the unambiguous case before money is spent on it.';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['false_premise', 'confident', 'claim', 'reason'],
  properties: {
    false_premise: { type: 'boolean' },
    /** Only a true+true pair blocks. A confident "no" and an unconfident "yes" both pass. */
    confident: { type: 'boolean' },
    /** The specific sentence that is the problem, quoted or closely paraphrased. Empty if none. */
    claim: { type: 'string' },
    /** One sentence, in the words a person raising the request would understand. */
    reason: { type: 'string' },
  },
} as const;

export type PremiseCheck = {
  flagged: boolean;
  claim: string;
  reason: string;
  costUsd: number;
};

export async function checkPremise(opts: {
  idea: string; audience: string; keywordHint?: string | null;
}): Promise<PremiseCheck> {
  const res = await call<{ false_premise: boolean; confident: boolean; claim: string; reason: string }>({
    model: MODELS.premiseCheck,
    // Haiku's thinking budget alone is 2000 tokens (lib/claude/models.ts,
    // thinkingFor), and max_tokens has to exceed thinking.budget_tokens or the
    // API rejects the call outright with a 400. 1000 failed every single
    // call, and it failed the SAFE way — this function's own catch treats an
    // error as "not flagged" — but that meant the check never actually ran,
    // which is worse than a check that runs and is merely too lenient.
    maxTokens: 4000,
    schema: SCHEMA as unknown as Record<string, unknown>,
    system: [{ type: 'text', text: SYSTEM }],
    user: [{ type: 'text', text:
      `Idea: ${opts.idea}\nAudience: ${opts.audience}\n` +
      `Keyword hint: ${opts.keywordHint || '(none)'}` }],
  });

  const v = res.value;
  return {
    // BOTH must hold. An unconfident flag is exactly the borderline case a
    // person should see on the review screen, not one this refuses outright.
    flagged: v.false_premise && v.confident,
    claim: v.claim ?? '',
    reason: v.reason ?? '',
    costUsd: res.costUsd,
  };
}
