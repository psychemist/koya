import { z } from 'zod/v4';
import { toToolError } from '../lib/errors.ts';
import { currentContext, resolveConversation } from './context.ts';
import { withToolCall } from './toolcall.ts';
import type { McpServer } from './sdk.ts';

export type ToolSpec<S extends z.ZodObject<any>> = { name: string; description: string; input: S; readOnly: boolean;
  run(args: z.infer<S>, conversationId: string, opts?: { now?: Date }): Promise<{ result: object; summary: Record<string, unknown> }> };

const PURPOSE = z.string().max(200).optional().describe('One short sentence: why you are calling this tool.');

export function register(server: McpServer, spec: ToolSpec<any>) {
  server.registerTool(spec.name, {
    description: spec.description,
    inputSchema: spec.input.extend({ purpose: PURPOSE }),
    annotations: { readOnlyHint: spec.readOnly },
  }, async (args: any) => {
    const { purpose, ...rest } = args ?? {};
    let conversationId: string | null = null;
    try {
      const resolved = await resolveConversation(currentContext(), rest.conversation_id);
      conversationId = resolved.id;
      const result = await withToolCall(conversationId, spec.name, purpose, { ...rest, conversation_mismatch: resolved.mismatch || undefined },
        () => spec.run(rest, resolved.id));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (e) {
      const te = toToolError(e);
      if (!conversationId) await withToolCall(null, spec.name, purpose, rest, async () => { throw te; }).catch(() => {});
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: te.code, message: te.message, ...te.details } }) }] };
    }
  });
}
