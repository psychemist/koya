import { query, pool } from '../lib/db.ts';
import { icpFingerprint } from '../lib/icp.ts';

/**
 * How much work a cross-run cache would actually have saved.
 *
 * Every run currently discards what it learned, and the obvious fix is a
 * cross-run cache of company facts and verdicts. That fix is a substantial
 * subsystem resting on an untested assumption: that runs overlap at all. This
 * reports the evidence rather than assuming it.
 *
 * Read-only. It spends nothing and changes nothing.
 */
const runs = await query<{ id: string; icp: unknown; objective: string; created_at: Date }>(
  'select id, icp, objective, created_at from public.runs where icp is not null order by created_at',
);

const byIcp = new Map<string, { runs: number; objective: string }>();
for (const r of runs) {
  const key = icpFingerprint(r.icp);
  const seen = byIcp.get(key);
  byIcp.set(key, { runs: (seen?.runs ?? 0) + 1, objective: seen?.objective ?? r.objective });
}

const [totals] = await query<{ pairs: string; judgements: string; repeats: string }>(
  `select count(*)::text                                as pairs,
          coalesce(sum(times_judged),0)::text           as judgements,
          coalesce(sum(times_judged - 1),0)::text       as repeats
     from public.judged_companies`,
);

const crossIcp = await query<{ company_domain: string; n: string }>(
  `select company_domain, count(*)::text as n
     from public.judged_companies group by 1 having count(*) > 1 order by 2 desc limit 10`,
);

console.log(`runs with a stored ICP:        ${runs.length}`);
console.log(`distinct ICPs among them:      ${byIcp.size}`);
console.log(`ICPs used by more than one run: ` +
  `${[...byIcp.values()].filter((v) => v.runs > 1).length}`);
console.log();
console.log(`company/ICP pairs judged:      ${totals?.pairs ?? 0}`);
console.log(`judgements made in total:      ${totals?.judgements ?? 0}`);
console.log(`re-judgements a cache would have skipped: ${totals?.repeats ?? 0}`);

if (Number(totals?.repeats ?? 0) === 0) {
  console.log('\nNo run has yet re-judged a company under criteria it had already used.');
  console.log('On this evidence a cross-run verdict cache would save nothing. Run more');
  console.log('runs, including a repeat of an earlier ICP, before building one.');
}

if (crossIcp.length) {
  console.log('\nCompanies met under more than one ICP (facts reusable, verdicts not):');
  for (const r of crossIcp) console.log(`  ${r.company_domain}  ${r.n} different ICPs`);
}

await pool().end();
