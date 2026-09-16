/**
 * One error shape for the whole app.
 *
 * Three separate fields on purpose:
 *   userMessage  what a person is shown. No internals.
 *   code         what the UI branches on and the log indexes.
 *   detail       what a developer needs. NEVER sent to the browser.
 *
 * A stack trace in a toast is both useless to the reader and a disclosure.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
    public readonly detail?: unknown,
    /** Can a retry of the identical request plausibly succeed? */
    public readonly retryable = false,
  ) {
    super(userMessage);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (what: string) => new AppError('not_found', `${what} not found.`, 404),
  // A non-viewer gets 404, not 403: 403 confirms the resource exists.
  forbidden: () => new AppError('not_found', 'Not found.', 404),
  conflict: (msg: string) =>
    new AppError('conflict', msg, 409, undefined, false),
  validation: (msg: string, detail?: unknown) =>
    new AppError('validation_failed', msg, 422, detail),
  blocked: (msg: string) => new AppError('blocked', msg, 409),
  upstream: (code: string, msg: string, retryable: boolean, detail?: unknown) =>
    new AppError(code, msg, 502, detail, retryable),
} as const;

export function toResponseBody(e: unknown, correlationId: string) {
  if (e instanceof AppError) {
    return {
      body: { error: { code: e.code, message: e.userMessage, correlationId } },
      status: e.status,
    };
  }
  return {
    body: {
      error: {
        code: 'internal_error',
        message: 'Something went wrong. Quote the correlation ID below.',
        correlationId,
      },
    },
    status: 500,
  };
}
