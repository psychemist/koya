/**
 * Typed provider failures with distinct codes.
 *
 * The code is what lands in `tool_calls.error_code`, and the whole point of
 * the failure-mode table in the spec is that a reviewer can tell a dead domain
 * from a rate limit from a spent budget without reading a stack trace.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const isBudgetDenial = (e: unknown): boolean => {
  const code = (e as { code?: string })?.code;
  return typeof code === 'string' && (code.startsWith('BUDGET_') || code === 'SCOPE_DENIED');
};

/**
 * What Claude reads when a tool fails. A raw exception string teaches the
 * model nothing about what to do next; a composed one tells it whether to
 * retry, narrow, or stop.
 */
export function errorForAgent(e: unknown): string {
  if (e instanceof ProviderError) {
    return `${e.code}: ${e.message}` +
      (e.retryable ? ' This is transient. You may try once more.' : ' Do not retry this call.');
  }
  return `TOOL_ERROR: ${e instanceof Error ? e.message : String(e)}`;
}
