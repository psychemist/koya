import { tx } from './db.ts';
import { ProviderError } from './errors.ts';

/**
 * The reviewer's decision, applied rather than recorded beside the lead.
 *
 * Before this, accepting a needs_review lead wrote `human_status`, rendered
 * "You marked this accepted", and did nothing else: the lead did not qualify,
 * did not count toward the target, produced no drafts, never reached the
 * delivered list, and never reached a later run. A control that changes
 * nothing is worse than no control, because the reviewer believes they acted.
 *
 * The decision now moves `qualification_status` itself, which is what
 * `runStats`, `finish_run` and the delivered list already read. What the agent
 * said is preserved in `agent_verdict`, so the trail records an override
 * rather than an erasure.
 */
export type HumanVerdict = 'accepted' | 'rejected';

export type VerdictOutcome = {
  status: string;
  promoted: boolean;
  demoted: boolean;
  /** True when the promotion left the lead with no copy to send. */
  draftsBlocked: boolean;
};

const NO_DRAFTS =
  'Promoted by a reviewer after the run, so the agent never wrote copy for it. ' +
  'Write the outreach by hand.';

type LeadRow = {
  id: string; run_id: string; company_domain: string;
  qualification_status: string; agent_verdict: string | null;
  confidence: string; fit_reasons: string[] | null; source_urls: string[] | null;
};

/**
 * `leads_qualified_needs_evidence` refuses to store a qualified lead without a
 * fit reason, a source and confidence of at least 0.40. That constraint is the
 * point of the product, so a reviewer cannot click past it either. It is
 * checked here so the reviewer is told what is missing, rather than meeting a
 * raw constraint violation as a 500.
 */
function assertPromotable(lead: LeadRow): void {
  const missing: string[] = [];
  if (!lead.fit_reasons?.length) missing.push('a recorded fit reason');
  if (!lead.source_urls?.length) missing.push('a source URL');
  if (Number(lead.confidence) < 0.4) {
    missing.push(`confidence of at least 0.40, and it is ${Number(lead.confidence).toFixed(2)}`);
  }
  if (missing.length) {
    throw new ProviderError('REVIEW_NO_EVIDENCE',
      `This lead cannot be marked qualified because it is missing ${missing.join(', ')}. ` +
      'A qualified lead without evidence is the thing this system exists to prevent. ' +
      'Research it further, or leave it for review with a note.');
  }
}

export async function applyHumanVerdict(
  leadId: string, status: HumanVerdict | null, note: string | null,
): Promise<VerdictOutcome> {
  return tx(async (client) => {
    // Locked for the length of the decision: two reviewers on one lead must
    // not both read 'needs_review' and both stamp themselves as the override.
    const { rows } = await client.query<LeadRow>(
      `select id, run_id, company_domain, qualification_status, agent_verdict,
              confidence, fit_reasons, source_urls
         from public.leads where id = $1 for update`,
      [leadId],
    );
    const lead = rows[0];
    if (!lead) throw new ProviderError('REVIEW_NO_LEAD', 'No such lead.');

    const promoted = status === 'accepted' && lead.qualification_status !== 'qualified';
    const demoted = status === 'rejected' && lead.qualification_status === 'qualified';
    if (promoted) assertPromotable(lead);

    const nextStatus = promoted ? 'qualified' : demoted ? 'not_qualified'
      : lead.qualification_status;
    const moved = promoted || demoted;

    // Only a promotion can leave a lead with nothing to send: the agent writes
    // copy for what it qualified itself, and never for anything else.
    let draftsBlocked = false;
    if (promoted) {
      const { rows: drafts } = await client.query<{ n: string }>(
        'select count(*)::text as n from public.outreach_drafts where lead_id = $1', [leadId]);
      draftsBlocked = Number(drafts[0]?.n ?? 0) === 0;
    }

    await client.query(
      `update public.leads
          set human_status     = coalesce($2, human_status),
              human_note       = coalesce($3, human_note),
              qualification_status = $4,
              -- coalesce, so a second change never rewrites what the agent
              -- originally said.
              agent_verdict    = case when $5 then coalesce(agent_verdict, $6)
                                      else agent_verdict end,
              human_decided_at = case when $5 then now() else human_decided_at end,
              drafts_blocked   = case when $7 then $8 else drafts_blocked end
        where id = $1`,
      [leadId, status ?? null, note ?? null, nextStatus, moved,
       lead.qualification_status, draftsBlocked, NO_DRAFTS],
    );

    if (promoted) {
      // Idempotent: `finish_run` inserts the same row for leads the agent
      // qualified, and a promotion may happen before or after that.
      await client.query(
        `insert into public.delivered_domains (company_domain, first_run_id)
         values ($1, $2) on conflict (company_domain) do nothing`,
        [lead.company_domain, lead.run_id],
      );
    }

    if (demoted) {
      // Delivery is global, so only the run that delivered this domain may
      // withdraw it. Removing another run's row would resurface a company
      // somebody else has already handed over.
      await client.query(
        `delete from public.delivered_domains
          where company_domain = $1 and first_run_id = $2`,
        [lead.company_domain, lead.run_id],
      );
    }

    return { status: nextStatus, promoted, demoted, draftsBlocked };
  });
}
