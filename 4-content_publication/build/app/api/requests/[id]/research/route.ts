import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, advance } from '@/lib/db';
import { runResearch } from '@/lib/pipeline/research';
import { planAngles } from '@/lib/pipeline/generate';
import { notify } from '@/lib/notify';
import { Errors } from '@/lib/errors';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({ sourceUrls: z.array(z.string().url()).max(10).default([]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle('research', async (cid) => {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    const urls = parsed.success ? parsed.data.sourceUrls : [];

    const r = await one<any>(`select * from public.content_requests where id=$1`, [id]);
    if (!r) throw Errors.notFound('Request');

    const moved = await advance(id, ['draft', 'research_failed'], 'researching', {}, r.version);
    if (!moved) throw Errors.conflict('This request is already being researched.');

    let outcome;
    try {
      outcome = await runResearch({
        requestId: id, correlationId: cid, idea: r.idea, audience: r.audience,
        keywordHint: r.keyword_hint, urls, sourcesOnly: Boolean(r.sources_only),
      });
    } catch (e) {
      await advance(id, 'researching', 'research_failed');
      await notify({
        kind: 'research_failed', requestId: id, correlationId: cid,
        title: 'Research failed',
        lines: [`Nothing was drafted. ${e instanceof Error ? e.message : String(e)}`,
                `Correlation ID: \`${cid}\``],
        to: [{ email: (await requesterEmail(id))!, role: 'manager' }],
      });
      throw e;
    }

    // No corpus, no article. Drafting from nothing produces confident prose
    // about nothing, which is the single worst output this system could make.
    if (outcome.ok === 0) {
      await advance(id, 'researching', 'research_failed');
      await notify({
        kind: 'research_failed', requestId: id, correlationId: cid,
        title: 'Research found no usable sources',
        lines: [
          `${outcome.failed} source(s) failed, ${outcome.quarantined} quarantined for prompt injection.`,
          `Nothing was drafted. Add a source URL by hand to continue.`,
        ],
        to: [{ email: (await requesterEmail(id))!, role: 'manager' }],
      });
      return { ...outcome, status: 'research_failed' };
    }

    await advance(id, 'researching', 'planning');

    /*
     * A THROW HERE MUST NOT LEAVE THE REQUEST WEDGED AT 'planning' FOREVER.
     *
     * This was the exact defect a real run found: `planAngles` throws "No
     * usable excerpts" when every extracted excerpt scored below the
     * relevance threshold, which is precisely what happens when the idea has
     * nothing real behind it (an invented premise like "humans have four
     * legs" produces sources, if any, that Haiku correctly scores as barely
     * relevant). The status had already moved to `planning` on the line
     * above, and with no catch here the exception passed straight through to
     * `handle()`, which reports a 500 and does nothing about the status.
     * `planning` is a transient state the live-progress view polls on, so the
     * request sat there being polled every 2.5 seconds, forever, with no
     * route willing to accept a wind-back from it and no way for a person to
     * act. That is the "calling the page over and over" report.
     */
    let plan;
    try {
      plan = await planAngles({
        requestId: id, idea: r.idea, audience: r.audience, goal: r.goal,
        keywordHint: r.keyword_hint, band: outcome.band, correlationId: cid,
      });
    } catch (e) {
      await advance(id, 'planning', 'research_failed');
      const noUsableExcerpts = e instanceof Error && /No usable excerpts/.test(e.message);
      const message = noUsableExcerpts
        ? 'None of the sources actually support this idea, so there is nothing to plan an ' +
          'angle from. If the idea rests on a claim that conflicts with well-established fact, ' +
          'no source will ever supply one. Otherwise, supply a source yourself.'
        : `Planning failed. ${e instanceof Error ? e.message : String(e)}`;
      await notify({
        kind: 'research_failed', requestId: id, correlationId: cid,
        title: 'Planning could not produce any angles',
        lines: [message, `Correlation ID: \`${cid}\``],
        to: [{ email: (await requesterEmail(id))!, role: 'manager' }],
      });
      throw new Error(message);
    }
    await advance(id, 'planning', 'angles_ready');

    await notify({
      kind: 'angles_ready', requestId: id, correlationId: cid,
      title: 'Three angles are ready to pick from',
      lines: [
        `**Sources used:** ${outcome.ok}` +
          (outcome.failed ? ` · **failed:** ${outcome.failed}` : '') +
          (outcome.quarantined ? ` · **quarantined:** ${outcome.quarantined}` : ''),
        `**Section depth band:** ${outcome.band[0]}–${outcome.band[1]} words ` +
          `(${outcome.bandSource === 'measured'
            ? `measured from ${outcome.comparables} competing articles`
            : 'fallback, fewer than 3 comparable articles were found'})`,
        `Nothing is written until you choose an angle.`,
      ],
      to: [{ email: (await requesterEmail(id))!, name: user.name, role: 'manager' }],
      path: `/requests/${id}`,
    });

    return { ...outcome, angles: plan.count, status: 'angles_ready' };
  });
}

async function requesterEmail(requestId: string) {
  const r = await one<{ email: string }>(
    `select u.email from public.content_requests r join public.users u on u.id=r.requester_id
      where r.id=$1`, [requestId]);
  return r?.email;
}
