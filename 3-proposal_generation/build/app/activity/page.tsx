import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/auth";
import {
  ACTION_GROUPS,
  actionLabel,
  activityTotals,
  DEFAULT_PAGE_SIZE,
  listActivity,
  listActors,
  type ActionGroupKey,
} from "../../lib/activity";
import { AppShell, PageHeader } from "../../components/AppShell";
import { Badge, EmptyState, MetricTile, TimeAgo } from "../../components/ui";

export const metadata: Metadata = { title: "Activity · Koya Proposal Studio" };
export const dynamic = "force-dynamic";

/**
 * The Activity page: the audit trail, by person.
 *
 * System answers "what is broken on this deployment" and is now administrator
 * only, because it reports configuration, spend, and every failed send in the
 * firm. This page answers the different question that everybody has a
 * legitimate interest in — who did what, and when — and it is scoped so that
 * each reader sees exactly the events they could already have reconstructed
 * from the proposals they are allowed to open. See `scopeClause` in
 * lib/activity.ts.
 *
 * It exists because the approval step is the whole point of the product. A
 * control that says "a different person has to approve this" is only worth
 * something if there is a record of which person did, and that record has to
 * be readable inside the application rather than by whoever has the platform
 * log viewer open.
 *
 * Everything is driven by the query string rather than client state: a filter
 * a reviewer can paste into a message is worth more than one that animates.
 */

type Search = { person?: string; group?: string; outcome?: string; page?: string };

const OUTCOMES = [
  { key: "", label: "Any outcome" },
  { key: "ok", label: "Succeeded" },
  { key: "denied", label: "Refused" },
  { key: "error", label: "Failed" },
] as const;

