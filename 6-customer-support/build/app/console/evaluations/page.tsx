import { listEvaluations } from '../../../lib/console.ts';
import { canSeeEvaluations } from '../../../lib/auth.ts';
import { requireConsoleUser } from '../../../lib/console-session.ts';
import { ManualEvaluation } from '../../ui/manual-evaluation.tsx';
import { usd, utc } from '../../ui/format.ts';
import { Pill } from '../../ui/pill.tsx';

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

export default async function Evaluations() {
  const user = await requireConsoleUser('/console/evaluations');
  if (!canSeeEvaluations(user)) return (
    <>
      <h1>Evaluations</h1>
      <p className="rp-lede">Evaluations are for admins. Ask an admin if you need a test result.</p>
    </>
  );
  const rows = await listEvaluations();
  const runs = new Map<string, any[]>();
  for (const r of rows) runs.set(r.eval_run_id, [...(runs.get(r.eval_run_id) ?? []), r]);
  return (
    <>
      <h1>Evaluations</h1>
      {runs.size === 0 && <p className="rp-lede">No evaluations yet. Run npm run eval, or record a manual one below.</p>}
      {[...runs.entries()].map(([id, rs]) => {
        const lat50 = rs.map((r) => r.latency_p50_ms).filter((x) => x != null), lat95 = rs.map((r) => r.latency_p95_ms).filter((x) => x != null);
        const cost = rs.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
        const models = [...new Set(rs.map((r) => r.model).filter(Boolean))].join(', ') || (rs.every((r) => r.source === 'manual') ? 'manual' : '');
        return (
          <section key={id} className="rp-run" aria-label={`Evaluation run ${id}`}>
            <h2>{utc(rs.at(-1).created_at)}: {rs.filter((r) => r.passed).length} of {rs.length} passed</h2>
            <p className="rp-mute">{models}{lat50.length ? `, p50 ${pct(lat50, 50)} ms, p95 ${pct(lat95, 95)} ms` : ''}{cost ? `, ${usd(cost)} total` : ''}</p>
            <div className="rp-table-wrap"><table className="rp-table">
              <thead><tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Notes</th></tr></thead>
              <tbody>{rs.map((r) => (
                <tr key={r.id} data-attention={r.passed ? undefined : 'true'}>
                  <td>{r.scenario_title}{r.source === 'manual' ? ' (manual)' : ''}</td><td className="rp-clip">{r.expected_behavior}</td>
                  <td className="rp-clip">{r.actual_behavior}</td><td><Pill value={r.passed ? 'pass' : 'fail'} label={r.passed ? 'Pass' : 'Fail'} /></td><td className="rp-clip">{r.notes ?? ''}</td>
                </tr>))}
              </tbody></table></div>
          </section>);
      })}
      <h2>Record manual evaluation</h2>
      <ManualEvaluation />
    </>
  );
}
