import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';
import { addSubscriber, setSubscriberStatus } from '@/lib/subscribers';

export const dynamic = 'force-dynamic';

const Add = z.object({
  action: z.literal('add'),
  email: z.string().max(320),
  name: z.string().max(120).optional(),
});

const SetStatus = z.object({
  action: z.literal('status'),
  id: z.string().uuid(),
  status: z.enum(['active', 'unsubscribed']),
});

const Body = z.discriminatedUnion('action', [Add, SetStatus]);

/**
 * The subscriber list, which is personal data and is treated as such.
 *
 * Admin only, and every change is written to the audit log with the actor. The
 * question this table has to be able to answer is not "who is on the list" but
 * "who put them there and when", because the one mistake here with a legal
 * consequence is mailing somebody who asked to be left alone.
 *
 * Nothing is ever deleted. Unsubscribing sets a status and a timestamp, so
 * re-adding that address later can be refused rather than silently honoured.
 */
export async function POST(req: Request) {
  return handle('admin.subscribers', async (cid) => {
    const user = await requireUser();
    // 404 rather than 403: a non-admin should not learn this endpoint exists.
    if (user.role !== 'admin') throw Errors.forbidden();

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw Errors.validation('That change could not be read.');
    const input = parsed.data;

    if (input.action === 'add') {
      const result = await addSubscriber({
        email: input.email, name: input.name, addedBy: user.id, source: 'added on the admin page',
      });
      if (!result.ok) {
        await event({ correlationId: cid, actorId: user.id, stage: 'subscriber.add',
          outcome: 'blocked', detail: { reason: result.reason } });
        throw Errors.validation(result.reason);
      }
      await event({ correlationId: cid, actorId: user.id, stage: 'subscriber.add',
        outcome: 'ok', detail: { id: result.id } });
      return { id: result.id };
    }

    await setSubscriberStatus(input.id, input.status);
    await event({
      correlationId: cid, actorId: user.id, stage: 'subscriber.status',
      outcome: 'ok', detail: { id: input.id, status: input.status },
    });
    return { id: input.id, status: input.status };
  });
}
