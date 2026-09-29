/**
 * The only file that imports @anthropic-ai/claude-agent-sdk. The SDK releases
 * weekly; a moved name changes here and nowhere else. Confirmed by the Task 0
 * spike (SPIKE.md, Q3 to Q7).
 */
export { query, startup } from '@anthropic-ai/claude-agent-sdk';
export type { Options, SDKMessage, SDKUserMessage, Query, HookCallback, WarmQuery } from '@anthropic-ai/claude-agent-sdk';

/**
 * The SDK delivers outputFormat json_schema through a built-in tool of this
 * name. It appears as a tool_use block and reaches PreToolUse hooks, so the
 * filler and the per-turn tool cap must both ignore it (SPIKE.md, Q4).
 */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
