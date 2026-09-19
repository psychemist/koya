import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUserPage, decisionRefusal, roleLabel } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { evidenceBundle } from '@/lib/pipeline/approve';
import { RequestStatus } from '@/app/ui/status';
import ReviewPanel, { KIND_LABEL } from './review-panel';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserPage(`/requests/${id}/review`);

  const r = await one<any>(`select * from public.content_requests where id=$1`, [id]);
  if (!r) notFound();

  const kinds = ['article', ...(r.channels ?? [])] as const;

  /**
   * A MISSING PANEL HAS TO SAY WHY IT IS MISSING.
   *
   * `evidenceBundle` throws when an asset does not exist, and the previous
   * version caught that and returned null, so the channel simply was not on
   * the page. A reviewer approving three of four assets has no way to notice
   * the fourth is absent, which is precisely the gap the completeness check
   * exists to close, reopened in the UI.
   */
  const panels = await Promise.all(
    kinds.map(async (kind) => {
      try {
        const { bundle, hash } = await evidenceBundle(id, kind as any);
        return { kind, bundle, hash, missing: null as string | null };
      } catch (e) {
        return {
          kind, bundle: null, hash: '',
          missing: e instanceof Error ? e.message : 'This asset does not exist yet.',
        };
      }
    }),
  );

  /**
   * EVERY revision, and every decision ever taken, read separately from the
   * evidence bundle.
   *
   * Separately on purpose. The bundle is hashed and the hash is compared
   * server-side before an approval is accepted, so it has to contain exactly
   * what the approval is a claim about: the revision being approved. Folding
   * the history into it would mean a new revision changed the hash of an older
   * one, and every open review screen would start refusing with "the content
   * changed while you were reviewing it" when the content it was showing had
   * not changed at all.
   */
  const [history, approvals, citationRows] = await Promise.all([
    query<any>(
      `select a.kind, a.revision, a.origin, a.model, a.cost_usd, a.created_at,
              a.body, a.subject_line, a.parent_revision,
              u.name as author,
              (select count(*)::int from public.evaluations e
                where e.asset_id = a.id and e.tier = 1) as judged,
              (select round(avg(e.score)::numeric, 1) from public.evaluations e
                where e.asset_id = a.id and e.tier = 1) as avg_score
         from public.assets a
         left join public.users u on u.id = a.created_by
        where a.request_id = $1
        order by a.kind, a.revision desc`, [id]),
    query<any>(
      `select ap.asset_kind, ap.decision, ap.asset_revision, ap.note, ap.created_at,
              ap.solo_override, ap.evidence_hash, u.name as actor, u.role as actor_role
         from public.approvals ap
         join public.users u on u.id = ap.actor_id
        where ap.request_id = $1 order by ap.created_at desc`, [id]),
    // Resolves `excerpts.label` (e.g. `S1d20P1`) to the source it names, so
    // the proof's citation markers can say what they point at on hover.
    query<{ label: string; url: string; title: string | null }>(
      `select e.label, coalesce(s.final_url, s.submitted_url) as url, s.title
         from public.excerpts e join public.sources s on s.id = e.source_id
        where s.request_id=$1`, [id]),
  ]);

  const citations = Object.fromEntries(
    citationRows.map((c) => [c.label, c.title ? `${c.title} (${c.url})` : c.url]));

  const isAuthor = r.requester_id === user.id;

  /**
   * ONE RULE, ASKED THREE TIMES, and the answer comes from the same function
   * the route calls. The screen used to keep its own copy that covered only
   * approval, so the other two buttons were enabled for anybody with a note to
   * type and the refusal arrived from the server as a surprise.
   */
  const refusals = {
    approved: decisionRefusal({ actorId: user.id, actorRole: user.role,
      requesterId: r.requester_id, decision: 'approved' }),
    changes_requested: decisionRefusal({ actorId: user.id, actorRole: user.role,
      requesterId: r.requester_id, decision: 'changes_requested' }),
    rejected: decisionRefusal({ actorId: user.id, actorRole: user.role,
      requesterId: r.requester_id, decision: 'rejected' }),
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <RequestStatus status={r.status} />
          <Link href={`/requests/${id}`} className="text-sm text-muted hover:text-ink hover:underline">
            Back to the request
          </Link>
        </div>
        <h1 className="mt-2.5 text-xl font-semibold leading-snug tracking-[-0.02em]">{r.idea}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Approving records what you were shown, not just that you clicked. If the content
          changes while this page is open, the approval is refused and you are asked to read
          the current version.
        </p>
      </header>

      {/* Said once at the top rather than three times down the page, and it
          names the role the reader actually has so there is nothing to work
          out from which buttons happen to be grey. */}
      {(isAuthor || refusals.approved) && (
        <p className="sheet border-advisory/30 bg-advisory-bg p-3.5 text-sm">
          {isAuthor
            ? 'You raised this request. Separation of duties means you cannot decide on your own work, so an editor other than the author has to sign it off, send it back or reject it.'
            : `You are signed in as ${roleLabel(user.role)}. ${refusals.approved}`}
        </p>
      )}

      {panels.map((p) => (
        p.bundle ? (
          <ReviewPanel
            key={p.kind}
            requestId={id}
            kind={p.kind}
            hash={p.hash}
            version={r.version}
            bundle={p.bundle}
            citations={citations}
            actorName={user.name}
            refusals={refusals}
            history={history.filter((h: any) => h.kind === p.kind)}
            decisions={approvals.filter((a: any) => a.asset_kind === p.kind)}
            publishesToX={Boolean(r.publish_to_x)}
            xIncludesLink={r.x_include_link !== false}
          />
        ) : (
          <section key={p.kind} className="sheet border-blocking/30 bg-blocking-bg p-4">
            <h2 className="text-sm font-semibold text-blocking">
              There is no {KIND_LABEL[p.kind] ?? p.kind} to review
            </h2>
            <p className="mt-1 text-sm text-ink-70">
              This request asked for a {KIND_LABEL[p.kind] ?? p.kind}, and nothing was produced. It cannot be
              approved, and the completeness check blocks the pack until it exists.
            </p>
          </section>
        )
      ))}
    </div>
  );
}
