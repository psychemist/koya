import { currentUser } from '../lib/auth.ts';
import { query } from '../lib/db.ts';
import { SignIn } from './ui/sign-in';
import { IntakeForm } from './ui/intake-form';
import { Nav } from './ui/nav';
import { runStateClass } from './ui/status';

export const dynamic = 'force-dynamic';

type MyRun = {
  id: string; objective: string; status: string; created_at: Date;
  qualified: string; assessed: string; apify_spend_usd: string; claude_cost_usd: string;
};

const money = (v: string | number) => `$${Number(v ?? 0).toFixed(2)}`;
const day = (d: Date) => new Date(d).toISOString().slice(0, 10);

export default async function Home({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await currentUser();

  if (!user) return <SignIn next={next} />;

  // What this person has created. An operator sees their own work; the
  // team-wide view lives on the admin page, where the budget question belongs.
  const runs = await query<MyRun>(
    `select r.id, r.objective, r.status, r.created_at,
            r.apify_spend_usd, r.claude_cost_usd,
            count(l.*) filter (where l.qualification_status = 'qualified')::text as qualified,
            count(l.*)::text as assessed
       from public.runs r
       left join public.leads l on l.run_id = r.id
      where r.created_by = $1
      group by r.id
      order by r.created_at desc
      limit 50`,
    [user.id],
  );

  return (
    <>
      <Nav user={user} current="runs" />
      <main className="wrap">
      <h1>Start a run</h1>
      <p className="small muted">Describe what you are looking for. Nothing is sent to anyone.</p>

      <hr className="rule" />

      <IntakeForm />

      <hr className="rule" />

      <h2>Runs you have started</h2>
      {runs.length === 0 ? (
        <p className="muted">Nothing yet. The first run you start appears here.</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Objective</th><th>Started</th><th>Status</th>
                <th>Qualified</th><th>Assessed</th><th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/runs/${r.id}`}>{r.objective}</a></td>
                  <td className="muted">{day(r.created_at)}</td>
                  <td>
                    <span className={runStateClass(r.status)}>
                      {r.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>{r.qualified}</td>
                  <td>{r.assessed}</td>
                  <td className="muted">
                    {money(Number(r.apify_spend_usd) + Number(r.claude_cost_usd))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Cost combines the provider's reported discovery charge with a client-side model
        estimate. It is not billing data.
      </p>
      </main>
    </>
  );
}
