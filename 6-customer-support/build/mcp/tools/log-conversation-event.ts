import { z } from 'zod/v4';
import { query } from '../../lib/db.ts';
import type { ToolSpec } from '../define.ts';

/** The agent-writable subset. session_*, interrupted and capacity_refused are written by the system only. */
export const AGENT_EVENT_TYPES = ['path_chosen', 'clarification_requested', 'identity_verified', 'identity_failed',
  'escalation_triggered', 'declined', 'caller_frustrated', 'note'] as const;

const input = z.object({
  conversation_id: z.string().max(60).optional().describe('Ignored when the connection names the conversation.'),
  event_type: z.enum(AGENT_EVENT_TYPES),
  summary: z.string().trim().min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).optional()
    .refine((m) => !m || JSON.stringify(m).length <= 2048, { message: 'metadata must be at most 2 KB' }),
});

export const eventTool: ToolSpec<typeof input> = {
  name: 'log_conversation_event',
  description: 'Record a notable moment for the support review log, for example caller_frustrated or declined.',
  input, readOnly: false,
  async run(args, conversationId) {
    await query(`insert into public.conversation_events (conversation_id, event_type, source, summary, metadata)
      values ($1, $2, 'agent', $3, $4)`, [conversationId, args.event_type, args.summary, JSON.stringify(args.metadata ?? {})]);
    const result = { logged: true };
    return { result, summary: { logged: true, event_type: args.event_type } };
  },
};
