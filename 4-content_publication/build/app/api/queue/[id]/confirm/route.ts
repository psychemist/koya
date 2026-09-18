import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * "I posted this myself." The closing half of the manual-posting story.
 *
 * `queued_manual` and `blocked` are both honest, deliberate states: the post
 * was researched, written, checked and approved, and either the request
 * opted out of paying for the API or no credential is configured, so a
 * person copies the text out and posts it themselves. What the queue never
 * had was a way BACK from that. Once somebody actually went to LinkedIn or X
 * and pressed Post, the row sat exactly where it started, forever
 * indistinguishable from one nobody had touched. A week later there was no
 * way to tell "still needs doing" from "already done".
 *
 * This is deliberately NOT the same claim as a provider-confirmed `sent`. No
 * message id exists, nothing here can be independently verified, and the new
 * state name says so everywhere it is shown: `sent_manually`, never `sent`.
 * The person doing the confirming is recorded by name and can always be
 * asked, which is the honest version of a claim this weak.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle('queue.confirm', async (cid) => {
    const user = await requireUser();

    const row = await one<{ id: string; state: string; channel: string; request_id: string }>(
      `select id, state, channel, request_id from public.publish_queue where id=$1`, [id]);
    if (!row) throw Errors.notFound('Queue row');

    if (!['queued_manual', 'blocked'].includes(row.state)) {
      throw Errors.conflict(
        row.state === 'sent_manually'
          ? 'This was already marked as posted by hand. Nothing changed.'
          : row.state === 'sent'
            ? 'This was already confirmed sent by the provider. There is nothing to mark.'
            : `This row is ${row.state.replace(/_/g, ' ')}, so there is nothing to confirm yet.`);
    }

    // Guarded on the state it was read at, so two people confirming the same
    // row at once cannot both succeed and both notify.
    const updated = await query<{ id: string }>(
      `update public.publish_queue
          set state='sent_manually', confirmed_by=$2, confirmed_at=now(), updated_at=now()
        where id=$1 and state=$3
        returning id`,
      [id, user.id, row.state]);

    if (!updated.length) {
      throw Errors.conflict('Someone else just recorded this. Reload to see the current state.');
    }

    await event({
      correlationId: cid, requestId: row.request_id, actorId: user.id,
      stage: 'queue.confirm_manual', outcome: 'ok',
      detail: { channel: row.channel, from: row.state },
    });

    return { id, state: 'sent_manually' };
  });
}
