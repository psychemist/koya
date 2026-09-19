import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUserPage } from '@/lib/auth';
import { query, one } from '@/lib/db';
import { notificationStatus } from '@/lib/notify';
import { lastFailure } from '@/lib/last-failure';
import { progressFor } from '@/lib/pipeline/progress';
import { hasUrl } from '@/lib/publish/links';
import AnglePicker from './angle-picker';
import LiveProgress from './live-progress';
import { RequestStatus } from '@/app/ui/status';
import BlockingGaps from '@/app/ui/blocking-gaps';
import DraftBody from '@/app/ui/draft-body';
import PostManually from '@/app/ui/post-manually';
import EditAsset from '@/app/ui/edit-asset';
import SourceToggle from './source-toggle';
import Tabs from '@/app/ui/tabs';

export const dynamic = 'force-dynamic';

/**
 * The workspace: everything known about one request, in the order a person
 * needs it. What it is doing right now, what blocks it, what was written, what
 * was read, and who was told.
 *
 * The last three are TABS. This page used to be one column carrying a failure
 * banner, the sources, the angle, fourteen blocking findings and four full
 * drafts, in that order, so the drafts were four screens below the fold. The
 * drafts are the thing people come here for.
 */
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserPage(`/requests/${id}`);

  const r = await one<any>(`select * from public.content_requests where id=$1`, [id]);
  if (!r) notFound();

  const [sources, angles, assets, flags, notes, failure, progress, citationRows] = await Promise.all([
    query<any>(`select s.id, s.submitted_url, s.final_url, s.provider, s.fetch_status,
                       s.failure_reason, s.quarantined, s.injection_flags, s.relevance_score,
                       s.is_comparable,
                       (select count(*)::int from public.excerpts e
                         where e.source_id=s.id) as excerpt_count,
                       (select count(*)::int from public.excerpts e
                         where e.source_id=s.id and e.selected) as selected_count
                  from public.sources s where s.request_id=$1
                 order by (s.fetch_status='ok') desc, s.quarantined, s.submitted_url`, [id]),
    query<any>(`select * from public.angles where request_id=$1 order by ord`, [id]),
    query<any>(`select distinct on (kind) kind, revision, body, subject_line, image_slot, origin, cost_usd
                  from public.assets where request_id=$1 order by kind, revision desc`, [id]),
    query<any>(`select code, severity, status, message, asset_kind from public.flags
                 where request_id=$1 and status='open' order by severity, code`, [id]),
    notificationStatus(id).catch(() => []),
    lastFailure(id),
    progressFor(id).catch(() => null),
    // `excerpts.label` (e.g. `S1d20P1`) is meaningless on its own — it is the
    // source's own uuid prefix and an ordinal, apparatus for the grounding
    // check. Resolved here to the source it actually names, so a citation
    // marker can say what it points at instead of just looking like one.
    query<{ label: string; url: string; title: string | null }>(
      `select e.label, coalesce(s.final_url, s.submitted_url) as url, s.title
         from public.excerpts e join public.sources s on s.id = e.source_id
        where s.request_id=$1`, [id]),
  ]);

  const citations = Object.fromEntries(
    citationRows.map((c) => [c.label, c.title ? `${c.title} (${c.url})` : c.url]));

  const blocking = flags.filter((f: any) => f.severity === 'blocking');
  const advisory = flags.filter((f: any) => f.severity !== 'blocking');
  const usable = sources.filter((s: any) => s.fetch_status === 'ok' && !s.quarantined).length;
  const selected = angles.find((a: any) => a.selected_at);
  const hasDraft = assets.length > 0;

  // Whoever raised it, or an editor. Same rule as the route, stated here so a
  // disabled button can say why rather than being a dead end.
  const canWrite = r.requester_id === user.id || ['editor', 'admin'].includes(user.role);
  const whyNotWrite = canWrite
    ? undefined
    : 'Only the person who raised this request, or an editor, can write from an angle.';

  // Only worth shouting about while the request is sitting in a state the
  // failure explains. Once it has moved on, it is history, not news.
  const showFailure = failure
    && ['angles_ready', 'research_failed', 'needs_human', 'publish_failed'].includes(r.status);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <RequestStatus status={r.status} />
            {blocking.length > 0 && (
              <span className="pill bg-blocking-bg text-blocking">
                {blocking.length} blocking
              </span>
            )}
          </div>
          <h1 className="mt-2.5 text-xl font-semibold leading-snug tracking-[-0.02em]">{r.idea}</h1>
          <p className="mt-1 text-sm text-muted">Written for {r.audience}</p>
        </div>
        {hasDraft && (
          <Link href={`/requests/${id}/review`} className="btn btn-primary shrink-0">
            Open the Review Screen
          </Link>
        )}
      </header>

      {/* What it is doing, right now. First, because at ninety seconds into a
          three-minute run this is the only question anybody has. */}
      {progress && <LiveProgress requestId={id} initial={progress} />}

      {showFailure && (
        <div className="sheet border-blocking/30 bg-blocking-bg p-4">
          <h2 className="text-sm font-semibold text-blocking">
            The last attempt failed at {failure!.stage.replace(/[._]/g, ' ')}
          </h2>
          <p className="mt-1 text-sm text-ink-70">{failure!.message}</p>
          <p className="mt-2 text-sm text-ink-70">
            Nothing was half-written. The request was put back to a state you can act from, and
            anything already spent is still counted below. A source that could not be read is
            not this: those are listed one by one under Sources.
          </p>
          <p className="ident mt-2">reference {failure!.correlationId}</p>
        </div>
      )}

      {/*
        THE ANGLE DECISION TAKES THE FULL WIDTH WHILE IT IS THE DECISION.

        Three outlines squeezed into a column beside a fixed rail gave each one
        about a 260px measure, so seven headings became seven stacks of
        two-word fragments, which turns the one genuinely comparative decision
        in the pipeline into the hardest thing on screen to compare.

        Once something is written it collapses to a summary row, and it no
        longer disappears: the other two angles stay reachable, which they did
        not used to be.
      */}
      {angles.length > 0 && (
        <AnglePicker
          requestId={id}
          angles={angles}
          hasDraft={hasDraft}
          canWrite={canWrite}
          whyNot={whyNotWrite}
        />
      )}

      {/* Grouped and collapsed. Fourteen findings as a flat list ran most of a
          screen; as four groups it is four lines, and the counts are still on
          the outside so nobody talks themselves into expecting two. */}
      <BlockingGaps flags={blocking} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <Tabs
            initial={hasDraft ? 'drafts' : 'sources'}
            tabs={[
              {
                key: 'drafts', label: 'Drafts', count: assets.length || undefined,
                panel: <Drafts assets={assets} requestId={id} request={r} citations={citations} />,
              },
              {
                key: 'sources', label: 'Sources', count: sources.length || undefined,
                panel: (
                  <Sources rows={sources} usable={usable} requestId={id} canChoose={!hasDraft} />
                ),
              },
              {
                key: 'delivery', label: 'Delivery', count: notes.length || undefined,
                panel: <Delivery notes={notes} />,
              },
            ]}
          />
        </div>

        {/* The rail. Cost, depth band, the angle and the advisory notes: what a
            manager asks about a request that is not the text itself. */}
        <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <section className="sheet p-4">
            <h2 className="text-sm font-semibold">This request</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Spent so far" value={`$${Number(r.cost_usd ?? 0).toFixed(3)}`} />
              <Row label="Channels" value={(r.channels ?? []).join(', ') || 'none'} />
              <Row label="Sources used" value={`${usable} of ${sources.length}`} />
              {r.section_target_min && (
                <div>
                  <dt className="text-muted">Section depth</dt>
                  <dd className="mt-0.5">
                    {r.section_target_min} to {r.section_target_max} words
                    <span className="block text-xs text-muted">
                      {r.section_target_source === 'measured'
                        ? 'measured from the competing articles'
                        : 'fallback, fewer than three comparable articles were found'}
                    </span>
                  </dd>
                </div>
              )}
              {r.publish_to_x && (
                <div>
                  <dt className="text-muted">X publishing</dt>
                  <dd className="mt-0.5">
                    Opted in, {r.x_include_link === false ? '$0.015' : '$0.20'} per post
                    <span className="block text-xs text-muted">
                      {r.x_include_link === false
                        ? 'the link is removed just before posting, which is what makes it the cheaper rate'
                        : 'the higher rate applies because the post carries a link'}
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {selected && (
            <section className="sheet p-4">
              <h2 className="text-sm font-semibold">The angle being written</h2>
              <p className="mt-2 font-medium leading-snug">{selected.title}</p>
              <p className="mt-1 text-sm text-ink-70">{selected.thesis}</p>
              <p className="mt-2.5 text-sm text-muted">
                Ranking for{' '}
                <strong className="font-medium text-ink">{selected.primary_keyword}</strong>
                {selected.keyword_class ? `, a ${selected.keyword_class} long-tail keyword` : ''}
              </p>
            </section>
          )}

          {advisory.length > 0 && (
            <section className="sheet p-4">
              <h2 className="text-sm font-semibold">
                Worth knowing{' '}
                <span className="font-normal text-muted">({advisory.length})</span>
              </h2>
              <p className="mt-1 text-xs text-muted">
                None of these stops approval.
              </p>
              <ul className="mt-2.5 space-y-2 text-sm text-ink-70">
                {advisory.slice(0, 6).map((f: any, i: number) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-advisory" />
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

/* ----------------------------------------------------------------- drafts */

function Drafts({ assets, requestId, request, citations }: {
  assets: any[]; requestId: string; request: any; citations: Record<string, string>;
}) {
  if (assets.length === 0) {
    return (
      <p className="sheet p-10 text-center text-sm text-muted">
        Nothing has been written yet. Pick an angle above, and the article and every channel
        post are written from it.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Showing the latest revision of each. Citation markers like{' '}
        <span className="cite">[S1a2bP3]</span> point at the source excerpt a figure came from.
        They are apparatus, not copy, and they are removed before anything is published.
      </p>

      {assets.map((a: any) => {
        const manual = a.kind === 'x'
          ? !request.publish_to_x
          : a.kind === 'linkedin';
        return (
          <article key={a.kind} className="sheet overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-rule bg-sunk/40 px-4 py-2.5">
              <span className="text-sm font-semibold">{kindLabel(a.kind)}</span>
              <span className="text-xs text-muted">
                revision {a.revision}, {originLabel(a.origin)}
              </span>
              {a.kind === 'x' && (
                <span className="pill bg-sunk text-ink-70 tabular-nums">
                  {[...String(a.body)].length} of 280
                </span>
              )}
              {a.subject_line && (
                <span className="ml-auto truncate text-xs text-muted">
                  Subject: {a.subject_line}
                </span>
              )}
            </div>

            <div className="px-4 py-4">
              <DraftBody body={a.body} citations={citations} compact />
              {a.kind !== 'article' && (
                <EditAsset
                  requestId={requestId} kind={a.kind} revision={a.revision} body={a.body}
                  maxChars={a.kind === 'x' ? 280 : a.kind === 'linkedin' ? 1000 : undefined}
                />
              )}

              {manual && (
                <div className="mt-4">
                  <PostManually
                    channel={a.kind}
                    body={a.body}
                    reason={
                      a.kind === 'x'
                        ? hasUrl(a.body)
                          ? 'This request did not opt into paid X posting. X has had no free API tier since February 2026, so the free route is X’s own composer.'
                          : 'This request did not opt into paid X posting, so the free route is X’s own composer.'
                        : 'Works whether or not a LinkedIn token is configured. Posting to your own profile through the API is free too, it just needs a token.'
                    }
                  />
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- sources */

/**
 * Every source outcome is visible, because "we chose not to use it" has to be
 * distinguishable from "we could not fetch it". A thin article with no
 * explanation is how a reviewer approves something built on two sources
 * believing it was built on seven.
 *
 * A GRID, NOT A FLEX ROW, and that is the whole of the alignment fix. The
 * status was an inline pill followed by the URL, so every URL started wherever
 * the pill before it happened to end: "Read" is four characters and
 * "Quarantined" is eleven, so the column of URLs zigzagged down the page by
 * about 60px and could not be scanned at all. A fixed first column puts every
 * URL on the same left edge whatever the status beside it says.
 */
function Sources({
  rows, usable, requestId, canChoose,
}: { rows: any[]; usable: number; requestId: string; canChoose: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="sheet p-10 text-center text-sm text-muted">
        Nothing has been read yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {usable} of {rows.length} were usable. Anything else is listed with the reason it was
        not, because a source that quietly vanishes is worse than one that visibly failed.
        {canChoose && ' Uncheck a source to keep its excerpts out of the pack, or bring one back.'}
        {!canChoose && ' The article has been written, so which sources feed it is settled.'}
      </p>

      <ul className="sheet divide-y divide-rule overflow-hidden text-sm">
        {rows.map((s: any) => (
          <li
            key={s.submitted_url}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1
                       px-4 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto]"
          >
            <span className={`pill mt-0.5 justify-center ${
              s.quarantined ? 'bg-blocking-bg text-blocking'
              : s.fetch_status === 'ok' ? 'bg-ok-bg text-ok'
              : 'bg-advisory-bg text-advisory'}`}>
              {s.quarantined ? 'Quarantined' : fetchLabel(s.fetch_status)}
            </span>

            <div className="min-w-0">
              <p className="truncate" title={s.final_url ?? s.submitted_url}>
                {s.final_url ?? s.submitted_url}
              </p>
              {s.failure_reason && <p className="text-xs text-muted">{s.failure_reason}</p>}
              {s.quarantined && (
                <p className="text-xs text-blocking">
                  Left out of the excerpt pool. Prompt injection markers found:{' '}
                  {(s.injection_flags ?? []).map((f: any) => f.code.replace(/_/g, ' ')).join(', ')}
                </p>
              )}
              {/* Not for a failed fetch or a quarantined source: neither has a
                  real choice to make, and offering one there would lie about
                  what the control can do. */}
              {s.fetch_status === 'ok' && !s.quarantined && (
                canChoose ? (
                  <div className="mt-1">
                    <SourceToggle
                      requestId={requestId} sourceId={s.id}
                      selected={s.selected_count > 0} excerptCount={s.excerpt_count}
                    />
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    {s.selected_count > 0
                      ? `Used, ${s.selected_count} of ${s.excerpt_count} excerpts`
                      : 'Not used'}
                  </p>
                )
              )}
            </div>

            {/* Third column on wide screens, dropped to the URL column on
                narrow ones rather than squeezing the URL to nothing. */}
            <span className="col-start-2 whitespace-nowrap text-xs text-muted sm:col-start-3 sm:pt-0.5 sm:text-right">
              {s.provider === 'web_fetch' ? 'Claude fetch'
                : s.provider === 'upload' ? 'Uploaded' : s.provider}
              {s.is_comparable ? ', comparable' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- delivery */

/** Silence is not success. If nobody was told, the page says so. */
function Delivery({ notes }: { notes: any[] }) {
  if (notes.length === 0) {
    return (
      <p className="sheet p-10 text-center text-sm text-muted">
        Nothing has been sent about this request yet.
      </p>
    );
  }

  return (
    <ul className="sheet divide-y divide-rule overflow-hidden text-sm">
      {notes.map((n: any, i: number) => (
        <li key={i} className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 px-4 py-3">
          <span className={`pill mt-0.5 justify-center ${
            n.state === 'sent' ? 'bg-ok-bg text-ok'
            : n.state === 'degraded' ? 'bg-advisory-bg text-advisory'
            : n.state === 'pending' ? 'bg-sunk text-ink-70'
            : 'bg-blocking-bg text-blocking'}`}>
            {noteState(n.state)}
          </span>
          <div className="min-w-0">
            <p>{noteLabel(n.kind)}</p>
            {n.state === 'degraded' && (
              <p className="text-xs text-muted">
                Email went out on the app’s own fallback lane. Discord was not posted to.
              </p>
            )}
            {n.state === 'skipped_not_configured' && (
              <p className="text-xs text-muted">
                No notification lane is configured on this deployment.
              </p>
            )}
            {n.state === 'pending' && (
              <p className="text-xs text-muted">
                Claimed but never finished, which means the process died mid-send. Nobody can be
                assumed to have been told.
              </p>
            )}
            {n.state === 'failed' && n.error_code && <p className="ident">{n.error_code}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const kindLabel = (k: string) =>
  ({ article: 'Article', linkedin: 'LinkedIn post', x: 'X post', newsletter: 'Newsletter' }[k] ?? k);

const originLabel = (o: string) =>
  ({ generate: 'first draft', auto_revise: 'revised after the checks',
     human_edit: 'edited by a person', revert: 'reverted to the better version' }[o] ?? o);

const fetchLabel = (s: string) =>
  ({ ok: 'Read', robots_denied: 'Not allowed', paywalled: 'Paywalled',
     boilerplate: 'Too thin', too_large: 'Too large', failed: 'Failed' }[s] ?? s);

const noteLabel = (k: string) =>
  ({ request_created: 'Request raised', angles_ready: 'Angles ready to pick',
     needs_review: 'Ready for review', needs_human: 'Needs a person',
     approved: 'Approved', changes_requested: 'Changes requested', rejected: 'Rejected',
     published: 'Published', publish_failed: 'Publishing failed',
     research_failed: 'Research failed' }[k] ?? k.replace(/_/g, ' '));

const noteState = (s: string) =>
  ({ sent: 'Sent', degraded: 'Email only', pending: 'Unfinished',
     failed: 'Not delivered', skipped_not_configured: 'No lane' }[s] ?? s);
