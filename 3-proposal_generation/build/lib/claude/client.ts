import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { AppError, ErrorCode } from "../errors";
import { recordAiCall } from "../audit";
import {
  ROUTES,
  costMicroUsd,
  PROMPT_VERSION,
  type Purpose,
  type Usage,
} from "./models";

/**
 * The single door to the Claude API.
 *
 * Nothing else in this codebase constructs an Anthropic client or names a
 * model. Everything goes through `callClaude` / `streamClaude`, which means
 * retries, cost accounting, error mapping and the audit row are impossible to
 * forget at a call site.
 */

const globalForClaude = globalThis as unknown as { __koyaAnthropic?: Anthropic };

function client(): Anthropic {
  if (!globalForClaude.__koyaAnthropic) {
    globalForClaude.__koyaAnthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
      // Our own retry loop replaces the SDK's. The SDK would retry silently,
      // which means `attempts` in the audit row would always read 1 and a
      // route that succeeds only on its third try would look healthy.
      maxRetries: 0,
      timeout: 120_000,
    });
  }
  return globalForClaude.__koyaAnthropic;
}

const MAX_ATTEMPTS = 3;

/**
 * Which failures are worth trying again.
 *
 * Retrying a 400 produces an identical 400 while spending latency the user is
 * waiting through; retrying a 429 or a 529 usually succeeds. Getting this
 * distinction wrong in either direction is expensive, so it is one function
 * with the reasoning written down rather than a condition inline at each site.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true; // 429
  if (err instanceof Anthropic.InternalServerError) return true; // 5xx
  if (err instanceof Anthropic.APIConnectionError) return true; // socket, DNS, TLS
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded is not its own SDK class.
    return err.status === 529 || (typeof err.status === "number" && err.status >= 500);
  }
  return false;
}

/** Honours Retry-After when the API sends one; otherwise exponential + jitter. */
function backoffMs(attempt: number, err: unknown): number {
  const headers = (err as { headers?: Record<string, string> } | null)?.headers;
  const retryAfter = headers?.["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 30) {
      return Math.ceil(seconds * 1000);
    }
  }
  // Jitter matters: without it, a burst of requests rate-limited together all
  // retry at the same instant and reproduce the burst that caused the limit.
  const base = 500 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps an SDK error onto an AppError a user can be shown. */
