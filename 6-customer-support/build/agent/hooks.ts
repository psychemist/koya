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
/** Times create_escalation offered on this turn: since the caller last spoke, so they have not had the chance to choose. */
export type OfferedThisTurn = (conversationId: string) => Promise<string[]>;
const instant = (iso: unknown) => { const t = Date.parse(String(iso ?? '')); return Number.isNaN(t) ? null : t; };

export function makePreToolUseHook(state: SessionState, hasOpenEscalation: (conversationId: string) => Promise<boolean>,
  offeredThisTurn: OfferedThisTurn = async () => []): HookCallback {
  return (async (input: any) => {
    const tool = String(input?.tool_name ?? '');
    // The reply itself arrives through this tool. Blocking or counting it would block the answer.
    if (tool === STRUCTURED_OUTPUT_TOOL) return {};
    if (state.budgetExhausted) return deny('This call has reached its budget. Do not call tools; reply with what you have, or decline.');
    if (state.toolCallsThisTurn >= config.agent.maxToolCallsPerTurn)
      return deny(`At most ${config.agent.maxToolCallsPerTurn} tool calls per turn. Reply now with what you already know.`);
    if (LOOKUPS.has(tool) && (await hasOpenEscalation(state.conversationId)))
      return deny('An escalation is open for this call. Stop troubleshooting: do not look anything up, confirm the hand-off instead.');
    // A time the tool offered because the caller's choice was taken is the caller's to pick. Booking one of them on
    // the turn it was offered books a callback nobody agreed to, so the model has to offer and wait for the answer.
    if (tool === 'mcp__relaypay__create_escalation') {
      const asked = instant(input?.tool_input?.preferred_time);
      if (asked !== null && (await offeredThisTurn(state.conversationId)).some((o) => instant(o) === asked))
        return deny('That time was only just offered and the caller has not chosen it. Do not book it yet: offer the times ' +
          'next_slots gave you, ask which one suits them, and book the one they pick on their next turn.');
    }
    state.toolCallsThisTurn++;
    return {};
  }) as HookCallback;
}
