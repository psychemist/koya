import { z } from 'zod';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { query, one } from '@/lib/db';
import { event } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { Errors } from '@/lib/errors';
import { checkPremise } from '@/lib/pipeline/premise-check';

export const dynamic = 'force-dynamic';

const Intake = z.object({
  idempotencyKey: z.string().min(8).max(200),
  idea: z.string().min(10).max(2000),
  audience: z.string().min(3).max(300),
  goal: z.enum(['awareness', 'demand', 'thought_leadership']),
  channels: z.array(z.enum(['linkedin', 'x', 'newsletter'])).min(1),
  sourceUrls: z.array(z.string().url()).max(10).default([]),
  keywordHint: z.string().max(120).optional(),
  tone: z.string().max(200).optional(),
  scheduledFor: z.string().datetime().optional(),
  publishToX: z.boolean().default(false),
  /**
   * X bills $0.015 a post and $0.20 if it contains a link, so this one boolean
   * is a thirteenfold price difference. Defaults true because the link is what
   * the post is for; the link comes off at the publish boundary when it is
   * false, rather than the writer being asked for a different post.
   */
  xIncludeLink: z.boolean().default(true),
  /**
   * Write from the supplied URLs and uploads only: no search, no competitor
   * discovery. What that costs is the measured section-depth band, which needs
   * comparable articles and therefore falls back to 700-800. The form says so.
   */
  sourcesOnly: z.boolean().default(false),
  /** Set true to proceed past a cannibalisation match, deliberately. */
  overrideCannibalisation: z.boolean().default(false),
  /** Set true to proceed after the premise check flagged the idea, deliberately. */
  overrideFalsePremise: z.boolean().default(false),
});