function mapError(err: unknown, purpose: Purpose): AppError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AppError({
      code: ErrorCode.AI_UNAVAILABLE,
      userMessage:
        "The Claude API rejected our credentials. This is a configuration problem on our side, not something you did.",
      message: `anthropic auth failed during ${purpose}: ${err.message}`,
      detail: { purpose, status: err.status },
      cause: err,
    });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError({
      code: ErrorCode.AI_RATE_LIMITED,
      userMessage:
        "Claude is rate-limiting us right now. Nothing was lost. Wait a few seconds and try again.",
      message: `rate limited during ${purpose}: ${err.message}`,
      detail: { purpose },
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError({
      code: ErrorCode.AI_MALFORMED_OUTPUT,
      userMessage:
        "Claude rejected the request we built. That is a bug on our side, and the correlation id below will find it.",
      message: `bad request during ${purpose}: ${err.message}`,
      detail: { purpose, status: err.status },
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError({
      code: ErrorCode.AI_UNAVAILABLE,
      userMessage: "We could not reach Claude. Your work is saved, so try again in a moment.",
      message: `connection error during ${purpose}: ${err.message}`,
      detail: { purpose },
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError({
      code: ErrorCode.AI_UNAVAILABLE,
      userMessage: "Claude returned an error. Your work is saved, so try again in a moment.",
      message: `api error ${err.status} during ${purpose}: ${err.message}`,
      detail: { purpose, status: err.status },
      retryable: true,
      cause: err,
    });
  }
  return new AppError({
    code: ErrorCode.AI_UNAVAILABLE,
    userMessage: "Claude was unavailable. Your work is saved, so try again in a moment.",
    message: err instanceof Error ? err.message : String(err),
    detail: { purpose },
    retryable: true,
    cause: err,
  });
}

/**
 * Rejects a response that came back for the wrong reason.
 *
 * `refusal` and `max_tokens` both arrive as HTTP 200 with content attached. A
 * truncated proposal looks like a finished one until a human reads the last
 * paragraph, so this is checked centrally rather than trusted.
 */
function assertUsableStop(
  stopReason: string | null | undefined,
  purpose: Purpose,
  stopDetails?: { category?: string | null; explanation?: string | null } | null,
): void {
  if (stopReason === "refusal") {
    throw new AppError({
      code: ErrorCode.AI_REFUSED,
      userMessage:
        "Claude declined to write this. Check the intake for anything that reads as a request it should not fulfil, then try again.",
      message: `refusal during ${purpose}: ${stopDetails?.category ?? "unknown"}`,
      detail: { purpose, category: stopDetails?.category ?? null },
    });
  }
  if (stopReason === "max_tokens") {
    throw new AppError({
      code: ErrorCode.AI_TRUNCATED,
      userMessage:
        "Claude ran out of room before finishing. The partial result was discarded rather than saved half-written. Try a shorter scope, or regenerate section by section.",
      message: `hit max_tokens during ${purpose}`,
      detail: { purpose },
      retryable: true,
    });
  }
}

export type CallOptions = {
  purpose: Purpose;
  correlationId: string;
  proposalId?: string | null;
  /** Cached prefix. Stable content only — see prompts.ts. */
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  /** Overrides the route's default, for the rare narrow call. */
  maxTokens?: number;
};

export type CallResult = {
  text: string;
  usage: Usage;
  costMicroUsd: number;
  latencyMs: number;
  attempts: number;
  stopReason: string | null;
  aiCallId: string | null;
  model: string;
};

/**
 * A non-streaming request, retried, costed and audited.
 *
 * The audit row is written on both the success and the failure path, and the
 * failure row carries the error code. A missing row is therefore a bug, not a
 * failed call — which is the property that makes "cost per proposal" and
 * "recent failures" trustworthy.
 */
export async function callClaude(opts: CallOptions): Promise<CallResult> {
  const route = ROUTES[opts.purpose];
  const started = Date.now();
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const response = await client().messages.create({
        model: route.model,
        max_tokens: opts.maxTokens ?? route.maxTokens,
        system: opts.system,
        messages: opts.messages,
        ...(route.effort ? { output_config: { effort: route.effort } } : {}),
        ...(route.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
      });

      assertUsableStop(response.stop_reason, opts.purpose, response.stop_details);

      const usage = response.usage as Usage;
      const cost = costMicroUsd(route.model, usage);
      const latencyMs = Date.now() - started;

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const aiCallId = await recordAiCall({
        proposalId: opts.proposalId ?? null,
        correlationId: opts.correlationId,
        purpose: opts.purpose,
        model: route.model,
        effort: route.effort ?? null,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        costMicroUsd: cost,
        latencyMs,
        stopReason: response.stop_reason ?? null,
        attempts: attempt,
        promptVersion: PROMPT_VERSION,
      });

      return {
        text,
        usage,
        costMicroUsd: cost,
        latencyMs,
        attempts: attempt,
        stopReason: response.stop_reason ?? null,
        aiCallId,
        model: route.model,
      };
    } catch (err) {
      lastErr = err;
      // A refusal or a truncation is a real answer, not a transport failure.
      // Retrying either burns money to get the same outcome.
      const isOurs = err instanceof AppError;
      if (isOurs || !isRetryable(err) || attempt >= MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, err));
    }
  }

  const appErr = lastErr instanceof AppError ? lastErr : mapError(lastErr, opts.purpose);
  await recordAiCall({
    proposalId: opts.proposalId ?? null,
    correlationId: opts.correlationId,
    purpose: opts.purpose,
    model: route.model,
    effort: route.effort ?? null,
    latencyMs: Date.now() - started,
    attempts: attempt,
    promptVersion: PROMPT_VERSION,
    errorCode: appErr.code,
  });
  throw appErr;
}

/**
 * A streaming request. Calls `onText` with each delta so the browser can show
 * the proposal being written, and resolves with the same accounting as
 * `callClaude`.
 *
 * Streaming is not decoration here. A full draft is seven sections of prose at
 * high effort and takes long enough that a spinner would read as a hang, and a
 * non-streaming request of this size risks the platform's own response
 * timeout — the SDK notes as much for large max_tokens.
 *
 * Retries deliberately do NOT wrap a stream that has already emitted text: the
 * consumer has rendered those characters, and replaying from the start would
 * duplicate them. Only a failure before the first delta is retried.
 */
export async function streamClaude(
  opts: CallOptions & { onText: (delta: string) => void },
): Promise<CallResult> {
  const route = ROUTES[opts.purpose];
  const started = Date.now();
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    let emitted = false;
    try {
      const stream = client().messages.stream({
        model: route.model,
        max_tokens: opts.maxTokens ?? route.maxTokens,
        system: opts.system,
        messages: opts.messages,
        ...(route.effort ? { output_config: { effort: route.effort } } : {}),
        ...(route.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          emitted = true;
          opts.onText(event.delta.text);
        }
      }

      const response = await stream.finalMessage();
      assertUsableStop(response.stop_reason, opts.purpose, response.stop_details);

      const usage = response.usage as Usage;
      const cost = costMicroUsd(route.model, usage);
      const latencyMs = Date.now() - started;

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const aiCallId = await recordAiCall({
        proposalId: opts.proposalId ?? null,
        correlationId: opts.correlationId,
        purpose: opts.purpose,
        model: route.model,
        effort: route.effort ?? null,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        costMicroUsd: cost,
        latencyMs,
        stopReason: response.stop_reason ?? null,
        attempts: attempt,
        promptVersion: PROMPT_VERSION,
      });

      return {
        text,
        usage,
        costMicroUsd: cost,
        latencyMs,
        attempts: attempt,
        stopReason: response.stop_reason ?? null,
        aiCallId,
        model: route.model,
      };
    } catch (err) {
      lastErr = err;
      const isOurs = err instanceof AppError;
      if (isOurs || emitted || !isRetryable(err) || attempt >= MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, err));
    }
  }

  const appErr = lastErr instanceof AppError ? lastErr : mapError(lastErr, opts.purpose);
  await recordAiCall({
    proposalId: opts.proposalId ?? null,
    correlationId: opts.correlationId,
    purpose: opts.purpose,
    model: route.model,
    effort: route.effort ?? null,
    latencyMs: Date.now() - started,
    attempts: attempt,
    promptVersion: PROMPT_VERSION,
    errorCode: appErr.code,
  });
  throw appErr;
}

/**
 * A structured request whose result is validated against a Zod schema by the
 * API itself. Used by the two gate calls, where a malformed shape would
 * otherwise have to be defended against by hand.
 */
export async function parseClaude<T>(
  opts: CallOptions & { format: unknown },
): Promise<{ parsed: T } & Omit<CallResult, "text">> {
  const route = ROUTES[opts.purpose];
  const started = Date.now();
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const response = await client().messages.parse({
        model: route.model,
        max_tokens: opts.maxTokens ?? route.maxTokens,
        system: opts.system,
        messages: opts.messages,
        ...(route.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
        // `effort` rides inside output_config alongside `format`, not as a
        // separate key — two output_config properties would silently overwrite
        // each other and drop the format.
        output_config: {
          ...(route.effort ? { effort: route.effort } : {}),
          format: opts.format as never,
        },
      });

      assertUsableStop(response.stop_reason, opts.purpose, response.stop_details);

      // parsed_output is null when the model's JSON did not validate. Treated
      // as a hard failure: a gate that silently returns nothing is a gate that
      // is not there.
      const parsed = response.parsed_output as T | null;
      if (parsed === null || parsed === undefined) {
        throw new AppError({
          code: ErrorCode.AI_MALFORMED_OUTPUT,
          userMessage:
            "Claude's answer did not match the expected shape, so it was rejected rather than half-trusted.",
          message: `parsed_output was null during ${opts.purpose}`,
          detail: { purpose: opts.purpose },
          retryable: true,
        });
      }

      const usage = response.usage as Usage;
      const cost = costMicroUsd(route.model, usage);
      const latencyMs = Date.now() - started;

      const aiCallId = await recordAiCall({
        proposalId: opts.proposalId ?? null,
        correlationId: opts.correlationId,
        purpose: opts.purpose,
        model: route.model,
        effort: route.effort ?? null,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        costMicroUsd: cost,
        latencyMs,
        stopReason: response.stop_reason ?? null,
        attempts: attempt,
        promptVersion: PROMPT_VERSION,
      });

      return {
        parsed,
        usage,
        costMicroUsd: cost,
        latencyMs,
        attempts: attempt,
        stopReason: response.stop_reason ?? null,
        aiCallId,
        model: route.model,
      };
    } catch (err) {
      lastErr = err;
      const malformed = err instanceof AppError && err.code === ErrorCode.AI_MALFORMED_OUTPUT;
      // A malformed structured output IS worth one more try — it is usually
      // sampling noise rather than a broken schema.
      const retry = malformed || isRetryable(err);
      if (!retry || attempt >= MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, err));
    }
  }

  const appErr = lastErr instanceof AppError ? lastErr : mapError(lastErr, opts.purpose);
  await recordAiCall({
    proposalId: opts.proposalId ?? null,
    correlationId: opts.correlationId,
    purpose: opts.purpose,
    model: route.model,
    effort: route.effort ?? null,
    latencyMs: Date.now() - started,
    attempts: attempt,
    promptVersion: PROMPT_VERSION,
    errorCode: appErr.code,
  });
  throw appErr;
}

/** Cheap reachability probe for /api/health. One token in, one token out. */
export async function pingClaude(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await client().messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
