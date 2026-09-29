export type ToolErrorCode =
  | 'INVALID_INPUT' | 'CONVERSATION_UNKNOWN' | 'UNAUTHORIZED' | 'LIMIT'
  | 'TIME_NEEDS_OFFSET' | 'TIME_IN_PAST' | 'OUTSIDE_HOURS' | 'INVALID_TIME'
  | 'EMBEDDING_FAILED' | 'DB_ERROR' | 'UNKNOWN';

/** A refusal is the tool doing its job; an error is the tool failing. The log keeps them apart. */
const DENIED = new Set<ToolErrorCode>(['UNAUTHORIZED', 'LIMIT', 'TIME_NEEDS_OFFSET', 'TIME_IN_PAST', 'OUTSIDE_HOURS', 'INVALID_INPUT']);

export class ToolError extends Error {
  constructor(public code: ToolErrorCode, message: string, public details?: Record<string, unknown>) { super(message); }
  get denied() { return DENIED.has(this.code); }
}

export const toToolError = (e: unknown): ToolError =>
  e instanceof ToolError ? e : new ToolError('UNKNOWN', e instanceof Error ? e.message : String(e));
