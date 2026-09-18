/**
 * Model routing and cost.
 *
 * "It was the default" is not an answer. Each stage is routed on what the
 * stage actually is:
 *
 *  - Haiku 4.5 does the per-source work. Extractive tasks sit at the 3-8%
 *    hallucination end of the scale versus 15-25% for open generation, and
 *    nothing expensive may ever run in a loop over N sources.
 *  - Opus 5 runs ONCE, on the one genuinely open-ended judgment in the
 *    pipeline: what the angle is. ~2k output tokens to make the decision that
 *    determines everything downstream is correct allocation.
 *  - Sonnet 5 writes. Drafting from selected excerpts against a fixed outline
 *    is CONSTRAINED generation - the planner already did the thinking.
 *  - Haiku 4.5 judges, and the reason is not cost: it is a DIFFERENT MODEL
 *    from the writer, which is the documented mitigation for self-preference
 *    bias in LLM judges.
 */
export const MODELS = {
  extract: 'claude-haiku-4-5',
  plan: 'claude-opus-5',
  draft: 'claude-sonnet-5',
  adapt: 'claude-sonnet-5',
  judge: 'claude-haiku-4-5',
  // A cheap, conservative sanity check on the IDEA itself, before research is
  // spent. See lib/pipeline/premise-check.ts for why this is a different
  // question from anything the judge asks.
  premiseCheck: 'claude-haiku-4-5',
} as const;

export type Stage = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[Stage];

/** USD per million tokens, as published. */
const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5':   { in: 5, out: 25, cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2,  cacheWrite: 2.5 },
  'claude-haiku-4-5':{ in: 1, out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
};

export function costOf(model: string, u: {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}): number {
  const p = PRICING[model];
  if (!p) return 0;
  const m = 1_000_000;
  return (
    ((u.input_tokens ?? 0) * p.in +
     (u.output_tokens ?? 0) * p.out +
     (u.cache_read_input_tokens ?? 0) * p.cacheRead +
     (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / m
  );
}

/**
 * Thinking configuration differs by model family and getting it wrong is a 400.
 *
 *  - Opus 5 / Sonnet 5 take {type:'adaptive'} and REJECT budget_tokens.
 *    Opus 5 thinks by default; Sonnet 5 does not unless told.
 *  - Haiku 4.5 still takes {type:'enabled', budget_tokens}.
 */
export function thinkingFor(model: ModelId): Record<string, unknown> | undefined {
  if (model === 'claude-haiku-4-5') {
    return { type: 'enabled', budget_tokens: 2000 };
  }
  return { type: 'adaptive' };
}
