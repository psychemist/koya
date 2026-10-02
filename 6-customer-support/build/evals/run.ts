import type { Scenario } from './grade.ts';

export type Reply = { status: number; json: any };
export type Post = (path: string, body: Record<string, unknown>) => Promise<Reply>;

/**
 * Plays one scenario against the agent's /chat. Every turn after the first
 * continues the conversation the first one opened. For row 24 the last turn is
 * posted again WITH that conversation id, the way a Vapi reconnect re-posts
 * the same call, and both replies must match.
 */
export async function runScenario(s: Scenario, runId: string, model: string, rawPost: Post): Promise<{ conversationId: string | null; error?: string }> {
  // A network drop or a timeout fails this scenario with its reason; it must never end the whole run.
  const post: Post = async (path, body) => { try { return await rawPost(path, body); }
    catch (e) { return { status: 0, json: { error: `${(e as Error).name}: ${(e as Error).message}` } }; } };
  let conversationId: string | null = null;
  for (const [i, message] of s.turns.entries()) {
    const body = (): Record<string, unknown> => ({ channel: 'eval', message, model, eval_run_id: runId,
      ...(s.fault ? { fault: s.fault } : {}), ...(conversationId ? { conversation_id: conversationId } : {}) });
    const first = await post('/chat', body());
    if (first.status !== 200) return { conversationId, error: `turn ${i + 1}: agent answered ${first.status} ${JSON.stringify(first.json).slice(0, 160)}` };
    conversationId = first.json.conversation_id;
    if (s.repeatLastTurn && i === s.turns.length - 1) {
      const again = await post('/chat', body());
      if (again.status !== 200) return { conversationId, error: `re-post: agent answered ${again.status}` };
      if (again.json.reply !== first.json.reply) return { conversationId, error: 'the re-posted turn got a different reply' };
    }
  }
  if (conversationId) await post('/chat/end', { conversation_id: conversationId, reason: 'eval_end' });
  return { conversationId };
}
