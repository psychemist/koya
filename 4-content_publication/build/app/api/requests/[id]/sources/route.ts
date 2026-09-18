import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const Body = z.object({ sourceId: z.string().uuid(), selected: z.boolean() });

/**
 * Which sources actually feed the excerpt pool, as a human decision.
 *
 * Every excerpt is automatically marked `selected` at extraction time based
 * on a relevance score, and until now that score was the only voice in the
 * room. This lets the person who raised the request override it: exclude a
 * source that scored well but that they do not trust, or bring back one that
 * scored just under the line and that they know is actually the best thing
 * in the pile.
 *
 * ONLY BEFORE AN ANGLE HAS BEEN WRITTEN. The same reasoning as the
 * attachments route: an angle and a draft are written from a specific
 * corpus, and changing the corpus afterwards would leave a draft citing
 * excerpts from a pool that no longer matches what produced it.
 *
 * A quarantined source can never be turned on. Quarantine is a security
 * decision, not a preference, and `selectedExcerpts()` already excludes a
 * quarantined source's excerpts regardless of this flag — refusing the
 * toggle here as well is what keeps the screen from claiming a control it
 * does not actually have.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle('sources.toggle', async (cid) => {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw Errors.validation('That change could not be read.');
    const input = parsed.data;

    const r = await one<{ requester_id: string; status: string }>(
      `select requester_id, status from public.content_requests where id=$1`, [id]);
    if (!r) throw Errors.notFound('Request');
    if (r.requester_id !== user.id && !['editor', 'admin'].includes(user.role)) {
      throw Errors.forbidden();
    }
    if (!['draft', 'research_failed', 'angles_ready'].includes(r.status)) {
      throw Errors.conflict(
        `This request is ${r.status.replace(/_/g, ' ')}, so its sources are settled. ` +
        `Changing which ones are used now would leave a draft citing excerpts from a ` +
        `pool that no longer matches what it was written from.`);
    }

    const source = await one<{ quarantined: boolean; submitted_url: string }>(
      `select quarantined, submitted_url from public.sources
        where id=$1 and request_id=$2`, [input.sourceId, id]);
    if (!source) throw Errors.notFound('Source');
    if (source.quarantined && input.selected) {
      throw Errors.blocked(
        'This source was quarantined for prompt injection markers. It cannot be turned back ' +
        'on from here; that decision is a security control, not a preference.');
    }

    const updated = await query<{ id: string }>(
      `update public.excerpts set selected=$2
        where source_id=$1 returning id`, [input.sourceId, input.selected]);

    await event({
      correlationId: cid, requestId: id, actorId: user.id, stage: 'sources.toggle',
      outcome: 'ok',
      detail: { sourceId: input.sourceId, url: source.submitted_url,
                selected: input.selected, excerpts: updated.length },
    });

    return { sourceId: input.sourceId, selected: input.selected, excerpts: updated.length };
  });
}
