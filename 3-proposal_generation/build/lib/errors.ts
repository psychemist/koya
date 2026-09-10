import { humanStatus } from "./proposal/status";

/**
 * Error handling exists to answer one question: what failed and why.
 *
 * Every failure in this app carries three separable things, and conflating
 * them is what produces both leaky stack traces in the UI and useless
 * "something went wrong" toasts:
 *
 *   code        — stable, machine-readable, safe to show. Goes in the log,
 *                 the events table, and the toast.
 *   userMessage — a sentence a salesperson can act on. Never contains a stack,
 *                 a SQL fragment, a URL, or a provider payload.
 *   detail      — everything a developer needs. Written to events.detail and
 *                 stdout, never serialised to the browser.
 *
 * `retryable` distinguishes "try again" from "this will fail identically
 * forever", which is what stops the retry loop from hammering a 400.
 */

export const ErrorCode = {
  // Input
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",

  // Identity
  UNAUTHENTICATED: "UNAUTHENTICATED",
  BAD_CREDENTIALS: "BAD_CREDENTIALS",
  FORBIDDEN_ROLE: "FORBIDDEN_ROLE",
  SELF_APPROVAL_FORBIDDEN: "SELF_APPROVAL_FORBIDDEN",

  // State machine
  NOT_FOUND: "NOT_FOUND",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  CONCURRENT_MODIFICATION: "CONCURRENT_MODIFICATION",
  BLOCKING_GAPS_OPEN: "BLOCKING_GAPS_OPEN",
  NOT_APPROVED: "NOT_APPROVED",
  ALREADY_SENT: "ALREADY_SENT",

  // Claude
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  AI_RATE_LIMITED: "AI_RATE_LIMITED",
  AI_REFUSED: "AI_REFUSED",
  AI_MALFORMED_OUTPUT: "AI_MALFORMED_OUTPUT",
  AI_TRUNCATED: "AI_TRUNCATED",

  // Abuse and cost control
  RATE_LIMITED: "RATE_LIMITED",

  // Downstream
  DB_UNAVAILABLE: "DB_UNAVAILABLE",
  DELIVERY_NO_PROVIDER: "DELIVERY_NO_PROVIDER",
  DELIVERY_FAILED: "DELIVERY_FAILED",
  DOCGEN_FAILED: "DOCGEN_FAILED",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",

  // Fallback
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly detail: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(opts: {
    code: ErrorCodeValue;
    httpStatus?: number;
    userMessage: string;
    /** Developer-facing. Defaults to userMessage so a throw is never silent. */
    message?: string;
    detail?: Record<string, unknown>;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(opts.message ?? opts.userMessage, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus ?? defaultStatusFor(opts.code);
    this.userMessage = opts.userMessage;
    this.detail = opts.detail ?? {};
    this.retryable = opts.retryable ?? false;
  }
}

function defaultStatusFor(code: ErrorCodeValue): number {
  switch (code) {
    case ErrorCode.VALIDATION_FAILED:
    case ErrorCode.UNSUPPORTED_FILE_TYPE:
    case ErrorCode.AI_MALFORMED_OUTPUT:
      return 400;
    case ErrorCode.FILE_TOO_LARGE:
      return 413;
    case ErrorCode.UNAUTHENTICATED:
    case ErrorCode.BAD_CREDENTIALS:
      return 401;
    case ErrorCode.FORBIDDEN_ROLE:
    case ErrorCode.SELF_APPROVAL_FORBIDDEN:
      return 403;
    case ErrorCode.NOT_FOUND:
      return 404;
    case ErrorCode.INVALID_TRANSITION:
    case ErrorCode.BLOCKING_GAPS_OPEN:
    case ErrorCode.NOT_APPROVED:
    case ErrorCode.ALREADY_SENT:
      return 409;
    case ErrorCode.CONCURRENT_MODIFICATION:
      return 409;
    case ErrorCode.AI_RATE_LIMITED:
    case ErrorCode.RATE_LIMITED:
      return 429;
    case ErrorCode.AI_UNAVAILABLE:
    case ErrorCode.DB_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

/** Convenience constructors for the cases used in more than one place. */
export const errors = {
  notFound: (what: string) =>
    new AppError({
      code: ErrorCode.NOT_FOUND,
      userMessage: `${what} could not be found. It may have been deleted.`,
      detail: { what },
    }),

  unauthenticated: () =>
    new AppError({
      code: ErrorCode.UNAUTHENTICATED,
      userMessage: "Your session has expired. Sign in again to continue.",
    }),

  forbiddenRole: (need: string, have: string) =>
    new AppError({
      code: ErrorCode.FORBIDDEN_ROLE,
      userMessage: `This action needs the ${need} role. You are signed in as ${have}.`,
      detail: { need, have },
    }),

  validation: (userMessage: string, detail?: Record<string, unknown>) =>
    new AppError({ code: ErrorCode.VALIDATION_FAILED, userMessage, detail }),

  concurrent: () =>
    new AppError({
      code: ErrorCode.CONCURRENT_MODIFICATION,
      userMessage:
        "Someone else changed this proposal a moment ago. Reload to see the current version. Nothing you wrote has been lost.",
      retryable: true,
    }),

  invalidTransition: (from: string, to: string) =>
    new AppError({
      code: ErrorCode.INVALID_TRANSITION,
      userMessage: `A proposal that is ${humanStatus(from)} cannot be ${humanStatus(to)}.`,
      detail: { from, to },
    }),
};


/**
 * A short, readable id stamped on every request, returned as
 * X-Correlation-Id, shown in error toasts, and stored on every events and
 * ai_calls row. It is the thread that ties "the button went red" to the exact
 * database row explaining why.
 *
 * Eight hex characters, not a UUID: a user has to be able to read it off a
 * screen and quote it, and 4 billion values is ample for scoping a search by
 * time as well.
 */
export function newCorrelationId(): string {
  // Web Crypto rather than node:crypto, deliberately. This module is reached
  // from client components (they render error codes and status labels), and a
  // `node:` import anywhere in that graph fails the browser bundle outright.
  // The Web API is available in the browser, in Node, and on the edge runtime,
  // so one implementation serves all three.
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalises anything thrown into the shape the API and the UI expect.
 * An unrecognised throw becomes INTERNAL with a generic message — the real
 * error still reaches the log and the events row, but never the browser.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  // Postgres surfaces its own conditions as codes; two of them are ordinary
  // application outcomes rather than bugs, so they get real messages.
  const pgCode = (err as { code?: string } | null)?.code;
  if (pgCode === "23505") {
    return new AppError({
      code: ErrorCode.CONCURRENT_MODIFICATION,
      userMessage: "That already exists. Reload to see the current state.",
      message: `unique violation: ${(err as Error).message}`,
      cause: err,
    });
  }
  if (pgCode === "ECONNREFUSED" || pgCode === "57P01" || pgCode === "08006") {
    return new AppError({
      code: ErrorCode.DB_UNAVAILABLE,
      userMessage: "The database is not reachable right now. Your work is saved locally, so try again in a moment.",
      message: `database connection: ${(err as Error).message}`,
      retryable: true,
      cause: err,
    });
  }

  return new AppError({
    code: ErrorCode.INTERNAL,
    userMessage: "Something went wrong on our side. Nothing was lost. Try again.",
    message: err instanceof Error ? err.message : String(err),
    detail: err instanceof Error && err.stack ? { stack: err.stack.split("\n").slice(0, 6) } : {},
    cause: err,
  });
}
