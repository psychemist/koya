import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, query, advance } from '@/lib/db';
import { draftArticle, adaptChannels } from '@/lib/pipeline/generate';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({ angleId: z.string().uuid() });

/**
 * Human gate 1 has just closed: an angle was chosen. Everything from here to
 * `needs_review` runs without a person, and then stops dead until one acts.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle('generate', async (cid) => {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      // A bare .parse() throws a ZodError, which `handle` cannot recognise and
      // reports as a 500 "something went wrong" - an unfixable-looking answer
      // to an entirely fixable input problem.
      throw Errors.validation('Pick one of the three angles before generating.');
    }
    const { angleId } = parsed.data;

    const r = await one<any>(`select * from public.content_requests where id=$1`, [id]);
    if (!r) throw Errors.notFound('Request');
    if (r.requester_id !== user.id && !['editor', 'admin'].includes(user.role)) {
      throw Errors.forbidden();
    }

    const angle = await one<any>(
      `select * from public.angles where id=$1 and request_id=$2`, [angleId, id]);
    if (!angle) throw Errors.notFound('Angle');

    // Ahrefs: a SUPPORTING long-tail belongs inside a broader article. Building
    // a 3,000-word piece around one is thin content — caught here, before the
    // expensive call, not after.
    if (angle.keyword_class === 'supporting') {
      throw Errors.blocked(
        `"${angle.primary_keyword}" is a supporting long-tail keyword. It belongs inside a ` +
        `broader article rather than carrying one. Pick a topical angle, or re-plan.`);
    }

    /*
     * WRITING A SECOND ANGLE IS A NORMAL THING TO WANT.
     *
     * The start states used to be `angles_ready` and `changes_requested` only,
     * so the moment a draft existed the other two angles were unreachable: the
     * picker stopped rendering and no route would accept the request back. The
     * planner had produced three outlines and paid Opus to do it, and two of
     * them could only ever be read, never used. Deciding an angle was wrong is
     * the most ordinary review outcome there is.
     *
     * `needs_review`, `needs_human` and `rejected` are therefore starting
     * points too. Nothing about the safety of this changes: writing produces a
     * NEW revision, every previous revision is retained, and an approval names
     * the exact revision it applies to, so a rewrite voids an approval by the
     * mechanism that already existed rather than by a new one.
     *
     * `scheduled` and `published` are deliberately not here. Rewriting after
     * something has gone out is not a rewrite, it is a correction, and it
     * needs a decision this button does not ask for.
     */
    const moved = await advance(
      id,
      ['angles_ready', 'changes_requested', 'needs_review', 'needs_human', 'rejected'],
      'drafting', {}, r.version);
    if (!moved) {
      throw Errors.conflict(
        'This request has moved on since the page was loaded. Reload it. ' +
        'Nothing was written and nothing was spent.');
    }

    // One angle at a time is selected. Without this the workspace shows two
    // angles both claiming to be the one being written.
    await query(
      `update public.angles set selected_by=null, selected_at=null where request_id=$1`, [id]);

    await query(`update public.angles set selected_by=$2, selected_at=now() where id=$1`,
      [angleId, user.id]);

    const band: [number, number] = [r.section_target_min ?? 700, r.section_target_max ?? 800];

    /**
     * A FAILURE HERE MUST LEAVE THE REQUEST SOMEWHERE A PERSON CAN ACT.
     *
     * This is the defect the first real run found. The draft call returned
     * `stop_reason: max_tokens`, the error propagated out of the handler, and
     * the request stayed at `drafting` with $0.196 spent and no assets. Every
     * route that could move it on requires a different status, the angle was
     * already marked selected so the picker stopped rendering, and the screen
     * offered no control of any kind. The work was not so much lost as
     * unreachable, which is worse, because nothing said so.
     *
     * So the status is wound back to `angles_ready` and the selection is
     * cleared, which is a state the user can act from. The failed attempt
     * stays in `events` under its correlation ID, the money already spent
     * stays counted on the request, and the workspace reads the failure back
     * out and offers the retry.
     */
    let channels: Awaited<ReturnType<typeof adaptChannels>>;
    try {
      await draftArticle({ requestId: id, angleId, band, actorId: user.id, correlationId: cid });
      channels = await adaptChannels({
        requestId: id, channels: r.channels ?? [], actorId: user.id, correlationId: cid,
      });

      /*
       * THE ROUTE ENDS HERE. Evaluation and revision belong to the heartbeat.
       *
       * This request has already spent an average of 165s on draft and adapt,
       * and 247s on its worst measured run, against a 300s ceiling. A revision
       * pass is another full-article generation at roughly 146s, so running
       * the loop from here could not fit and did not: the process was killed
       * mid-pass, the catch below never ran because there was no process left
       * to run it, and the request sat at `evaluating` with a finished draft
       * that no route would accept and nobody could approve.
       *
       * Leaving it at `evaluating` is now a HANDOFF rather than a dead end.
       * The queue tick claims it, runs as much of the loop as fits in its own
       * budget, and either finishes it or leaves it for the next tick. The
       * pass counters are reset here because this is a new generation: a
       * rewrite of a different angle must not inherit the previous one's
       * spent budget.
       */
      await advance(id, 'drafting', 'evaluating', {
        revise_passes: 0, revise_discarded_worse: false,
      });
    } catch (e) {
      await advance(id, ['drafting', 'evaluating'], 'angles_ready');
      await query(
        `update public.angles set selected_by=null, selected_at=null where request_id=$1`, [id]);
      await event({
        correlationId: cid, requestId: id, actorId: user.id,
        stage: 'generate.rolled_back', outcome: 'failed',
        detail: { angleId, error: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }

    const fresh = await one<{ cost_usd: string }>(
      `select cost_usd from public.content_requests where id=$1`, [id]);

    /*
     * No notification here, deliberately.
     *
     * The only thing worth telling anybody is the VERDICT — ready to review,
     * or still blocking and needs a person — and at this point nothing has
     * judged the draft yet. Announcing "your draft is ready" before the
     * checks have run is the kind of notification people learn to ignore.
     * The tick sends it when it has something true to say.
     */
    return {
      status: 'evaluating',
      channelFailures: channels.failures,
      costUsd: Number(fresh?.cost_usd ?? 0),
    };
  });
}
