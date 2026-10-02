import { config } from './config.ts';

/** Tells the agent a chat is over. Best effort: if the agent cannot be reached, the idle sweep ends the conversation anyway. */
export async function endAgentChat(conversationId: string, reason: string): Promise<void> {
  await fetch(`${config.web.agentUrl}/chat/end`, { method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${config.agent.internalToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, reason }) }).catch(() => undefined);
}
