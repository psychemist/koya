import { config } from '../lib/config.ts';
import { connectHttpClient } from '../mcp/sdk.ts';

/** Runs the knowledge search for a caller's words before the model sees them; null when there is nothing to add. */
export type Prefetch = (conversationId: string, text: string) => Promise<string | null>;

const QUESTION = /^(what|whats|how|why|when|where|which|who|can|could|do|does|did|is|are|will|would|should|tell me|explain)\b/;
const REFERENCE = /\b(txn|pay|cus)[\s-]*\d{3,}\b/i;
const EMAIL = /@|\bat\b.*\bdot\b/i;

/**
 * A product or policy question is worth searching before the model asks for it:
 * that saves a whole model round trip. A reference or an email is a lookup or an
 * identity turn, and a short reply ("yes", "my name is Ada") answers the agent,
 * so those skip the search rather than add its time to a turn that will not use it.
 */
export function shouldPrefetch(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.split(/\s+/).length < 4 || REFERENCE.test(t) || EMAIL.test(t)) return false;
  return t.includes('?') || QUESTION.test(t.replace(/^(hi|hello|hey|ok|okay|so|and|um|uh)[,\s]+/, ''));
}

type Chunk = { id: string; heading: string; content: string; grounded: boolean };

/** The search result as the turn message carries it: the same chunks the tool would have returned. */
export function formatKnowledge(r: { grounded: boolean; chunks: Chunk[] }): string {
  const lines = [`[Knowledge search, already run on this turn for the caller's words: grounded ${r.grounded}]`];
  for (const c of r.chunks) lines.push(`(${c.id}, grounded ${c.grounded}) ${c.heading}: ${c.content}`);
  lines.push('[End of knowledge search]');
  return lines.join('\n');
}

/**
 * Through the MCP server, not around it: the tool_calls row it writes is what
 * the reply gate reads as "grounded on this turn", exactly as if the model had
 * called the tool. Any failure returns null and the model searches for itself.
 */
export function mcpPrefetch(opts: { timeoutMs?: number } = {}): Prefetch {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return async (conversationId, text) => {
    if (!shouldPrefetch(text)) return null;
    let client: Awaited<ReturnType<typeof connectHttpClient>> | null = null;
    const work = (async () => {
      client = await connectHttpClient(config.agent.mcpUrl, { authorization: `Bearer ${config.agent.mcpToken}`, 'x-conversation-id': conversationId });
      const r: any = await client.callTool({ name: 'search_knowledge_base',
        arguments: { query: text.trim().slice(0, 300), purpose: 'Prefetched for the caller question before the model turn.' } });
      if (r.isError) return null;
      const out = JSON.parse(r.content?.[0]?.text ?? 'null');
      return out && Array.isArray(out.chunks) && out.chunks.length ? formatKnowledge(out) : null;
    })();
    const timeout = new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null).unref());
    try { return await Promise.race([work, timeout]); }
    catch { return null; }
    finally { work.catch(() => null).finally(() => (client as any)?.close?.().catch?.(() => {})); }
  };
}
