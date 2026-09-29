import { foreignOrigin, userFromRequest } from './auth.ts';
import { canTransition, changeStatus, currentStatus, type Status } from './console.ts';

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const STATUSES = new Set(['open', 'in_progress', 'closed']);

/** Shared by the escalation and ticket status routes: signed in, same origin, a legal move, and still in the status the person saw. */
export async function statusChange(table: 'escalations' | 'support_tickets', req: Request, id: string): Promise<Response> {
  if (foreignOrigin(req)) return json(403, { error: 'Status changes are only accepted from the console.' });
  const user = await userFromRequest(req);
  if (!user) return json(401, { error: 'Sign in to change a status.' });
  const b = (await req.json().catch(() => ({}))) as { from?: string; to?: string };
  if (!STATUSES.has(b.from ?? '') || !STATUSES.has(b.to ?? '')) return json(400, { error: 'from and to must be open, in_progress or closed.' });
  if (!canTransition(b.from as Status, b.to as Status)) return json(422, { error: `A ${b.from} record cannot move to ${b.to}.` });
  const row = await changeStatus(table, id, b.from as Status, b.to as Status);
  if (!row) {
    const now = await currentStatus(table, id);
    if (!now) return json(404, { error: 'Not found.' });
    return json(409, { error: `It is already ${now.replace('_', ' ')}; refresh to see the latest.`, status: now });
  }
  return json(200, row);
}
