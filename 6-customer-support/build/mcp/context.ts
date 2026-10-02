import { AsyncLocalStorage } from 'node:async_hooks';
import { one } from '../lib/db.ts';
import { ToolError } from '../lib/errors.ts';
import { upsertConversation } from '../lib/conversations.ts';

export type RequestContext = { conversationId: string | null; fault: 'calendar_down' | null };
const als = new AsyncLocalStorage<RequestContext>();
export const withRequestContext = <T>(ctx: RequestContext, fn: () => T) => als.run(ctx, fn);
export const currentContext = (): RequestContext => als.getStore() ?? { conversationId: null, fault: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The transport's conversation id wins. The model's argument is used only when no transport id exists. */
export async function resolveConversation(ctx: RequestContext, argId?: string): Promise<{ id: string; mismatch: boolean }> {
  const exists = async (id: string) => UUID.test(id) && !!(await one('select 1 from public.conversations where id = $1', [id]));
  if (ctx.conversationId) {
    if (!(await exists(ctx.conversationId))) throw new ToolError('CONVERSATION_UNKNOWN', 'The conversation for this connection does not exist.');
    return { id: ctx.conversationId, mismatch: !!argId && argId !== ctx.conversationId };
  }
  if (argId && (await exists(argId))) return { id: argId, mismatch: false };
  const c = await upsertConversation({ channel: 'mcp_direct', callerIdentifier: 'mcp' });
  return { id: c.id, mismatch: false };
}
