import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { waiveFlag } from '@/lib/pipeline/approve';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().min(1).max(2000) });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; flagId: string }> },
) {
  const { id, flagId } = await ctx.params;
  return handle('flag.waive', async (cid) => {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      throw Errors.validation('A waiver needs a written reason.');
    }

    await waiveFlag({
      flagId, requestId: id, actorId: user.id, actorRole: user.role,
      reason: parsed.data.reason,
    });

    await event({ correlationId: cid, requestId: id, actorId: user.id,
      stage: 'flag.waive', outcome: 'ok', detail: { flagId } });

    return { id: flagId, status: 'waived' };
  });
}
