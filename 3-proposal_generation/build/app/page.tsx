import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../lib/auth";
import { listProposals } from "../lib/proposal/repo";
import { query } from "../lib/db";
import { formatUsd } from "../lib/claude/models";
import { SECTIONS } from "../lib/proposal/sections";
import { STATUSES, type Status } from "../lib/proposal/state";
import { AppShell, PageHeader } from "../components/AppShell";
import { EmptyState, GapCount, MetricTile, StatusBadge, TimeAgo } from "../components/ui";

export const dynamic = "force-dynamic";

/**
 * The pipeline.
 *
 * Ordered by what a salesperson opens the app to find out: what is waiting on
 * me, what is waiting on someone else, and what went out. The metric strip is
 * deliberately small — four numbers that answer a question, rather than a
 * dashboard nobody reads.
 */

type Totals = {
  total: number;
  awaiting: number;
  sent: number;
  cost_micro_usd: string;
  billed_calls: number;
  cache_hits: number;
  median_cycle_hours: number | null;
};

/**
 * The metric strip, counted over the same proposals the list below shows.
 *
 * `authorId` is null for anyone who may see the whole firm's pipeline, and
 * the salesperson's own id otherwise. Passing it through rather than counting
 * everything and filtering the list is the point: a strip saying "8
 * proposals" above a list of two is not a smaller leak than the list itself,
 * it is the same leak with the detail removed. The spend figures are scoped
 * the same way, through the proposals the caller can see.
 */
async function loadTotals(authorId: string | null): Promise<Totals> {
  const rows = await query<Totals>(
    `SELECT
       (SELECT count(*)::int FROM proposals p WHERE ($1::uuid IS NULL OR p.author_id = $1)) AS total,
       (SELECT count(*)::int FROM proposals p WHERE p.status = 'pending_approval'
           AND ($1::uuid IS NULL OR p.author_id = $1)) AS awaiting,
       (SELECT count(*)::int FROM proposals p WHERE p.status = 'sent'
           AND ($1::uuid IS NULL OR p.author_id = $1)) AS sent,
       (SELECT coalesce(sum(p.cost_micro_usd), 0)::text FROM proposals p
          WHERE ($1::uuid IS NULL OR p.author_id = $1)) AS cost_micro_usd,
       (SELECT count(*)::int FROM ai_calls c
          WHERE NOT c.cache_hit
            AND ($1::uuid IS NULL
                 OR c.proposal_id IN (SELECT id FROM proposals WHERE author_id = $1))) AS billed_calls,
       (SELECT count(*)::int FROM ai_calls c
          WHERE c.cache_hit
            AND ($1::uuid IS NULL
                 OR c.proposal_id IN (SELECT id FROM proposals WHERE author_id = $1))) AS cache_hits,
       -- Median rather than mean: one proposal left open over a weekend would
       -- otherwise make the average meaningless.
       (SELECT percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (p.sent_at - p.created_at)) / 3600.0)
          FROM proposals p WHERE p.sent_at IS NOT NULL
            AND ($1::uuid IS NULL OR p.author_id = $1)) AS median_cycle_hours`,
    [authorId],
  );
  return (
    rows[0] ?? {
      total: 0,
      awaiting: 0,
      sent: 0,
      cost_micro_usd: "0",
      billed_calls: 0,
      cache_hits: 0,
      median_cycle_hours: null,
    }
  );
}

/**
 * How many proposals sit in each status.
 *
 * One grouped count, added because the filter row was six labels with no
 * numbers on them. "What is waiting on an approver" is the question a
 * salesperson opens this page to answer, and the only way to answer it was to
 * click a filter and read how many rows came back. Putting the figure on the
 * filter answers it before the click, and it costs one indexed aggregate over
 * a table this page already reads twice.
 */
