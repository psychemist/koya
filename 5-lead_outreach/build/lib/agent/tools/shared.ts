import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorForAgent } from '../../errors.ts';

/** Every tool takes these two. `purpose` is what makes the audit log readable:
 *  the agent states why it is calling, and that string lands in the row. */
export const baseArgs = {
  run_id: z.string().uuid(),
  purpose: z.string().describe('Why you are making this call. Recorded in the audit log.'),
};

export const ok = (payload: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
});

/** Compose the message Claude reads, rather than leaking a raw exception. */
export const failed = (e: unknown): CallToolResult => ({
  content: [{ type: 'text', text: errorForAgent(e) }],
  isError: true,
});

export const refused = (reason: string): CallToolResult => ({
  content: [{ type: 'text', text: reason }],
  isError: true,
});
