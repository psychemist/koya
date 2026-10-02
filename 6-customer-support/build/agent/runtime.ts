export type RuntimeEvent =
  | { kind: 'tool_start'; tool: string }
  | { kind: 'result'; ok: true; output: unknown; costUsd: number; durationMs: number }
  | { kind: 'result'; ok: false; subtype: string; costUsd: number; durationMs: number };
export interface AgentSession {
  readonly conversationId: string;
  readonly model: string;
  /** Pushes one user message and yields events until that turn's result. */
  turn(text: string): AsyncGenerator<RuntimeEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export interface AgentRuntime {
  open(conversationId: string, opts?: { model?: string; mcpFault?: 'mcp_down' | 'calendar_down' | null }): Promise<AgentSession>;
}
export type SessionState = { conversationId: string; toolCallsThisTurn: number; budgetExhausted: boolean };
