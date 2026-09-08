import { NextResponse, type NextRequest } from "next/server";
import { AppError, ErrorCode, newCorrelationId, toAppError } from "./errors";
import { recordEvent, type Outcome } from "./audit";
import { getCurrentUser, requireRole, requireUser, type Role, type User } from "./auth";

/**
 * The wrapper every route handler goes through.
 *
 * Its job is to make three things impossible to forget, because forgetting any
 * of them is how a system becomes undebuggable:
 *
 *   1. Every request has a correlation id, returned in `X-Correlation-Id` and
 *      echoed in the error body, so a user can quote the id that finds the
 *      exact `events` row.
 *   2. Every request produces exactly one audit row, whatever happened.
 *   3. No internal detail reaches the browser. `AppError.userMessage` is
 *      shown; `AppError.message`, the stack, and any provider payload go to
 *      the log and the database only.
 */

export type RouteContext<P> = {
  correlationId: string;
  user: User;
  request: NextRequest;
  params: P;
};

export type PublicRouteContext<P> = Omit<RouteContext<P>, "user"> & { user: User | null };

/** In the App Router, dynamic params arrive as a promise on the second arg. */
type Segment<P> = { params: Promise<P> };

function errorBody(err: AppError, correlationId: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: err.code,
      // The only human-facing string. Written for a salesperson, not a
      // developer, and never assembled from an exception message.
      message: err.userMessage,
      retryable: err.retryable,
      correlationId,
    },
  };
}

