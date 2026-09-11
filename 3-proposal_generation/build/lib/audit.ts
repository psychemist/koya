import { query } from "./db";
import { AppError, type ErrorCodeValue } from "./errors";
import type { Purpose } from "./claude/models";

/**
 * The audit trail. Two destinations, on purpose:
 *
 *   stdout — structured JSON, one line per event. Survives a database outage
 *            and is what Vercel's log viewer greps. This is the destination
 *            that works when the other one is the thing that broke.
 *   events — queryable, joined to proposals and users, and what the in-app
 *            System page reads.
 *
 * The cardinal rule here is that LOGGING MUST NEVER BREAK THE REQUEST. A
 * failed INSERT into `events` degrades to a stdout line and nothing else: an
 * audit write that throws would turn every recoverable failure into a
 * request-killing one, and would do it precisely when the system is already
 * unhealthy.
 */

export type Outcome = "ok" | "error" | "denied" | "skipped";

export type EventInput = {
  correlationId: string;
  action: string;
  outcome: Outcome;
  actorId?: string | null;
  proposalId?: string | null;
  latencyMs?: number | null;
  errorCode?: ErrorCodeValue | string | null;
  detail?: Record<string, unknown>;
};

/** Keys whose values are redacted before anything is written anywhere. */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|hash/i;

/**
 * Defence in depth for the audit trail itself. `detail` is assembled from
 * request payloads in a dozen places, and it only takes one call site passing
 * a whole request body for a password to land in a log line that is then
 * screenshotted into a demo video. Redaction happens here, once, rather than
 * being remembered at every call site.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function logLine(payload: Record<string, unknown>): void {
  // Single-line JSON so a log aggregator can parse it and a human can still
  // read it. Errors go to stderr so they are separable at the platform level.
  const line = JSON.stringify({ ts: new Date().toISOString(), ...payload });
  if (payload.outcome === "error") console.error(line);
  else console.log(line);
}

export async function recordEvent(input: EventInput): Promise<void> {
  const detail = (redact(input.detail ?? {}) ?? {}) as Record<string, unknown>;

  logLine({
    scope: "event",
    correlationId: input.correlationId,
    action: input.action,
    outcome: input.outcome,
    actorId: input.actorId ?? null,
    proposalId: input.proposalId ?? null,
    latencyMs: input.latencyMs ?? null,
    errorCode: input.errorCode ?? null,
    detail,
  });

  try {
    await query(
      `INSERT INTO events
         (correlation_id, actor_id, proposal_id, action, outcome, latency_ms, error_code, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.correlationId,
        input.actorId ?? null,
        input.proposalId ?? null,
        input.action,
        input.outcome,
        input.latencyMs ?? null,
        input.errorCode ?? null,
        JSON.stringify(detail),
      ],
    );
  } catch (err) {
    // See the cardinal rule above. This is the one place in the codebase where
    // swallowing an error is correct — but it is still announced.
    logLine({
      scope: "audit.write_failed",
      outcome: "error",
      correlationId: input.correlationId,
      action: input.action,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wraps an operation so that it is logged exactly once, whatever happens, with
 * a measured latency. Returns whatever the operation returns and rethrows what
 * it throws — the logging is a side effect, never a behaviour change.
 */
export async function withAudit<T>(
  meta: Omit<EventInput, "outcome" | "latencyMs">,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await recordEvent({ ...meta, outcome: "ok", latencyMs: Date.now() - started });
    return result;
  } catch (err) {
    const app = err instanceof AppError ? err : null;
    await recordEvent({
      ...meta,
      // A refused permission is a normal, expected outcome that should not
      // show up in the failure list next to a crashed PDF generator.
      outcome: app && (app.httpStatus === 401 || app.httpStatus === 403) ? "denied" : "error",
      latencyMs: Date.now() - started,
      errorCode: app?.code ?? "INTERNAL",
      detail: {
        ...meta.detail,
        ...(app ? app.detail : {}),
        message: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

export type AiCallRecord = {
  proposalId?: string | null;
  correlationId: string;
  /**
   * The route this call was made on.
   *
   * `Purpose` rather than a second copy of the union. It was a copy, and a
   * copy of a union is a constraint that silently stops matching the thing it
   * describes: adding a route meant this list, the CHECK constraint in the
   * database and the ROUTES table all had to be edited, and nothing connected
   * them. Now only two of those, and the type error points at the third.
   */
  purpose: Purpose;
  model: string;
  effort?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costMicroUsd?: number;
  latencyMs?: number | null;
  stopReason?: string | null;
  attempts?: number;
  promptVersion: string;
  cacheHit?: boolean;
  errorCode?: string | null;
};

/**
 * One row per Claude request, including the ones that cost nothing because the
 * content hash already matched (`cacheHit`) and the ones that failed. Without
 * the failures and the cache hits in the same table, "cost per proposal" is a
 * number you cannot check.
 *
 * Returns the row id so a generated section can point at the exact call that
 * produced it.
 */
export async function recordAiCall(rec: AiCallRecord): Promise<string | null> {
  logLine({
    scope: "ai_call",
    outcome: rec.errorCode ? "error" : "ok",
    correlationId: rec.correlationId,
    purpose: rec.purpose,
    model: rec.model,
    effort: rec.effort ?? null,
    inputTokens: rec.inputTokens ?? 0,
    outputTokens: rec.outputTokens ?? 0,
    cacheReadTokens: rec.cacheReadTokens ?? 0,
    costMicroUsd: rec.costMicroUsd ?? 0,
    latencyMs: rec.latencyMs ?? null,
    attempts: rec.attempts ?? 1,
    cacheHit: rec.cacheHit ?? false,
    errorCode: rec.errorCode ?? null,
  });

  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO ai_calls
         (proposal_id, correlation_id, purpose, model, effort,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_micro_usd, latency_ms, stop_reason, attempts, prompt_version,
          cache_hit, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        rec.proposalId ?? null,
        rec.correlationId,
        rec.purpose,
        rec.model,
        rec.effort ?? null,
        rec.inputTokens ?? 0,
        rec.outputTokens ?? 0,
        rec.cacheCreationTokens ?? 0,
        rec.cacheReadTokens ?? 0,
        rec.costMicroUsd ?? 0,
        rec.latencyMs ?? null,
        rec.stopReason ?? null,
        rec.attempts ?? 1,
        rec.promptVersion,
        rec.cacheHit ?? false,
        rec.errorCode ?? null,
      ],
    );

    // Keep the proposal's running total in step. Cache hits add zero, so this
    // is safe to call unconditionally.
    if (rec.proposalId && (rec.costMicroUsd ?? 0) > 0) {
      await query(
        `UPDATE proposals SET cost_micro_usd = cost_micro_usd + $2 WHERE id = $1`,
        [rec.proposalId, rec.costMicroUsd ?? 0],
      );
    }
    return rows[0]?.id ?? null;
  } catch (err) {
    logLine({
      scope: "audit.ai_call_write_failed",
      outcome: "error",
      correlationId: rec.correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
