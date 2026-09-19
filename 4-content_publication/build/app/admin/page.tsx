import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserPage, roleLabel } from '@/lib/auth';
import { query, one } from '@/lib/db';
import { capabilities, config } from '@/lib/config';
import { listSubscribers, subscriberCounts } from '@/lib/subscribers';
import Tabs from '@/app/ui/tabs';
import SubscribersPanel from './subscribers-panel';

export const dynamic = 'force-dynamic';

/**
 * The admin page: what this has cost, who it reaches, what is connected, and
 * who is on the team.
 *
 * ALL FOUR ARE READ FROM WHAT ACTUALLY HAPPENED, not from a settings file.
 * Spend comes out of `events.cost_usd`, which every model call writes as it
 * completes. Connection status comes from `capabilities()`, which reports
 * whether a credential is PRESENT and nothing more: it never claims a channel
 * works, because a present token can still be expired, and a page that says
 * "connected" about a 401 is worse than one that says nothing.
 */
export default async function AdminPage() {
  const user = await requireUserPage('/admin');
  // Not a 403. Somebody who cannot see this page should not learn it is here.
  if (user.role !== 'admin') redirect('/');

  const caps = capabilities();

  const [totals, byStage, byRequest, recent, subs, counts, team] = await Promise.all([
    one<any>(
      `select coalesce(sum(cost_usd),0)::float as all_time,
              coalesce(sum(cost_usd) filter (where created_at > now() - interval '30 days'),0)::float as last_30,
              coalesce(sum(cost_usd) filter (where created_at > now() - interval '7 days'),0)::float as last_7,
              count(distinct request_id)::int as requests
         from public.events where cost_usd is not null`).catch(() => null),
    query<any>(
      `select stage, coalesce(sum(cost_usd),0)::float as spent, count(*)::int as calls
         from public.events
        where cost_usd is not null and cost_usd > 0
        group by stage order by spent desc`).catch(() => []),
    query<any>(
      `select r.id, r.idea, r.status, r.cost_usd::float as cost, r.created_at
         from public.content_requests r
        order by r.cost_usd desc nulls last limit 8`).catch(() => []),
    query<any>(
      `select q.channel, q.state, count(*)::int as n
         from public.publish_queue q group by q.channel, q.state
        order by q.channel, q.state`).catch(() => []),
    listSubscribers().catch(() => []),
    subscriberCounts().catch(() => ({ active: 0, unsubscribed: 0 })),
    query<any>(
      `select u.id, u.email, u.name, u.role, u.created_at,
              (select count(*)::int from public.content_requests r where r.requester_id = u.id) as raised,
              (select count(*)::int from public.approvals a
                where a.actor_id = u.id and a.decision = 'approved') as approved
         from public.users u order by u.role, u.created_at`).catch(() => []),
  ]);

  const allTime = totals?.all_time ?? 0;
  const perRequest = totals?.requests ? allTime / totals.requests : 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Admin</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Spend is summed from the audit log, so it is what was actually charged rather than an
          estimate. Connection status says whether a credential is present, never that a channel
          is known to work: a token that is present can still be expired.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Spent, all time" value={`$${allTime.toFixed(2)}`}
              note={`${totals?.requests ?? 0} requests`} />
        <Stat label="Last 30 days" value={`$${(totals?.last_30 ?? 0).toFixed(2)}`}
              note={`$${(totals?.last_7 ?? 0).toFixed(2)} in the last 7`} />
        <Stat label="Average per request" value={`$${perRequest.toFixed(3)}`}
              note="research, planning, drafting, judging and revision" />
        <Stat label="Newsletter reach" value={String(counts.active)}
              note={counts.unsubscribed ? `${counts.unsubscribed} unsubscribed` : 'active subscribers'} />
      </div>

      <Tabs
        tabs={[
          {
            key: 'spend', label: 'Spend',
            panel: <Spend byStage={byStage} byRequest={byRequest} allTime={allTime} />,
          },
          {
            key: 'subscribers', label: 'Subscribers', count: counts.active || undefined,
            panel: <SubscribersPanel rows={subs} />,
          },
          {
            key: 'channels', label: 'Connections',
            panel: <Connections caps={caps} queue={recent} />,
          },
          {
            key: 'team', label: 'Team', count: team.length || undefined,
            panel: <Team rows={team} me={user.id} />,
          },
        ]}
      />
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="sheet p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ spend */

const STAGE_LABEL: Record<string, string> = {
  'research.extract': 'Reading and scoring sources',
  'attachment.read': 'Transcribing attachments',
  'plan.angles': 'Planning angles (Opus)',
  'generate.draft': 'Writing the article (Sonnet)',
  'generate.adapt': 'Adapting for channels (Sonnet)',
  'evaluate.tier1': 'Judging (Haiku)',
  'revise.loop': 'Revising',
};

function Spend({ byStage, byRequest, allTime }: {
  byStage: any[]; byRequest: any[]; allTime: number;
}) {
  if (byStage.length === 0) {
    return (
      <p className="sheet p-10 text-center text-sm text-muted">
        Nothing has been spent yet. Every model call writes what it cost to the audit log as it
        finishes, and this page sums that.
      </p>
    );
  }

  const top = byStage[0]?.spent ?? 1;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="sheet overflow-hidden">
        <header className="border-b border-rule bg-sunk/40 px-4 py-3">
          <h2 className="text-sm font-semibold">Where the money goes</h2>
          <p className="mt-0.5 text-xs text-muted">
            By pipeline stage, all time. The bar is relative to the largest line.
          </p>
        </header>
        <ul className="divide-y divide-rule">
          {byStage.map((s: any) => (
            <li key={s.stage} className="px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm">
                  {STAGE_LABEL[s.stage] ?? s.stage.replace(/[._]/g, ' ')}
                </span>
                <span className="shrink-0 text-sm tabular-nums">${s.spent.toFixed(3)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-sunk">
                  <div className="h-full rounded-full bg-waiting"
                       style={{ width: `${Math.max(2, (s.spent / top) * 100)}%` }} />
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {s.calls} call{s.calls === 1 ? '' : 's'}
                  {allTime > 0 && `, ${((s.spent / allTime) * 100).toFixed(0)}%`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="sheet overflow-hidden">
        <header className="border-b border-rule bg-sunk/40 px-4 py-3">
          <h2 className="text-sm font-semibold">Most expensive requests</h2>
          <p className="mt-0.5 text-xs text-muted">
            A request that cost far more than the rest usually means a run that failed and was
            retried, which is worth reading rather than averaging away.
          </p>
        </header>
        <ul className="divide-y divide-rule">
          {byRequest.map((r: any) => (
            <li key={r.id} className="flex items-baseline gap-3 px-4 py-2.5">
              <Link href={`/requests/${r.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                {r.idea}
              </Link>
              <span className="shrink-0 text-xs text-muted">{r.status.replace(/_/g, ' ')}</span>
              <span className="shrink-0 text-sm tabular-nums">${Number(r.cost ?? 0).toFixed(3)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ connections */

type Cap = {
  key: string; label: string; live: boolean; free: boolean;
  what: string; how: string;
};

function Connections({ caps, queue }: { caps: Record<string, boolean>; queue: any[] }) {
  const rows: Cap[] = [
    {
      key: 'linkedin', label: 'LinkedIn', live: caps.publish_linkedin, free: true,
      what: 'Posts to a named member profile. Free: the self-serve "Share on LinkedIn" product grants w_member_social with no review. The partner queue people get stuck in is for company pages and posting on behalf of others, which this does not do.',
      how: 'Set LINKEDIN_ACCESS_TOKEN and LINKEDIN_MEMBER_URN. Without them the queue records blocked, never a false sent, and the post can still be published free from the request screen.',
    },
    {
      key: 'x', label: 'X', live: caps.publish_x, free: false,
      what: 'The only channel here that bills per post. No free tier since February 2026: $0.015 a post, $0.20 if it contains a link. Off by default and opted into per request.',
      how: 'Set the four X_* keys and FEATURE_X_PUBLISH=true. There is no free API route, so with this off the request screen offers X’s own composer, pre-filled, which costs nothing.',
    },
    {
      key: 'newsletter', label: 'Newsletter', live: caps.notifications_n8n || caps.notifications_email_fallback, free: true,
      what: 'Sent through n8n, where a Gmail credential sends as a real mailbox. Gmail needs no verified domain and costs nothing, which is why it is primary.',
      how: 'Set N8N_PUBLISH_WEBHOOK_URL and N8N_PUBLISH_SECRET, and import n8n/koya-newsletter.json. Resend is the fallback and only reaches arbitrary addresses once a domain is verified. Gmail caps at a few hundred recipients a day; that is the real limit of this lane.',
    },
    {
      key: 'notify', label: 'Alerts, email and Discord', live: caps.notifications_n8n, free: true,
      what: 'One signed event per state change goes to n8n, which fans it out to Gmail and the two Discord channels. The credentials live in n8n rather than here, so this app cannot leak what it never holds.',
      how: 'Set N8N_NOTIFY_WEBHOOK_URL and N8N_NOTIFY_SECRET, and import n8n/koya-notifications.json. Without them the app falls back to Resend directly, Discord is lost, and the request page marks those notifications "Email only" rather than "Sent".',
    },
    {
      key: 'resend', label: 'Resend fallback', live: caps.notifications_email_fallback, free: true,
      what: 'The lane used only when n8n is unreachable. Reaches the person who has to act; Discord is lost in that case, and the email says so.',
      how: 'Set RESEND_API_KEY. Note it delivers to addresses other than the account owner only from a verified domain, which is exactly why it is not first.',
    },
    {
      key: 'firecrawl', label: 'Firecrawl', live: caps.research_firecrawl, free: false,
      what: 'Primary scraper. Absent, research falls back to Claude web_fetch, which costs nothing beyond tokens and degrades rather than stops.',
      how: 'Set FIRECRAWL_API_KEY.',
    },
  ];

  return (
    <div className="space-y-5">
      <ul className="sheet divide-y divide-rule overflow-hidden">
        {rows.map((c) => (
          <li key={c.key} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 px-4 py-3.5">
            <span className={`pill mt-0.5 justify-center ${
              c.live ? 'bg-ok-bg text-ok' : 'bg-sunk text-ink-70'}`}>
              {c.live ? 'Connected' : 'Off'}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                {c.label}
                <span className={`pill ${c.free ? 'bg-ok-bg text-ok' : 'bg-advisory-bg text-advisory'}`}>
                  {c.free ? 'free' : 'paid'}
                </span>
              </p>
              <p className="mt-1 text-xs text-ink-70">{c.what}</p>
              {!c.live && <p className="mt-1 text-xs text-muted">{c.how}</p>}
            </div>
          </li>
        ))}
      </ul>

      {queue.length > 0 && (
        <section className="sheet overflow-hidden">
          <header className="border-b border-rule bg-sunk/40 px-4 py-3">
            <h2 className="text-sm font-semibold">What the queue has recorded</h2>
            <p className="mt-0.5 text-xs text-muted">
              Every row a connector has written. `blocked` is what a channel with no credentials
              records, and it is never reported as sent.
            </p>
          </header>
          <ul className="divide-y divide-rule text-sm">
            {queue.map((q: any, i: number) => (
              <li key={i} className="flex items-baseline gap-3 px-4 py-2">
                <span className="w-24 shrink-0 capitalize">{q.channel}</span>
                <span className="flex-1 text-muted">{q.state.replace(/_/g, ' ')}</span>
                <span className="tabular-nums">{q.n}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {config.demoRoleSwitch && (
        <p className="sheet border-advisory/30 bg-advisory-bg p-3.5 text-sm">
          The demo role switcher is on. An admin can move their session into the seeded manager
          or editor account from the masthead. It switches IDENTITY rather than role, so
          separation of duties still holds: the person who raised a request still cannot decide
          on it. Set DEMO_ROLE_SWITCH=false to remove it.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- team */

function Team({ rows, me }: { rows: any[]; me: string }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Roles are enforced in the route handlers, not in the interface. An editor approves,
        sends back and rejects; a manager raises requests. Nobody decides on their own work,
        whatever their role.
      </p>

      <ul className="sheet divide-y divide-rule overflow-hidden">
        {rows.map((u: any) => (
          <li key={u.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3">
            <span className="pill justify-center bg-sunk text-ink-70">{roleLabel(u.role)}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {u.name}
                {u.id === me && <span className="ml-1.5 font-normal text-muted">you</span>}
              </span>
              <span className="block truncate text-xs text-muted">{u.email}</span>
            </span>
            <span className="shrink-0 text-right text-xs tabular-nums text-muted">
              <span className="block">{u.raised} raised</span>
              <span className="block">{u.approved} approved</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted">
        Accounts are created by the seed script, so adding a team member is a deliberate change
        to scripts/seed.ts rather than a form on this page. An invite flow would need email
        verification and a password reset path to be worth having, and a half-built one is a
        way in rather than a feature.
      </p>
    </div>
  );
}
