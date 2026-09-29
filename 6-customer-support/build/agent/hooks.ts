import { config } from '../lib/config.ts';
import { STRUCTURED_OUTPUT_TOOL, type HookCallback } from './sdk.ts';
import type { SessionState } from './runtime.ts';

const LOOKUPS = new Set(['mcp__relaypay__lookup_customer', 'mcp__relaypay__lookup_transaction', 'mcp__relaypay__lookup_payout']);

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
});

/**
 * Every per-call rule on tool use lives here, in code, and not in the prompt.
 * canUseTool cannot hold them: the SDK approves allowedTools entries before
 * that callback is consulted (SPIKE.md). The reasons are sentences the model
 * can act on, because a denial it cannot understand becomes a retry loop.
 */
export function makePreToolUseHook(state: SessionState, hasOpenEscalation: (conversationId: string) => Promise<boolean>): HookCallback {
  return (async (input: any) => {
    const tool = String(input?.tool_name ?? '');
    // The reply itself arrives through this tool. Blocking or counting it would block the answer.
    if (tool === STRUCTURED_OUTPUT_TOOL) return {};
    if (state.budgetExhausted) return deny('This call has reached its budget. Do not call tools; reply with what you have, or decline.');
    if (state.toolCallsThisTurn >= config.agent.maxToolCallsPerTurn)
      return deny(`At most ${config.agent.maxToolCallsPerTurn} tool calls per turn. Reply now with what you already know.`);
    if (LOOKUPS.has(tool) && (await hasOpenEscalation(state.conversationId)))
      return deny('An escalation is open for this call. Stop troubleshooting: do not look anything up, confirm the hand-off instead.');
    state.toolCallsThisTurn++;
    return {};
  }) as HookCallback;
}
