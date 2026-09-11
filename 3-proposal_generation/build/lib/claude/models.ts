/**
 * Model routing and cost accounting.
 *
 * Every Claude call in this app declares a *purpose*, and the purpose picks the
 * model. Nothing calls the API with a hardcoded model id, which is what makes
 * the cost story checkable rather than asserted: change one row in this table
 * and the whole system's spend moves with it.
 *
 * The reasoning behind the split:
 *
 *   Drafting and rewriting prose is the output a client reads and judges the
 *   firm by. That is where capability is worth paying for, so it runs on
 *   Opus 5.
 *
 *   Gap analysis and grounding are classification against a fixed schema:
 *   "is this field sufficient", "is this claim supported by that text". The
 *   answers are short, structured, and checkable, and a smaller model is not
 *   visibly worse at them. They run on Haiku 4.5, which is a fifth of the
 *   input price and a fifth of the output price.
 *
 * The alternative considered was Opus everywhere, which is simpler and keeps
 * one cache namespace. It was rejected on measurement: the gate calls are the
 * frequent ones (they run on every generation and every regeneration), so they
 * dominate call volume while contributing nothing a client sees.
 *
 * Prices are USD per million tokens, current as of 2026-06-24. Cache reads bill
 * at 0.1x input and cache writes at 1.25x input.
 */

export type Purpose =
  | "draft"
  | "section_regen"
  | "gap_analysis"
  | "grounding_judge"
  | "ocr"
  | "email_opener";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ModelId = "claude-opus-5" | "claude-haiku-4-5";

type Pricing = {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Multiplier on input price for tokens served from cache. */
  cacheReadFactor: number;
  /** Multiplier on input price for tokens written to cache. */
  cacheWriteFactor: number;
};

export const PRICING: Record<ModelId, Pricing> = {
  "claude-opus-5": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadFactor: 0.1,
    cacheWriteFactor: 1.25,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadFactor: 0.1,
    cacheWriteFactor: 1.25,
  },
};

export type RouteConfig = {
  model: ModelId;
  /**
   * Omitted for Haiku 4.5, which does not accept `effort` and returns an error
   * if it is sent. Opus 5 accepts low..max.
   */
  effort?: Effort;
  maxTokens: number;
  /** Adaptive thinking is on by default on Opus 5; Haiku 4.5 has no adaptive mode. */
  adaptiveThinking: boolean;
  why: string;
};

export const ROUTES: Record<Purpose, RouteConfig> = {
  draft: {
    model: "claude-opus-5",
    effort: "high",
    // Seven sections of prose plus JSON envelope. Streaming is used, so a
    // generous ceiling costs nothing unless it is actually needed — and being
    // truncated mid-proposal is far more expensive than the headroom.
    maxTokens: 32_000,
    adaptiveThinking: true,
    why: "The client-facing artefact. Highest-judgment task in the system.",
  },
  section_regen: {
    model: "claude-opus-5",
    // Medium, not high: the task is narrow and the surrounding document is
    // supplied as context, so the model has less to work out for itself.
    effort: "medium",
    maxTokens: 8_000,
    adaptiveThinking: true,
    why: "Must match the voice of a draft that already exists; narrow scope holds quality at lower effort.",
  },
  gap_analysis: {
    model: "claude-haiku-4-5",
    maxTokens: 4_000,
    adaptiveThinking: false,
    why: "Structured classification against a fixed schema, after the free rule-based checks have run.",
  },
  grounding_judge: {
    model: "claude-haiku-4-5",
    maxTokens: 4_000,
    adaptiveThinking: false,
    why: "Verifies a shortlist of claims the deterministic pass could not settle.",
  },
  /**
   * One sentence at the top of the client covering email.
   *
   * Haiku, and a 300-token ceiling, because the task is one sentence built
   * from text the model has been handed. There is no judgment in it worth
   * Opus rates, and the ceiling is the real control: an unbounded route here
   * would let a bad generation write six paragraphs into an email nobody
   * proofreads before it reaches a client.
   *
   * Cached against a hash of its own inputs, so this runs once per intake
   * rather than once per send. See lib/delivery/opener.ts.
   */
  email_opener: {
    model: "claude-haiku-4-5",
    maxTokens: 300,
    adaptiveThinking: false,
    why: "One sentence for the covering email, from the intake. Cached per intake, so a re-send costs nothing.",
  },
  /**
   * Reading a scanned PDF that carries no text layer.
   *
   * Haiku rather than Opus, and the reasoning is worth stating because this is
   * the one route where the cheap choice is arguably the risky one.
   *
   * Transcription is extractive: the words are on the page and the task is to
   * report them, not to decide anything. That is squarely Haiku's competence.
   * It is also the most token-expensive call in the application by input
   * volume — every page arrives as an image, at roughly 1,500-3,000 tokens
   * each — so a 20-page scan is 30-60k input tokens. At Opus rates that is
   * around $0.15-0.30 per document just to read it, against $0.03-0.06 on
   * Haiku, on a path that runs before anyone has decided the file is even
   * useful.
   *
   * The risk is real and is handled elsewhere: a mis-transcribed figure
   * becomes "grounded" as far as the grounding gate is concerned, because the
   * gate checks the draft against the sources and this IS the source. That is
   * why OCR text is labelled as transcribed in the prompt, why the source is
   * marked in the UI, and why a scan raises an advisory gap telling the
   * reviewer to check the figures against the original.
   */
  ocr: {
    model: "claude-haiku-4-5",
    maxTokens: 16_000,
    adaptiveThinking: false,
    why: "Extractive transcription of page images; the most input-heavy call in the system.",
  },
};

export type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/**
 * Cost in millionths of a USD.
 *
 * Integer micro-dollars rather than floats: a proposal's spend is summed across
 * a dozen calls and stored, and accumulating float rounding into a figure shown
 * to a user is how a cost display stops matching the invoice. Rounding happens
 * once, here, at the end.
 */
export function costMicroUsd(model: ModelId, usage: Usage): number {
  const p = PRICING[model];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  // Price per token, in micro-dollars: $5/MTok is 5 micro-dollars per token.
  const inputMicro = p.inputPerMTok;
  const outputMicro = p.outputPerMTok;

  const total =
    input * inputMicro +
    output * outputMicro +
    cacheWrite * inputMicro * p.cacheWriteFactor +
    cacheRead * inputMicro * p.cacheReadFactor;

  return Math.round(total);
}

/** For the UI. Sub-cent costs are the norm, so two decimals would read as $0.00. */
export function formatUsd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  if (microUsd === 0) return "$0.00";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/**
 * Prompt version. Bumping this invalidates every cached generation, because it
 * is part of the content hash — which is exactly what you want after editing a
 * prompt: the old output was produced by different instructions and must not be
 * served as though it were current.
 */
export const PROMPT_VERSION = "2026-09-08.1";
