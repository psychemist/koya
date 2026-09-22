import { query } from '../db.ts';
import { EMAIL_RE, ROLE_LOCALPARTS } from './house-style.ts';

export type Dimension = {
  dimension: string;
  passed: boolean;
  detail: string;
};

export type Scorecard = {
  qualified: number;
  dimensions: Dimension[];
  passed: boolean;
};

const ok = (dimension: string, detail: string): Dimension =>
  ({ dimension, passed: true, detail });
const bad = (dimension: string, detail: string): Dimension =>
  ({ dimension, passed: false, detail });

type QualifiedLead = {
  id: string; company_name: string; company_domain: string; confidence: string;
  fit_reasons: string[]; source_urls: string[]; source_summary: string | null;
  drafts_blocked: string | null; draft_count: string; bodies: string[] | null;
};

/**
 * The scorecard, recomputed from the stored rows.
 *
 * The `lead-list-quality` skill tells the agent "finish_run recomputes this
 * scorecard in code", and until this existed that was a promise the code did
 * not keep: `finish_run` compared one integer. An agent that says the list is
 * good is the thing being checked, so its account of the list cannot be the
 * check.
 *
 * Every dimension is computed from what is in the database, never from an
 * argument the agent supplied.
 */
export async function recomputeScorecard(runId: string): Promise<Scorecard> {
  const leads = await query<QualifiedLead>(
    `select l.id, l.company_name, l.company_domain, l.confidence, l.fit_reasons,
            l.source_urls, l.source_summary, l.drafts_blocked,
            count(d.*)::text as draft_count,
            array_remove(array_agg(d.body), null) as bodies
       from public.leads l
       left join public.outreach_drafts d on d.lead_id = l.id
      where l.run_id = $1 and l.qualification_status = 'qualified'
      group by l.id`,
    [runId],
  );

  const dimensions: Dimension[] = [];
  const name = (l: QualifiedLead) => l.company_name || l.company_domain;

  // ICP fit: every qualified lead names why it fits.
  const noReasons = leads.filter((l) => l.fit_reasons.length === 0);
  dimensions.push(noReasons.length
    ? bad('ICP fit', `${noReasons.map(name).join(', ')} qualified with no stated reason.`)
    : ok('ICP fit', `All ${leads.length} qualified leads name the criteria they satisfy.`));

  // Evidence quality: the sources cited were actually retrieved by this run.
  const retrieved = new Set(
    (await query<{ url: string }>(
      'select url from public.scraped_pages where run_id = $1', [runId])).map((r) => r.url));
  const unsupported = leads.filter(
    (l) => !l.source_urls.some((u) => retrieved.has(u)));
  dimensions.push(unsupported.length
    ? bad('Evidence quality',
        `${unsupported.map(name).join(', ')} cite no page this run actually retrieved.`)
    : ok('Evidence quality', 'Every verdict rests on a page this run fetched.'));

  // Duplicate rate: one row per company.
  const dupes = await query<{ company_domain: string }>(
    `select company_domain from public.leads where run_id = $1
      group by company_domain having count(*) > 1`, [runId]);
  dimensions.push(dupes.length
    ? bad('Duplicate rate', `Repeated: ${dupes.map((d) => d.company_domain).join(', ')}.`)
    : ok('Duplicate rate', 'No company appears twice.'));

  // Outreach relevance: a qualified lead has drafts, or a stated reason it has none.
  const undrafted = leads.filter(
    (l) => Number(l.draft_count) === 0 && !l.drafts_blocked);
  dimensions.push(undrafted.length
    ? bad('Outreach relevance',
        `${undrafted.map(name).join(', ')} have neither drafts nor a reason they are blocked.`)
    : ok('Outreach relevance', 'Every qualified lead has drafts or a stated blocker.'));

  // Data completeness: the fields a reviewer reads are present.
  const incomplete = leads.filter(
    (l) => !l.company_name || !l.company_domain || !l.source_summary);
  dimensions.push(incomplete.length
    ? bad('Data completeness',
        `${incomplete.map(name).join(', ')} are missing a name, a domain or a source summary.`)
    : ok('Data completeness', 'Required fields are present on every qualified lead.'));

  // Safety compliance: no personal address reached a stored draft. The gates
  // run per draft on the way in; this re-reads what is actually stored.
  const offenders: string[] = [];
  for (const l of leads) {
    for (const body of l.bodies ?? []) {
      const found = body?.match(EMAIL_RE)?.[0];
      const local = found?.split('@')[0]?.toLowerCase();
      if (found && !(local && ROLE_LOCALPARTS.has(local))) {
        offenders.push(`${name(l)} (${found})`);
        break;
      }
    }
  }
  dimensions.push(offenders.length
    ? bad('Safety compliance', `A personal address is in a stored draft: ${offenders.join(', ')}.`)
    : ok('Safety compliance', 'No personal email address appears in any stored draft.'));

  return {
    qualified: leads.length,
    dimensions,
    passed: dimensions.every((d) => d.passed),
  };
}