function isGroupKey(value: string | undefined): value is ActionGroupKey {
  return ACTION_GROUPS.some((g) => g.key === value);
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/activity");

  const sp = await searchParams;
  const group: ActionGroupKey = isGroupKey(sp.group) ? sp.group : "all";
  const outcome = OUTCOMES.some((o) => o.key === sp.outcome && o.key !== "")
    ? (sp.outcome as "ok" | "denied" | "error")
    : null;
  /**
   * A salesperson's own id is the only person filter they can hold. Rather
   * than refusing an id they are not entitled to — which would confirm it
   * exists — the filter is ANDed with the visibility scope in the query, so
   * an id belonging to somebody else simply matches nothing.
   */
  const person = sp.person && sp.person.length > 0 ? sp.person : null;

  /**
   * One page is 50 rows, and 51 are fetched.
   *
   * The extra row is how "is there a next page" is answered without a second
   * COUNT over a table that only grows. It is sliced off before rendering, so
   * it is never shown; its only job is to exist or not.
   */
  const pageNumber = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (pageNumber - 1) * DEFAULT_PAGE_SIZE;

  const [totals, actors, fetched] = await Promise.all([
    activityTotals(user),
    listActors(user),
    listActivity(user, {
      actorId: person,
      group,
      outcome,
      limit: DEFAULT_PAGE_SIZE + 1,
      offset,
    }),
  ]);

  const hasNext = fetched.length > DEFAULT_PAGE_SIZE;
  const rows = hasNext ? fetched.slice(0, DEFAULT_PAGE_SIZE) : fetched;
  const firstIndex = offset + 1;
  const lastIndex = offset + rows.length;

  const selected = actors.find((a) => a.actor_id === person) ?? null;
  const canSeeOthers = user.role === "admin" || user.role === "approver";

  /**
   * Preserves the other filters when one of them changes.
   *
   * Changing a filter resets to page one unless a page is passed explicitly.
   * Without that, narrowing a 200-row trail to a 3-row one while sitting on
   * page 4 shows an empty table and no way to tell that from "nothing
   * matched" — the filter would look broken when it had merely worked.
   */
  function href(next: Partial<Search>): string {
    const params = new URLSearchParams();
    const merged = { person, group, outcome: outcome ?? "", page: "1", ...next };
    if (merged.person) params.set("person", merged.person);
    if (merged.group && merged.group !== "all") params.set("group", merged.group);
    if (merged.outcome) params.set("outcome", merged.outcome);
    if (merged.page && merged.page !== "1") params.set("page", merged.page);
    const qs = params.toString();
    return qs ? `/activity?${qs}` : "/activity";
  }

  return (
    <AppShell user={user}>
      <PageHeader
        title="Activity"
        description={
          user.role === "admin"
            ? "Every action recorded against every account, with its outcome. This is the events table read by person rather than by failure."
            : canSeeOthers
              ? "Every action recorded against a proposal, plus your own sign-ins. Approvers see the whole proposal trail because they can already open any proposal."
              : "Every action you have taken, and everything that has happened to the proposals you wrote."
        }
        actions={
          user.role === "admin" ? (
            <Link href="/system" className="btn btn-sm no-underline hover:no-underline">
              System health and spend
            </Link>
          ) : undefined
        }
      />

      <section
        className="mb-7 grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
      >
        <MetricTile
          label="Events visible to you"
          value={totals.events.toLocaleString()}
          detail={`${totals.today.toLocaleString()} in the last 24 hours`}
        />
        <MetricTile
          label="Approvals"
          value={totals.approvals.toLocaleString()}
          detail="Each one names the person who gave it"
        />
        <MetricTile
          label="Sends to a client"
          value={totals.sends.toLocaleString()}
          detail="Recorded only when a send actually completed"
        />
        <MetricTile
          label="Refused"
          value={totals.refused.toLocaleString()}
          detail="A permission or state check doing its job"
        />
      </section>

      {/* ------------------------------------------------------- people ---- */}
      {canSeeOthers && actors.length > 0 ? (
        <section className="mb-7">
          <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
            <h2 className="section-heading">People</h2>
            <span className="hint m-0">
              Select a row to read one person&rsquo;s trail. Counts are actions taken, so a
              proposal approved and then withdrawn shows both.
            </span>
          </div>
          <div className="card scroll-x">
            <table className="tbl tbl-hover t-sm">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col" className="tbl-num">Events</th>
                  <th scope="col" className="tbl-num">Proposals</th>
                  <th scope="col" className="tbl-num">Drafted</th>
                  <th scope="col" className="tbl-num">Approvals</th>
                  <th scope="col" className="tbl-num">Sends</th>
                  <th scope="col" className="tbl-num">Refused</th>
                  <th scope="col" className="tbl-num">Failed</th>
                  <th scope="col">Last active</th>
                </tr>
              </thead>
              <tbody>
                {actors.map((a) => {
                  const isSelected = a.actor_id === person;
                  return (
                    /*
                      `data-selected`, not `aria-selected`. A row in a plain
                      table is not a selectable widget, and `aria-selected`
                      outside a grid or listbox is a lie told to a screen
                      reader. The link inside the row already carries the
                      state in its own text.
                    */
                    <tr key={a.actor_id} data-selected={isSelected || undefined}>
                      <td>
                        <Link
                          href={href({ person: isSelected ? "" : a.actor_id })}
                          className="row-link no-underline hover:no-underline"
                        >
                          <span className="font-medium">{a.name}</span>{" "}
                          <span className="text-[var(--muted)]">{a.email}</span>
                          {isSelected ? (
                            <span className="ml-1.5 text-[var(--muted)]">· clear</span>
                          ) : null}
                        </Link>
                      </td>
                      <td>
                        <Badge
                          tone={a.role === "admin" ? "attention" : a.role === "approver" ? "good" : "neutral"}
                          glyph={a.role === "admin" ? "▲" : a.role === "approver" ? "●" : "○"}
                        >
                          {a.role}
                        </Badge>
                        {a.is_active ? null : (
                          <span className="ml-1.5 t-xs text-[var(--muted)]">deactivated</span>
                        )}
                      </td>
                      <td className="tbl-num">{a.events}</td>
                      <td className="tbl-num text-[var(--ink-2)]">{a.proposals}</td>
                      <td className="tbl-num text-[var(--ink-2)]">{a.drafted}</td>
                      <td className="tbl-num font-medium">{a.approvals}</td>
                      <td className="tbl-num">{a.sends}</td>
                      <td className="tbl-num text-[var(--muted)]">{a.refused}</td>
                      <td className={`tbl-num ${a.failed > 0 ? "text-[var(--bad)]" : "text-[var(--muted)]"}`}>
                        {a.failed}
                      </td>
                      <td className="whitespace-nowrap text-[var(--muted)]">
                        {a.last_at ? <TimeAgo at={a.last_at} /> : "·"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------ the log ---- */}
      <section>
        <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
          <h2 className="section-heading">
            {selected ? `${selected.name}’s trail` : "The trail"}
          </h2>
          {selected ? (
            <Link href={href({ person: "" })} className="hint m-0">
              Show everyone
            </Link>
          ) : null}
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <nav className="filter-bar" aria-label="Filter by kind of action">
            {ACTION_GROUPS.map((g) => (
              <Link
                key={g.key}
                href={href({ group: g.key })}
                aria-current={g.key === group ? "page" : undefined}
                className={`filter-chip no-underline hover:no-underline ${
                  g.key === group ? "is-active" : ""
                }`}
              >
                {g.label}
              </Link>
            ))}
          </nav>
          <nav className="filter-bar" aria-label="Filter by outcome">
            {OUTCOMES.map((o) => (
              <Link
                key={o.key || "any"}
                href={href({ outcome: o.key })}
                aria-current={(o.key || null) === outcome ? "page" : undefined}
                className={`filter-chip no-underline hover:no-underline ${
                  (o.key || null) === outcome ? "is-active" : ""
                }`}
              >
                {o.label}
              </Link>
            ))}
          </nav>
        </div>

        {rows.length === 0 ? (
          <EmptyState title="Nothing recorded under those filters">
            Every action in the application writes a row here as it happens. An empty list
            means this combination of person, kind and outcome has not occurred, not that
            logging is off.
          </EmptyState>
        ) : (
          <div className="card scroll-x">
            <table className="tbl tbl-hover t-sm">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Person</th>
                  <th scope="col">What happened</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Proposal</th>
                  <th scope="col" className="tbl-num">Took</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-[var(--muted)]">
                      <TimeAgo at={r.at} />
                    </td>
                    <td className="whitespace-nowrap">
                      {r.actor_name ? (
                        <span title={r.actor_email ?? undefined}>{r.actor_name}</span>
                      ) : (
                        /* An event whose actor was removed, or one the erasure
                           trigger scrubbed. The row stays; the person does not. */
                        <span className="text-[var(--muted)]">system</span>
                      )}
                    </td>
                    <td>
                      <span className="font-medium">{actionLabel(r.action)}</span>
                      <span className="mono ml-1.5 t-2xs text-[var(--muted)]">{r.action}</span>
                    </td>
                    <td>
                      {r.outcome === "ok" ? (
                        <Badge tone="good" glyph="✓">done</Badge>
                      ) : r.outcome === "denied" ? (
                        <Badge tone="neutral" glyph="○">refused</Badge>
                      ) : r.outcome === "error" ? (
                        <Badge tone="bad" glyph="■">failed</Badge>
                      ) : (
                        <Badge tone="neutral" glyph="○">skipped</Badge>
                      )}
                      {r.error_code ? (
                        <span className="mono ml-1.5 t-2xs text-[var(--muted)]">
                          {r.error_code}
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap">
                      {r.proposal_ref ? (
                        <Link
                          href={`/proposals/${r.proposal_id}`}
                          className="mono no-underline hover:underline"
                          title={r.proposal_company ?? undefined}
                        >
                          {r.proposal_ref}
                        </Link>
                      ) : (
                        <span className="text-[var(--muted)]">·</span>
                      )}
                    </td>
                    <td className="tbl-num text-[var(--muted)]">
                      {r.latency_ms === null ? "·" : `${r.latency_ms} ms`}
                    </td>
                    <td className="mono t-xs text-[var(--muted)]">{r.correlation_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/*
          The pager is rendered whenever there is more than one page in either
          direction, and it names the range rather than only the page number.
          "51 to 100" tells a reader where they are in a log; "page 2" makes
          them do the arithmetic.
        */}
        {rows.length > 0 && (hasNext || pageNumber > 1) ? (
          <nav
            className="mt-3 flex flex-wrap items-center gap-3"
            aria-label="Pages of the activity trail"
          >
            <Link
              href={href({ page: String(pageNumber - 1) })}
              aria-disabled={pageNumber === 1 || undefined}
              className={`btn btn-sm no-underline hover:no-underline ${
                pageNumber === 1 ? "pointer-events-none opacity-40" : ""
              }`}
            >
              ← Newer
            </Link>
            <Link
              href={href({ page: String(pageNumber + 1) })}
              aria-disabled={!hasNext || undefined}
              className={`btn btn-sm no-underline hover:no-underline ${
                hasNext ? "" : "pointer-events-none opacity-40"
              }`}
            >
              Older →
            </Link>
            <span className="hint m-0">
              Showing {firstIndex.toLocaleString()} to {lastIndex.toLocaleString()}
              {selected ? ` of ${selected.name}’s trail` : ""}, newest first.
              {hasNext ? "" : " This is the end of the trail."}
            </span>
          </nav>
        ) : null}

      </section>
    </AppShell>
  );
}
