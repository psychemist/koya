import { query, pool } from '../lib/db.ts';
import { icpFingerprint } from '../lib/icp.ts';

/**
 * Put the judgements that already happened into `judged_companies`.
 *
 * The table was added on 2026-09-25, after thirty-four companies had already
 * been judged. Without this the overlap report reads zero for weeks and says
 * nothing about whether a cross-run cache is worth building, which is the one
 * question it exists to answer.
 *
 * Idempotent on purpose: counts are computed from the leads and WRITTEN, not
 * incremented, so running this twice does not invent repeats that never
 * happened. A measurement that inflates itself on re-run is worse than none.
 */
const leads = await query<{
  company_domain: string; qualification_status: string; run_id: string;
  created_at: Date; icp: unknown;
}>(
  `select l.company_domain, l.qualification_status, l.run_id, l.created_at, r.icp
     from public.leads l
     join public.runs r on r.id = l.run_id
    where r.icp is not null
    order by l.created_at`,
);

type Cell = { count: number; verdict: string; runId: string; first: Date; last: Date };
const cells = new Map<string, Cell>();
const fingerprints = new Map<string, string>();

for (const l of leads) {
  let fp = fingerprints.get(l.run_id);
  if (!fp) { fp = icpFingerprint(l.icp); fingerprints.set(l.run_id, fp); }

  const key = `${l.company_domain}\u0000${fp}`;
  const seen = cells.get(key);
  // Later rows win the verdict, because the most recent judgement is the one
  // that still stands.
  cells.set(key, {
    count: (seen?.count ?? 0) + 1,
    verdict: l.qualification_status,
    runId: l.run_id,
    first: seen?.first ?? l.created_at,
    last: l.created_at,
  });
}

let written = 0;
for (const [key, cell] of cells) {
  const [domain, fingerprint] = key.split('\u0000');
  await query(
    `insert into public.judged_companies
       (company_domain, icp_fingerprint, verdict, run_id, times_judged,
        first_judged_at, judged_at)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (company_domain, icp_fingerprint) do update
       set verdict         = excluded.verdict,
           run_id          = excluded.run_id,
           times_judged    = excluded.times_judged,
           first_judged_at = least(public.judged_companies.first_judged_at,
                                   excluded.first_judged_at),
           judged_at       = greatest(public.judged_companies.judged_at,
                                      excluded.judged_at)`,
    [domain, fingerprint, cell.verdict, cell.runId, cell.count, cell.first, cell.last],
  );
  written++;
}

console.log(`leads read:                 ${leads.length}`);
console.log(`runs with a stored ICP:     ${fingerprints.size}`);
console.log(`company/ICP pairs written:  ${written}`);
console.log(`repeat judgements found:    ${leads.length - written}`);

await pool().end();