export async function POST(req: Request) {
  return handle('intake', async (cid) => {
    const user = await requireUser();
    const parsed = Intake.safeParse(await req.json());
    if (!parsed.success) {
      throw Errors.validation('Some fields are missing or malformed.', parsed.error.flatten());
    }
    const input = parsed.data;

    // ---- Idempotency. A replay returns the SAME request, not a second one.
    const existing = await one<any>(
      `select id, status from public.content_requests where idempotency_key=$1`,
      [input.idempotencyKey]);
    if (existing) {
      await event({ correlationId: cid, requestId: existing.id, actorId: user.id,
        stage: 'intake.replay', outcome: 'ok' });
      return { id: existing.id, status: existing.status, replayed: true };
    }

    // ---- Cannibalisation check, BEFORE anything costs money.
    //
    // The system deciding NOT to run is the cheapest cost control it has, and
    // it is the direct defence against Google's scaled-content-abuse policy:
    // a fifth article on a topic we already cover is the thing that gets
    // penalised, not the fact a model wrote it.
    const q = `${input.idea} ${input.keywordHint ?? ''}`.trim();
    const matches = await query<{ id: string; url: string; title: string; similarity: number }>(
      `select * from public.match_published_text($1, 0.35, 3)`, [q]).catch(() => []);

    if (matches.length && !input.overrideCannibalisation) {
      await event({ correlationId: cid, actorId: user.id, stage: 'intake.cannibalisation',
        outcome: 'blocked', detail: { matches } });
      return {
        blocked: 'cannibalisation',
        message:
          `We have already published something very close to this. Updating the existing ` +
          `post will rank better than a fifth article on the same topic.`,
        matches,
      };
    }

    /**
     * A CHEAP SANITY CHECK ON THE IDEA ITSELF, before research or drafting
     * spends anything.
     *
     * Neither the mechanical grounding gate nor the judge can catch this: the
     * grounding gate pattern-matches numbers, dates and quotes, so a plain
     * declarative claim with no digits in it ("humans have four legs") never
     * touches it, and the judge only asks whether a claim is CONSISTENT WITH
     * THE SUPPLIED SOURCES, which a low-quality source can happily agree with
     * even when it is false. This asks a different question, using the
     * model's own general knowledge, before either of those ever runs.
     *
     * Deliberately conservative and deliberately overridable. `checkPremise`
     * flags only a plain, uncontroversial violation of settled fact, and it
     * fails OPEN: if the call itself errors, the idea passes through exactly
     * as it would have before this existed, because refusing an ordinary
     * request over an infrastructure hiccup is the wrong trade.
     */
    let premiseCostUsd = 0;
    if (!input.overrideFalsePremise) {
      try {
        const premise = await checkPremise({
          idea: input.idea, audience: input.audience, keywordHint: input.keywordHint,
        });
        premiseCostUsd = premise.costUsd;
        if (premise.flagged) {
          await event({ correlationId: cid, actorId: user.id, stage: 'intake.premise_check',
            outcome: 'blocked', costUsd: premise.costUsd,
            detail: { claim: premise.claim, reason: premise.reason } });
          return {
            blocked: 'false_premise',
            message:
              `This idea rests on something that conflicts with well-established fact, so ` +
              `writing it would mean publishing a false claim as true under the firm's name.`,
            claim: premise.claim,
            reason: premise.reason,
          };
        }
        await event({ correlationId: cid, actorId: user.id, stage: 'intake.premise_check',
          outcome: 'ok', costUsd: premise.costUsd });
      } catch (e) {
        await event({ correlationId: cid, actorId: user.id, stage: 'intake.premise_check',
          outcome: 'skipped', detail: { error: e instanceof Error ? e.message : String(e) } });
      }
    }

    /**
     * The insert is written to LOSE SAFELY, not just to succeed.
     *
     * The check above is a read, so two handlers racing the same key can both
     * find nothing and both try to insert. The UNIQUE constraint stops the
     * second row existing, but a bare insert turns that into a constraint
     * violation, which `handle` reports as a 500 "something went wrong" to a
     * user whose request was in fact created perfectly by the other handler.
     *
     * `on conflict do nothing` plus the re-read below makes the loser return
     * the SAME id as the winner, which is what an idempotency key is for. One
     * dev server serialises these enough to hide the race; two instances
     * behind a load balancer will not.
     */
    const row = await one<{ id: string }>(
      `insert into public.content_requests
         (idempotency_key, idea, audience, goal, channels, keyword_hint, tone,
          scheduled_for, publish_to_x, x_include_link, sources_only, requester_id, status,
          cannibalisation_match_id, cannibalisation_score, cost_usd)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14,$15)
       on conflict (idempotency_key) do nothing
       returning id`,
      [input.idempotencyKey, input.idea, input.audience, input.goal, input.channels,
       input.keywordHint ?? null, input.tone ?? null, input.scheduledFor ?? null,
       input.publishToX, input.xIncludeLink, input.sourcesOnly, user.id,
       matches[0]?.id ?? null, matches[0]?.similarity ?? null, premiseCostUsd]);

    if (!row) {
      // Another handler won the race with this exact key. Return its request.
      const winner = await one<any>(
        `select id, status from public.content_requests where idempotency_key=$1`,
        [input.idempotencyKey]);
      if (!winner) throw Errors.conflict('The request could not be created. Try again.');
      await event({ correlationId: cid, requestId: winner.id, actorId: user.id,
        stage: 'intake.replay', outcome: 'ok', detail: { wonBy: 'another request' } });
      return { id: winner.id, status: winner.status, replayed: true };
    }

    await event({ correlationId: cid, requestId: row!.id, actorId: user.id,
      stage: 'intake.create', outcome: 'ok',
      detail: { channels: input.channels, sources: input.sourceUrls.length,
                overrodeCannibalisation: matches.length > 0 } });

    // Feed-only: no recipients, so n8n posts to #content-success and sends
    // no email. An email per state change trains people to ignore the emails.
    await notify({
      kind: 'request_created', requestId: row!.id, correlationId: cid,
      title: `New Content Request: ${input.idea.slice(0, 80)}`,
      lines: [`**Audience:** ${input.audience}`, `**Channels:** ${input.channels.join(', ')}`,
              `**Raised by:** ${user.name}`],
    });

    return { id: row!.id, status: 'draft', sourceUrls: input.sourceUrls };
  });
}

export async function GET() {
  return handle('requests.list', async () => {
    await requireUser();
    return query(
      `select r.id, r.idea, r.audience, r.status, r.channels, r.cost_usd, r.created_at,
              u.name as requester,
              (select count(*)::int from public.flags f
                where f.request_id=r.id and f.severity='blocking' and f.status='open') as blocking
         from public.content_requests r
         join public.users u on u.id = r.requester_id
        order by r.updated_at desc limit 50`);
  });
}
