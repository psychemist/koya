import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, query, advance } from '@/lib/db';
import { approve, evidenceBundle } from '@/lib/pipeline/approve';
import { enqueue } from '@/lib/pipeline/queue';
import { notify } from '@/lib/notify';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';
import { activeSubscriberEmails } from '@/lib/subscribers';
import { stripCitations } from '@/lib/publish/citations';
import { stripUrls, xPostCost } from '@/lib/publish/links';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.enum(['article', 'linkedin', 'x', 'newsletter']),
  decision: z.enum(['approved', 'changes_requested', 'rejected']),
  note: z.string().max(2000).optional(),
  /** What the reviewer's screen actually rendered. Compared server-side. */
  evidenceHash: z.string().min(16),
  expectedVersion: z.number().int(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle('approve', async (cid) => {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      // A bare .parse() throws a ZodError, which `handle` reports as a 500
      // "something went wrong" - the least useful possible answer to a
      // reviewer whose page is simply out of date.
      throw Errors.validation(
        'That decision could not be read. Reload the review screen and try again.');
    }
    const input = parsed.data;

    // Recompute the bundle server-side and compare. A client that sends a hash
    // of something it did not render defeats the whole point of hashing it —
    // the claim being made is "this person saw THIS", so the server has to
    // verify the "this".
    const { hash } = await evidenceBundle(id, input.kind);
    if (hash !== input.evidenceHash) {
      throw Errors.conflict(
        'The content changed while you were reviewing it. Reload and read the current ' +
        'version before approving. The approval record has to name what you actually saw.');
    }

    const result = await approve({
      requestId: id, kind: input.kind, actorId: user.id, actorRole: user.role,
      decision: input.decision, note: input.note, evidenceHash: hash,
      expectedVersion: input.expectedVersion,
    });

    await event({ correlationId: cid, requestId: id, actorId: user.id,
      stage: 'approve', outcome: 'ok',
      detail: { kind: input.kind, decision: input.decision,
                revision: result.revision, soloOverride: result.soloOverride } });

    if (input.decision === 'changes_requested') {
      await advance(id, ['needs_review', 'needs_human'], 'changes_requested');
      await notify({
        kind: 'changes_requested', requestId: id, correlationId: cid,
        title: `Changes requested on the ${input.kind}`,
        lines: [input.note ?? '(no note given)', `**Reviewer:** ${user.name}`],
        to: await requesterOf(id),
      });
      return { decision: input.decision };
    }

    if (input.decision === 'rejected') {
      await advance(id, ['needs_review', 'needs_human'], 'rejected');
      await notify({
        kind: 'rejected', requestId: id, correlationId: cid,
        title: `The ${input.kind} was rejected`,
        lines: [input.note ?? '(no note given)', `**Reviewer:** ${user.name}`],
        to: await requesterOf(id),
      });
      return { decision: input.decision };
    }

    // ---- approved: queue anything that is fully signed off ----
    const r = await one<any>(`select * from public.content_requests where id=$1`, [id]);
    const channels: string[] = r.channels ?? [];
    const approvedKinds = (await query<{ asset_kind: string }>(
      `select distinct asset_kind from public.approvals
        where request_id=$1 and decision='approved'`, [id])).map((a) => a.asset_kind);

    const ready = channels.filter((c) => approvedKinds.includes(c));
    const dueAt = r.scheduled_for ? new Date(r.scheduled_for) : new Date();

    /*
     * Read at queue time from the subscriber list, not from the request.
     *
     * The previous line was `recipients: r.newsletter_recipients ?? []`,
     * naming a column that has never existed on content_requests. Postgres
     * does not return it, pg gives undefined, and the `??` turns a missing
     * COLUMN into an empty array as smoothly as it would have turned a missing
     * value into one. So the newsletter lane could not have delivered a single
     * email, and the only symptom was a queue row reading `blocked` with a
     * code nobody had cause to look at.
     */
    const subscribers = channels.includes('newsletter')
      ? await activeSubscriberEmails().catch(() => [])
      : [];

    /**
     * REPORT THE CHANNELS THAT WERE ACTUALLY QUEUED, NOT THE ONES CONSIDERED.
     *
     * The previous version wrote "Queued for: linkedin, x" from `ready`, the
     * list of approved channels, while the loop below skips X whenever the
     * request did not opt into paying for it and skips any channel whose
     * asset is missing. So the notification told the requester their X post
     * was scheduled when the queue held no such row, in a system whose entire
     * claim is that it never reports a success it did not achieve. A tracked
     * list costs one array.
     */
    const queuedChannels: string[] = [];
    const skipped: { channel: string; reason: string }[] = [];

    for (const channel of ready) {
      // X is opt-in per request: $0.20 a post with a link is roughly 45% of
      // what producing the whole pack costs, so it is never a silent default.
      if (channel === 'x' && !r.publish_to_x) {
        skipped.push({ channel, reason: 'not opted in to paid X publishing' });
        continue;
      }

      const asset = await one<any>(
        `select revision, body, subject_line from public.assets
          where request_id=$1 and kind=$2 order by revision desc limit 1`, [id, channel]);
      if (!asset) {
        skipped.push({ channel, reason: 'no asset exists for this channel' });
        continue;
      }

      if (channel === 'newsletter' && subscribers.length === 0) {
        skipped.push({ channel, reason: 'nobody is subscribed to the newsletter' });
        continue;
      }

      /*
       * THE PUBLISH BOUNDARY. Two things come off here and nowhere else.
       *
       * Citation markers, because they are apparatus. `[S1d20P1]` is an
       * excerpt label the grounding check reads and the reviewer needs to
       * follow a figure back to the bytes it came from. It is not something a
       * reader should ever see, and the previous version queued `asset.body`
       * verbatim, so they were on their way onto a client's feed.
       *
       * The link on an X post, when the request said not to pay for it. X
       * bills $0.015 a post and $0.20 if it contains one.
       *
       * Both are done to the QUEUED COPY, never to the asset. The approval
       * names an exact revision and a hash of what was on screen; editing the
       * stored asset here would void the approval that was just given, one
       * line after giving it.
       */
      let body = stripCitations(asset.body);
      if (channel === 'x' && !r.x_include_link) body = stripUrls(body);

      const row = await enqueue({
        requestId: id, channel: channel as any, assetRevision: asset.revision,
        payload: {
          requestId: id,
          body,
          subjectLine: asset.subject_line,
          recipients: subscribers,
          // Recorded on the row so the queue page can show what this one post
          // is about to cost, rather than quoting a rate card.
          ...(channel === 'x' ? { estimatedCostUsd: xPostCost(body) } : {}),
        },
        dueAt,
      });
      // No row means the deterministic idempotency key already existed, so it
      // is queued - by an earlier call, not this one.
      if (row) queuedChannels.push(channel);
      else skipped.push({ channel, reason: 'already queued' });
    }

    const queued = queuedChannels.length;
    if (queued > 0) await advance(id, ['needs_review', 'needs_human'], 'scheduled');

    await notify({
      kind: 'approved', requestId: id, correlationId: cid,
      title: `${input.kind} approved by ${user.name}`,
      lines: [
        `**Revision:** ${result.revision}`,
        result.soloOverride
          ? `**Solo-operator override was used.** The requester approved their own work.`
          : `**Separation of duties held.** Approved by someone other than the author.`,
        queued
          ? `**Queued for:** ${queuedChannels.join(', ')} at ${dueAt.toISOString()}`
          : 'Nothing was queued by this approval.',
        skipped.length
          ? `**Not queued:** ${skipped.map((s) => `${s.channel} (${s.reason})`).join(', ')}`
          : '',
        input.note ? `**Note:** ${input.note}` : '',
      ].filter(Boolean),
      to: await requesterOf(id),
    });

    return {
      decision: 'approved', revision: result.revision, queued,
      queuedChannels, skipped, soloOverride: result.soloOverride,
    };
  });
}

async function requesterOf(requestId: string) {
  return query<{ email: string; name: string; role: string }>(
    `select u.email, u.name, u.role from public.content_requests r
      join public.users u on u.id=r.requester_id where r.id=$1`, [requestId]);
}