function withHeaders(response: NextResponse, correlationId: string): NextResponse {
  response.headers.set("X-Correlation-Id", correlationId);
  // API responses are per-user and state-dependent; caching one is a data leak.
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * Next passes `{ params: Promise<...> }` as the second argument to every route
 * handler, including non-dynamic ones (where it resolves to an empty object).
 * It is typed as required rather than optional because Next's own generated
 * route types reject an optional second parameter.
 */
async function resolveParams<P>(segment: Segment<P>): Promise<P> {
  return (await segment.params) ?? ({} as P);
}

/**
 * A JSON route requiring a signed-in user with one of `roles`.
 *
 * The role check happens inside the handler wrapper rather than only in
 * middleware. Middleware guards navigation; an API route reached directly with
 * a valid cookie and the wrong role has to refuse on its own, and this is
 * where that refusal lives.
 */
export function route<P = Record<string, string>, T = unknown>(
  opts: { action: string; roles?: Role[] },
  handler: (ctx: RouteContext<P>) => Promise<T>,
): (request: NextRequest, segment: Segment<P>) => Promise<NextResponse> {
  return async (request, segment) => {
    const correlationId = newCorrelationId();
    const started = Date.now();

    try {
      const user = opts.roles ? await requireRole(...opts.roles) : await requireUser();
      const params = await resolveParams(segment);

      const result = await handler({ correlationId, user, request, params });

      await recordEvent({
        correlationId,
        action: opts.action,
        outcome: "ok",
        actorId: user.id,
        proposalId: extractProposalId(result, params),
        latencyMs: Date.now() - started,
      });

      return withHeaders(
        NextResponse.json({ ok: true, correlationId, ...asObject(result) }),
        correlationId,
      );
    } catch (err) {
      const app = toAppError(err);
      const outcome: Outcome =
        app.httpStatus === 401 || app.httpStatus === 403 ? "denied" : "error";

      const user = await getCurrentUser().catch(() => null);
      const params = await resolveParams(segment).catch(() => ({}) as P);

      await recordEvent({
        correlationId,
        action: opts.action,
        outcome,
        actorId: user?.id ?? null,
        proposalId: extractProposalId(null, params),
        latencyMs: Date.now() - started,
        errorCode: app.code,
        detail: { ...app.detail, message: app.message },
      });

      return withHeaders(
        NextResponse.json(errorBody(app, correlationId), { status: app.httpStatus }),
        correlationId,
      );
    }
  };
}

/** A route that does not require a session — the health probe, for instance. */
export function publicRoute<P = Record<string, string>, T = unknown>(
  opts: { action: string },
  handler: (ctx: PublicRouteContext<P>) => Promise<T>,
): (request: NextRequest, segment: Segment<P>) => Promise<NextResponse> {
  return async (request, segment) => {
    const correlationId = newCorrelationId();
    const started = Date.now();
    try {
      const user = await getCurrentUser().catch(() => null);
      const params = await resolveParams(segment);
      const result = await handler({ correlationId, user, request, params });
      await recordEvent({
        correlationId,
        action: opts.action,
        outcome: "ok",
        actorId: user?.id ?? null,
        latencyMs: Date.now() - started,
      });
      return withHeaders(
        NextResponse.json({ ok: true, correlationId, ...asObject(result) }),
        correlationId,
      );
    } catch (err) {
      const app = toAppError(err);
      await recordEvent({
        correlationId,
        action: opts.action,
        outcome: "error",
        latencyMs: Date.now() - started,
        errorCode: app.code,
        detail: { ...app.detail, message: app.message },
      });
      return withHeaders(
        NextResponse.json(errorBody(app, correlationId), { status: app.httpStatus }),
        correlationId,
      );
    }
  };
}

/**
 * A route that returns something other than JSON — a file, or a stream.
 *
 * The handler builds the whole Response. Auditing and error mapping still
 * happen here, but a failure has to be rendered as JSON even though the
 * success path is not, so the client can read the reason.
 */
export function rawRoute<P = Record<string, string>>(
  opts: { action: string; roles?: Role[] },
  handler: (ctx: RouteContext<P>) => Promise<Response>,
): (request: NextRequest, segment: Segment<P>) => Promise<Response> {
  return async (request, segment) => {
    const correlationId = newCorrelationId();
    const started = Date.now();
    try {
      const user = opts.roles ? await requireRole(...opts.roles) : await requireUser();
      const params = await resolveParams(segment);
      const response = await handler({ correlationId, user, request, params });
      response.headers.set("X-Correlation-Id", correlationId);
      await recordEvent({
        correlationId,
        action: opts.action,
        outcome: "ok",
        actorId: user.id,
        proposalId: extractProposalId(null, params),
        latencyMs: Date.now() - started,
      });
      return response;
    } catch (err) {
      const app = toAppError(err);
      const user = await getCurrentUser().catch(() => null);
      await recordEvent({
        correlationId,
        action: opts.action,
        outcome: app.httpStatus === 403 || app.httpStatus === 401 ? "denied" : "error",
        actorId: user?.id ?? null,
        latencyMs: Date.now() - started,
        errorCode: app.code,
        detail: { ...app.detail, message: app.message },
      });
      return withHeaders(
        NextResponse.json(errorBody(app, correlationId), { status: app.httpStatus }),
        correlationId,
      );
    }
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { data: value };
}

/**
 * Best-effort: lets the audit row point at a proposal without every handler
 * having to say so. Reads the result first, then the route params.
 */
function extractProposalId(result: unknown, params: unknown): string | null {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.proposalId === "string") return r.proposalId;
    const proposal = r.proposal as { id?: unknown } | undefined;
    if (proposal && typeof proposal.id === "string") return proposal.id;
  }
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>;
    // Only accept something UUID-shaped, so a slug never lands in a uuid column.
    if (typeof p.id === "string" && /^[0-9a-f-]{36}$/i.test(p.id)) return p.id;
  }
  return null;
}

/**
 * Reads and validates a JSON body. A body that is not JSON, or is too large,
 * is refused here rather than failing confusingly deeper in a handler.
 */
export async function readJson<T>(request: NextRequest, maxBytes = 512 * 1024): Promise<T> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AppError({
      code: ErrorCode.VALIDATION_FAILED,
      httpStatus: 413,
      userMessage: "That request was too large.",
      message: `body of ${text.length} bytes exceeds ${maxBytes}`,
    });
  }
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError({
      code: ErrorCode.VALIDATION_FAILED,
      userMessage: "That request could not be read.",
      message: "invalid JSON body",
    });
  }
}

/** A file download response, with the headers a browser needs to save it. */
export function fileResponse(args: {
  bytes: Uint8Array;
  filename: string;
  mime: string;
}): Response {
  // A fresh copy, so the response body is not a view over a pooled buffer
  // that may be reused before the stream is consumed.
  const copy = new Uint8Array(args.bytes);
  return new Response(copy, {
    headers: {
      "Content-Type": args.mime,
      // The filename is sanitised, so a client name containing a quote or a
      // newline cannot break out of the header.
      "Content-Disposition": `attachment; filename="${sanitiseFilename(args.filename)}"`,
      "Content-Length": String(copy.byteLength),
      "Cache-Control": "no-store",
    },
  });
}

export function sanitiseFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, "")
    .replace(/[^\w.\- ]/g, "_")
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : "download";
}
