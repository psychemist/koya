import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { event } from '@/lib/audit';
import { evaluate } from '@/lib/pipeline/evaluate';
import { Errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const Body = z.object({
  body: z.string().min(1).max(20_000),
  expectedRevision: z.number().int(),
});

/**
 * The two-pass revise loop is capped at MAX_REVISIONS (lib/pipeline/revise.ts)
 * on purpose: an escalating retry loop against a model that keeps missing the
 * same mark is a cost leak, not a fix. When it gives up, the request lands at
 * `needs_human` with a genuinely open finding — an X post at 301 characters,
 * say — and until now there was NOTHING a person could do about it except
 * regenerate from scratch and hope. `origin = 'human_edit'` has been in the
 * schema and the history display since the start; this is the route that
 * finally writes one.
 *
 * Scoped to non-article channels for now. An article's `sections` column is
 * a separate structured record the SEO gate measures per-section against —
 * a raw text edit to `body` would leave it silently out of sync with what
 * the gate is actually checking. Fixing that needs re-deriving `sections`
 * from the edited markdown, which is its own piece of work.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await ctx.params;
  return handle('asset.human_edit', async (cid) => {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      throw Errors.validation('That edit could not be read.', parsed.error.flatten());
    }

    if (kind === 'article') {
      throw Errors.validation(
        'The article cannot be hand-edited yet — only the channel posts (LinkedIn, X, ' +
        'newsletter) can be. Send the article back for changes instead.');
    }
    if (!['linkedin', 'x', 'newsletter'].includes(kind)) {
      throw Errors.notFound('Channel');
    }

    const r = await one<{ requester_id: string }>(
      `select requester_id from public.content_requests where id=$1`, [id]);
    if (!r) throw Errors.notFound('Request');

    // Same rule as writing a draft in the first place: whoever raised it, or
    // an editor. Editing is still authorship, not review.
    const canWrite = r.requester_id === user.id || ['editor', 'admin'].includes(user.role);
    if (!canWrite) {
      throw Errors.blocked(
        'Only the person who raised this request, or an editor, can edit a draft.');
    }

    const latest = await one<{ revision: number; subject_line: string | null }>(
      `select revision, subject_line from public.assets
        where request_id=$1 and kind=$2 order by revision desc limit 1`,
      [id, kind]);
    if (!latest) throw Errors.notFound('Asset');
    if (latest.revision !== parsed.data.expectedRevision) {
      throw Errors.conflict(
        'This draft changed since you started editing. Reload to see the current version.');
    }

    const nextRevision = latest.revision + 1;
    await query(
      `insert into public.assets
         (request_id, kind, revision, parent_revision, body, subject_line, origin,
          cost_usd, created_by)
       values ($1,$2,$3,$4,$5,$6,'human_edit',0,$7)`,
      [id, kind, nextRevision, latest.revision, parsed.data.body, latest.subject_line, user.id],
    );

    await event({
      correlationId: cid, requestId: id, actorId: user.id, stage: 'asset.human_edit',
      outcome: 'ok', detail: { kind, revision: nextRevision },
    });

    // Tier 0 only — a person fixing a length limit by hand did not just ask
    // for the article's prose to be re-judged at their expense.
    const result = await evaluate({ requestId: id, correlationId: cid, skipJudge: true });

    return { revision: nextRevision, blocking: result.blocking };
  });
}
