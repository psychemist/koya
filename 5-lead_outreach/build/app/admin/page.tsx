import { requireAdminPage, roleLabel } from '../../lib/auth.ts';
import { query } from '../../lib/db.ts';
import { config } from '../../lib/config.ts';
import { SignOut } from '../ui/sign-out';

export const dynamic = 'force-dynamic';

type Member = {
  id: string; email: string; name: string; role: string;
  created_at: Date; last_seen_at: Date | null;
  runs: string; qualified: string; apify: string; claude: string;
};

type Spend = { provider: string; today: string; all_time: string };

type HistoryRow = {
  id: string; objective: string; status: string; created_at: Date;
  owner: string | null; qualified: string; assessed: string;
  apify_spend_usd: string; claude_cost_usd: string; agent_turns: number;
  flagged: string; shortfall_reason: string | null;
};

const money = (v: string | number) => `$${Number(v ?? 0).toFixed(2)}`;
const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : 'never');

export default async function AdminPage() {
  const admin = await requireAdminPage('/admin');

  const [members, spend, history, dailyApify] = await Promise.all([
    query<Member>(
      `select u.id, u.email, u.name, u.role, u.created_at, u.last_seen_at,
              count(distinct r.id)::text                                   as runs,
              coalesce(sum(agg.qualified), 0)::text                        as qualified,
              coalesce(sum(r.apify_spend_usd), 0)::text                    as apify,
              coalesce(sum(r.claude_cost_usd), 0)::text                    as claude
         from public.users u
         left join public.runs r on r.created_by = u.id
         left join lateral (
           select count(*) filter (where l.qualification_status = 'qualified') as qualified
             from public.leads l where l.run_id = r.id
         ) agg on true
        group by u.id
        order by u.role, u.name`),

    query<Spend>(
      `select provider,
              coalesce(sum(amount_usd) filter (
                where created_at >= date_trunc('day', now() at time zone 'utc')), 0)::text as today,
              coalesce(sum(amount_usd), 0)::text as all_time
         from public.spend_ledger
        group by provider order by provider`),

    query<HistoryRow>(
      `select r.id, r.objective, r.status, r.created_at, r.agent_turns,
              r.apify_spend_usd, r.claude_cost_usd, r.shortfall_reason,
              u.name as owner,
              count(l.*) filter (where l.qualification_status = 'qualified')::text as qualified,
              count(l.*)::text as assessed,
              (select count(*) from public.scraped_pages p
                where p.run_id = r.id and p.injection_flagged)::text as flagged
         from public.runs r
         left join public.users u on u.id = r.created_by
         left join public.leads l on l.run_id = r.id
        group by r.id, u.name
        order by r.created_at desc
        limit 100`),

    query<{ total: string }>(
      `select coalesce(sum(amount_usd), 0)::text as total
         from public.spend_ledger
        where provider = 'apify'
          and created_at >= date_trunc('day', now() at time zone 'utc')`),
  ]);

  const apifyToday = Number(dailyApify[0]?.total ?? 0);
  const dailyCap = config.limits.dailyApifyCapUsd;
  const capState = apifyToday >= dailyCap ? 'state-failed'
    : apifyToday >= dailyCap * 0.75 ? 'state-degraded' : 'state-sent';

  const totalFlagged = history.reduce((n, r) => n + Number(r.flagged), 0);

  return (
    <main className="wrap">
      <div className="topbar">
        <div>
          <h1>Team and spend</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {admin.name}, {roleLabel(admin.role)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <a className="small" href="/">Start a run</a>
          <SignOut />
        </div>
      </div>

      <hr className="rule" />

      <h2>Where the budget went</h2>
      <p className="small muted">
        The discovery account is shared across the cohort, so overspending takes somebody
        else&apos;s share. The cap below is enforced in code, not watched.
      </p>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="strip">
          <div>
            <b>Apify today</b>{' '}
            <span className={capState}>{money(apifyToday)} of {money(dailyCap)}</span>
          </div>
          <div><b>Per-run cap</b> {money(config.limits.runApifyCapUsd)}</div>
          <div><b>Pages flagged as addressing a machine</b> {totalFlagged}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr><th>Provider</th><th>Today</th><th>All time</th></tr>
          </thead>
          <tbody>
            {spend.length === 0
              ? <tr><td colSpan={3} className="muted">Nothing has been spent yet.</td></tr>
              : spend.map((s) => (
                  <tr key={s.provider}>
                    <td>{s.provider}</td>
                    <td>{money(s.today)}</td>
                    <td>{money(s.all_time)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      <h2>The team</h2>
      <div className="card" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Role</th><th>Joined</th><th>Last seen</th>
              <th>Runs</th><th>Qualified</th><th>Spent</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.name}<br /><span className="small muted">{m.email}</span></td>
                <td>{roleLabel(m.role)}</td>
                <td className="muted">{day(m.created_at)}</td>
                <td className="muted">{day(m.last_seen_at)}</td>
                <td>{m.runs}</td>
                <td>{m.qualified}</td>
                <td>{money(Number(m.apify) + Number(m.claude))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Accounts are created by seeding, not from this screen. Adding a person is a
        deliberate act with a shared budget behind it.
      </p>

      <h2>Every run</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Objective</th><th>Started by</th><th>When</th><th>Status</th>
              <th>Qualified</th><th>Assessed</th><th>Turns</th><th>Flagged</th><th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0
              ? <tr><td colSpan={9} className="muted">No runs yet.</td></tr>
              : history.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/runs/${r.id}`}>{r.objective}</a>
                      {r.shortfall_reason && (
                        <><br /><span className="small muted">{r.shortfall_reason}</span></>
                      )}
                    </td>
                    <td>{r.owner ?? <span className="muted">unowned</span>}</td>
                    <td className="muted">{day(r.created_at)}</td>
                    <td>{r.status.replace(/_/g, ' ')}</td>
                    <td>{r.qualified}</td>
                    <td>{r.assessed}</td>
                    <td>{r.agent_turns}</td>
                    <td>{Number(r.flagged) > 0
                      ? <span className="state-failed">{r.flagged}</span>
                      : <span className="muted">0</span>}</td>
                    <td className="muted">
                      {money(Number(r.apify_spend_usd) + Number(r.claude_cost_usd))}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Model cost is a client-side estimate from the SDK, not billing data. The discovery
        figure is what the provider reported for the run.
      </p>
    </main>
  );
}
