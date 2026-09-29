import { config } from '../../../../lib/config.ts';

export const dynamic = 'force-dynamic';

/**
 * Asked before the Start call button is enabled. The page learns only whether
 * a call can start, never where the agent lives or how it is doing inside.
 */
export async function GET(): Promise<Response> {
  const answer = (body: object) => Response.json(body, { headers: { 'cache-control': 'no-store' } });
  try {
    const res = await fetch(`${config.web.agentUrl}/health`, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!res.ok) return answer({ available: false, reason: 'down' });
    const h = (await res.json()) as { ok?: boolean; capacity?: number };
    if (!h.ok) return answer({ available: false, reason: 'down' });
    return answer(h.capacity && h.capacity > 0 ? { available: true } : { available: false, reason: 'busy' });
  } catch {
    return answer({ available: false, reason: 'down' });
  }
}