async function loadStatusCounts(authorId: string | null): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n
       FROM proposals
      WHERE ($1::uuid IS NULL OR author_id = $1)
      GROUP BY status`,
    [authorId],
  );
  const counts: Record<string, number> = {};
  let all = 0;
  for (const row of rows) {
    counts[row.status] = row.n;
    all += row.n;
  }
  return { ...counts, all };
}

const FILTERS: { key: string; label: string; status?: Status }[] = [
  { key: "all", label: "All" },
  { key: "pending_approval", label: "Awaiting approval", status: "pending_approval" },
  { key: "review", label: "In review", status: "review" },
  { key: "changes_requested", label: "Changes requested", status: "changes_requested" },
  { key: "approved", label: "Approved", status: "approved" },
  { key: "sent", label: "Sent", status: "sent" },
];

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const activeKey = FILTERS.some((f) => f.key === params.status) ? params.status! : "all";
  const activeFilter = FILTERS.find((f) => f.key === activeKey)!;
  const search = params.q?.trim() ?? "";

  /**
   * Whose pipeline this is.
   *
   * A salesperson sees their own proposals and nobody else's. Approvers and
   * administrators see everything, because an approver has to be able to find
   * work waiting on them and an administrator runs the firm.
   *
   * This mirrors `canAccess(…, "view")` in lib/proposal/access.ts, which is
   * the rule the individual proposal pages already enforce. Until now the
   * LIST did not: `listProposals` has always taken an `authorId` and this
   * page never passed one, so every salesperson could read every colleague's
   * reference, client company, status and cost from the front page. The
   * per-proposal guards were doing their job and the index was handing out
   * the same information in summary form.
   */
  const scopeToAuthor = user.role === "salesperson" ? user.id : null;

  /**
   * Claude spend is an administrator's concern.
   *
   * A salesperson cannot act on it - they cannot change the model, the
   * routing or the budget - so putting a running cost beside their own work
   * only invites them to draft less, or to feel watched for drafting at all.
   * The System page still reports every penny, to the people who set the
   * budget. Same reasoning for an approver, who is judging the document.
   */
  const showsCost = user.role === "admin";

  const [proposals, totals, statusCounts] = await Promise.all([
    listProposals({
      status: activeFilter.status ?? "all",
      search: search.length > 0 ? search : undefined,
      authorId: scopeToAuthor ?? undefined,
    }),
    loadTotals(scopeToAuthor),
    loadStatusCounts(scopeToAuthor),
  ]);

  const spend = Number(totals.cost_micro_usd);
  const perProposal = totals.total > 0 ? Math.round(spend / totals.total) : 0;

  return (
    <AppShell user={user}>
      <PageHeader
        title="Pipeline"
        description={
          scopeToAuthor
            ? "Your proposals, and what each one is waiting on. Nothing reaches a client until a second person approves it."
            : "Every proposal in the firm, and what it is waiting on. Nothing reaches a client until a second person approves it."
        }
      />

      <section
        className="mb-7 grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
        aria-label="Summary"
      >
        <MetricTile
          label="Proposals"
          value={totals.total}
          detail={`${totals.sent} sent to a client`}
        />
        <MetricTile
          label="Awaiting approval"
          value={totals.awaiting}
          detail={totals.awaiting === 0 ? "Nothing queued" : "Needs an approver"}
        />
        {showsCost ? (
          <MetricTile
            label="Claude spend"
            value={formatUsd(spend)}
            detail={
              totals.total > 0
                ? `${formatUsd(perProposal)} per proposal · ${totals.billed_calls} billed calls, ${totals.cache_hits} reused`
                : "No calls yet"
            }
          />
        ) : null}
        <MetricTile
          label="Median time to send"
          empty={totals.median_cycle_hours === null}
          value={
            /*
             * A word, not a glyph. This read "·", which a reader can only
             * interpret as either "zero", "loading" or "broken"; the one
             * thing it does not say is that nothing has been delivered yet,
             * which is what it means.
             */
            totals.median_cycle_hours === null
              ? "Not yet"
              : totals.median_cycle_hours < 1
                ? `${Math.round(totals.median_cycle_hours * 60)}m`
                : `${totals.median_cycle_hours.toFixed(1)}h`
          }
          detail="Created to delivered"
        />
      </section>

      {/*
        The filter row is one control, not six.

        It used to be six loose buttons, the current one solid accent and the
        rest borderless, so the set had no outline and read as an accidental
        row of links rather than as a single choice. Wrapping them in a track
        and marking the current one with the same accent tint the theme
        switcher uses makes the choice legible without shouting, and the
        counts turn the row from navigation into information: how much is
        waiting on whom is readable before anything is clicked.
      */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav className="filter-bar" aria-label="Filter by status">
          {FILTERS.map((filter) => {
            const isActive = filter.key === activeKey;
            const count = statusCounts[filter.key] ?? 0;
            const href =
              filter.key === "all"
                ? search
                  ? `/?q=${encodeURIComponent(search)}`
                  : "/"
                : `/?status=${filter.key}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
            return (
              /*
                The count is spoken through the link's own label rather than
                an `.sr-only` span.

                The span version widened the document. `.sr-only` is
                absolutely positioned, `.filter-chip` and `.filter-bar` are
                not, so it escaped the scrolling track it sat in, positioned
                itself against the page, and pushed the document 110px past
                the viewport on a phone. An aria-label carries the same
                information with nothing in the layout to escape from.
              */
              <Link
                key={filter.key}
                href={href}
                aria-current={isActive ? "page" : undefined}
                aria-label={`${filter.label}, ${count} proposal${count === 1 ? "" : "s"}`}
                className={`filter-chip no-underline hover:no-underline ${
                  isActive ? "is-active" : ""
                }`}
              >
                {filter.label}
                <span className="filter-count" aria-hidden="true">
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Pushed right only when there is room to push it into. On a phone the
            filter row already fills the line, so `ml-auto` just stranded the
            search box against the right edge with a hole beside it. */}
        <form action="/" className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
          {activeKey !== "all" ? <input type="hidden" name="status" value={activeKey} /> : null}
          {/*
            The glyph goes inside the field rather than a second word beside
            it. The submit button stays, because a search box that only works
            with JavaScript is a search box that sometimes does not work, but
            it no longer has to say "search" next to a field that already
            says it.
          */}
          <div className="field-search w-full sm:w-[268px]">
            <span className="field-search-glyph" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Company, client or reference"
              aria-label="Search proposals"
              className="input"
            />
          </div>
          <button type="submit" className="btn btn-sm">
            Search
          </button>
        </form>
      </div>

      {proposals.length === 0 ? (
        /*
          Three empty states, not one.

          This said "No proposals yet" whenever the list came back empty,
          including when a filter was the reason. With eight proposals on the
          books and the Sent filter selected, the page claimed there were none
          at all, and offered to start the first one. An empty result under a
          filter is not an empty database, and telling somebody their work has
          vanished is a worse failure than any layout problem on this page.
        */
        <EmptyState
          title={
            search
              ? `Nothing matches “${search}”`
              : activeKey !== "all"
                ? `No proposals under “${activeFilter.label}”`
                : "No proposals yet"
          }
          action={
            activeKey !== "all" && !search ? (
              <Link href="/" className="btn no-underline hover:no-underline">
                Show all {statusCounts.all ?? 0} proposals
              </Link>
            ) : (
              <Link
                href="/proposals/new"
                className="btn btn-primary no-underline hover:no-underline"
              >
                Start a proposal
              </Link>
            )
          }
        >
          {search
            ? "Try a company name, a client name, or a reference like KOY-2026-0001."
            : activeKey !== "all"
              ? "Nothing is sitting at this step of the lifecycle right now. The counts on the filters above say where everything else is."
              : "Start from your discovery-call notes. Claude writes the first draft; you revise it section by section before anyone else sees it."}
        </EmptyState>
      ) : (
        /*
          The caption said "each row links to its workspace" and only the
          reference cell did, which is a 90px target inside a 1300px row and
          the single most-repeated click in the application. `.row-link`
          stretches that same anchor over the row, so the whole row is
          clickable and none of the things a link does are given up:
          middle-click still opens a tab, copy-link-address still works, and
          the keyboard still gets exactly one focus stop per row instead of
          landing on eight cells.

          `min-w` on the table matters as much. With eight columns and no
          floor, a narrow window did not scroll the table, it crushed it, and
          the first thing to break was the reference, which wrapped across two
          lines mid-token. Below the floor the card scrolls, which is what
          `.scroll-x` is for.
        */
        <div className="card scroll-x">
          <table className="tbl tbl-hover tbl-rowlink min-w-[900px]">
            <caption className="sr-only">
              Proposals, newest first. Each row links to its workspace.
            </caption>
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Client</th>
                <th scope="col">Status</th>
                <th scope="col">Checks</th>
                <th scope="col">Progress</th>
                <th scope="col">Owner</th>
                <th scope="col">Approver</th>
                {showsCost ? (
                  <th scope="col" className="tbl-num">
                    Cost
                  </th>
                ) : null}
                <th scope="col" className="tbl-num">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link
                      href={`/proposals/${p.id}`}
                      className="row-link mono whitespace-nowrap font-semibold"
                    >
                      {p.ref}
                    </Link>
                  </td>
                  <td className="max-w-[260px]">
                    <div className="truncate font-medium text-[var(--ink)]">
                      {p.intake.company_name}
                    </div>
                    <div className="truncate t-sm text-[var(--muted)]">{p.intake.client_name}</div>
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>
                    <GapCount
                      blocking={p.open_blocking_gaps}
                      advisory={p.open_advisory_gaps}
                      checked={p.written_sections > 0}
                    />
                  </td>
                  <td className="whitespace-nowrap text-[var(--ink-2)]">
                    {p.written_sections}/{SECTIONS.length} sections
                    {p.source_count > 0 ? (
                      <span className="text-[var(--muted)]">
                        {" · "}
                        {p.source_count} attachment{p.source_count === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </td>
                  <td className="max-w-[160px] truncate text-[var(--ink-2)]">{p.author_name}</td>
                  {/*
                    Who signed it off, or who it is waiting on.

                    An empty cell would be ambiguous between "nobody yet" and
                    "this column does not apply", so the reason is named: a
                    proposal with an approver shows them, one waiting shows
                    that it is waiting, and one not yet submitted says so.
                  */}
                  <td className="max-w-[160px] truncate text-[var(--ink-2)]">
                    {p.approver_name ? (
                      p.approver_name
                    ) : p.status === "pending_approval" ? (
                      <span className="text-[var(--muted)]">awaiting one</span>
                    ) : (
                      <span className="text-[var(--muted)]">·</span>
                    )}
                  </td>
                  {showsCost ? (
                    <td className="tbl-num text-[var(--ink-2)]">
                      {formatUsd(Number(p.cost_micro_usd))}
                    </td>
                  ) : null}
                  <td className="tbl-num whitespace-nowrap text-[var(--muted)]">
                    <TimeAgo at={p.updated_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </AppShell>
  );
}
