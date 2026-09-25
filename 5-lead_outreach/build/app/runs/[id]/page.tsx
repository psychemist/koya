import { notFound } from 'next/navigation';
import { query } from '../../../lib/db.ts';
import { loadRun, runStats } from '../../../lib/runs.ts';
import { notificationStatus } from '../../../lib/notify/index.ts';
import { ConfirmDelete } from '../../ui/confirm';
import { ContinueRun } from './continue-run';
import { Nav } from '../../ui/nav';
import { Progress } from './progress';
import { DraftEditor } from './draft-editor';
import { ClarifyForm } from './clarify-form';
import { LeadVerdict } from './lead-verdict';
import { LeadTabs } from './lead-tabs';
import { LeadShell, HumanMark } from './lead-card';
import { requireUserPage, canSeeRun, canDeleteRun } from '../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

type Lead = {
  id: string; company_name: string; company_domain: string; qualification_status: string;
  confidence: string; fit_reasons: string[]; concerns: string[]; source_urls: string[];
  source_summary: string | null; drafts_blocked: string | null;
  human_status: string | null; human_note: string | null;
};

type Draft = {
  id: string; lead_id: string; step: number; subject: string | null; body: string;
  personalization_note: string | null; source_url: string | null; edited_by_human: boolean;
  gate_results: { gate: string; severity: string; passed: boolean; detail?: string }[] | null;
};

type Page = {
  company_domain: string; url: string; screened_summary: string | null;
  injection_flagged: boolean; injection_reason: string | null; raw_text: string | null;
};

/** What the strip says for each state. `skipped_not_configured` is grey on
 *  purpose: a red row for a lane nobody set up is what teaches people to stop
 *  reading the strip. */
const NOTIFY_STATE: Record<string, { text: string; className: string }> = {
  sent: { text: 'Notified by email and Discord', className: 'state-sent' },
  // Covers both shapes of partial delivery: an email that went while Discord
  // did not, and a feed-only event whose Discord post was lost with nobody
  // owed an email. The strip cannot tell them apart, so it claims neither.
  degraded: { text: 'Discord was not reached', className: 'state-degraded' },
  pending: { text: 'Emit did not complete', className: 'state-pending' },
  failed: { text: 'Nobody was notified', className: 'state-failed' },
  skipped_not_configured: { text: 'Notifications are not configured', className: 'state-skipped' },
};

/** The order a reviewer works in: accept, argue, then audit. */
const VERDICTS = [
  { key: 'qualified', label: 'Qualified' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'not_qualified', label: 'Not qualified' },
];

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserPage(`/runs/${id}`);

  let run;
  try { run = await loadRun(id); } catch { notFound(); }

  // Not found rather than forbidden. Telling someone a run exists but is not
  // theirs is itself a disclosure.
  if (!canSeeRun(user, run)) notFound();

  const [stats, leads, drafts, pages, notifications] = await Promise.all([
    runStats(id),
    query<Lead>(
      `select id, company_name, company_domain, qualification_status, confidence, fit_reasons,
              concerns, source_urls, source_summary, drafts_blocked, human_status, human_note
         from public.leads where run_id = $1
        order by case qualification_status when 'qualified' then 0
                 when 'needs_review' then 1 else 2 end, company_name`, [id]),
    query<Draft>(
      `select d.id, d.lead_id, d.step, d.subject, d.body, d.personalization_note,
              d.source_url, d.edited_by_human, d.gate_results
         from public.outreach_drafts d join public.leads l on l.id = d.lead_id
        where l.run_id = $1 order by d.step`, [id]),
    query<Page>(
      `select company_domain, url, screened_summary, injection_flagged, injection_reason, raw_text
         from public.scraped_pages where run_id = $1 order by created_at`, [id]),
    notificationStatus(id),
  ]);

  const icp = run.icp as Record<string, unknown> | null;

  const leadCard = (lead: Lead) => {
    const leadPages = pages.filter((p) => p.company_domain === lead.company_domain);
    const leadDrafts = drafts.filter((d) => d.lead_id === lead.id);
    return (
      <LeadShell key={lead.id} verdict={lead.qualification_status}
                 humanStatus={lead.human_status}>
        <div className="lead-head">
          <h3 className="lead-name" title={lead.company_name}>{lead.company_name}</h3>
          <a className="small lead-domain" href={`https://${lead.company_domain}`}
             target="_blank" rel="noreferrer" title={lead.company_domain}>
            {lead.company_domain}
          </a>
          {/* The verdict repeats as a chip because the card's left edge
              is off screen once a reviewer has scrolled into the card. */}
          <span className="chip" data-verdict={lead.qualification_status}>
            {lead.qualification_status.replace(/_/g, ' ')}
          </span>
          <span className="small muted lead-confidence">confidence {lead.confidence}</span>
          {/* The slot is spent whether or not it is filled, because the head
              only lines up down a list of thirty if every card spends the
              same cells. It reads the shared mark rather than the row, so it
              answers the moment the verdict button does. */}
          <HumanMark />
        </div>

        <div className="lead-cols">
          <section>
            <div className="col-label">Why the agent decided this</div>
            <ul className="tight">
              {lead.fit_reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            <div className="col-label">Concerns</div>
            {lead.concerns.length
              ? <ul className="tight">{lead.concerns.map((c, i) => <li key={i}>{c}</li>)}</ul>
              : <p className="small muted">The agent recorded none.</p>}

            <LeadVerdict leadId={lead.id} humanNote={lead.human_note} />
          </section>

          <section>
            <div className="col-label">What it read</div>
            {lead.source_urls.map((u) => (
              <p key={u} className="small" style={{ margin: '0 0 4px' }}>
                <a href={u} target="_blank" rel="noreferrer">{u}</a>
              </p>
            ))}
            {lead.source_summary && (
              <p className="small" style={{ marginTop: 10 }}>{lead.source_summary}</p>
            )}

            {/* The one-minute check is comparing the claim against the
                page, which needs the page. Showing only flagged pages
                meant a reviewer could never do that for a clean one. */}
            {leadPages.filter((p) => !p.injection_flagged).map((p) => (
              <details key={p.url} style={{ marginTop: 8 }}>
                <summary className="small">
                  What this page said{' '}
                  <span className="muted">(checked, nothing addressed to a machine)</span>
                </summary>
                <pre className="excerpt" style={{ marginTop: 8 }}>
                  {p.screened_summary || p.raw_text || 'Nothing was stored for this page.'}
                </pre>
              </details>
            ))}

            {leadPages.filter((p) => p.injection_flagged).map((p) => (
              <div className="flagged" key={p.url}>
                <b className="small">This page addressed an automated reader.</b>
                <p className="small" style={{ margin: '4px 0 0' }}>
                  {p.injection_reason ?? 'Flagged by the screen.'} The agent was given no
                  excerpt from it.
                </p>
                <details>
                  <summary className="small">Show what the page actually said</summary>
                  <pre className="excerpt" style={{ marginTop: 8 }}>{p.raw_text}</pre>
                </details>
              </div>
            ))}
          </section>

          <section>
            <div className="col-label">Drafts for review</div>
            {lead.drafts_blocked && (
              <div className="flagged">
                <b className="small">Copy needs writing by hand.</b>
                <p className="small" style={{ margin: '4px 0 0' }}>{lead.drafts_blocked}</p>
              </div>
            )}
            {leadDrafts.length === 0 && !lead.drafts_blocked && (
              <p className="small muted">No drafts were written for this lead.</p>
            )}
            {leadDrafts.map((d) => <DraftEditor key={d.id} draft={d} />)}
          </section>
        </div>
      </LeadShell>
    );
  };

  const buckets: { key: string; label: string; leads: Lead[] }[] = VERDICTS.map((v) => ({
    key: v.key,
    label: v.label,
    leads: leads.filter((l) => l.qualification_status === v.key),
  }));

  // A verdict nobody planned for is still a lead somebody paid to find, so it
  // gets a tab rather than disappearing between the three we expect.
  const known = new Set(VERDICTS.map((v) => v.key));
  const rest = leads.filter((l) => !known.has(l.qualification_status));
  if (rest.length) buckets.push({ key: 'other', label: 'Other', leads: rest });

  const groups = buckets.map((b) => ({
    key: b.key,
    label: b.label,
    count: b.leads.length,
    panel: b.leads.length
      ? b.leads.map(leadCard)
      : <p className="small muted">No leads carry this verdict.</p>,
  }));

  return (
    <>
      <Nav user={user} />
      <main className="wrap">
      <h1 className="run-title">{run.objective}</h1>

      <Progress runId={id} initialStatus={run.status} />

      {run.needs_clarification && (
        <ClarifyForm runId={id} question={run.needs_clarification} />
      )}

      {run.shortfall_reason && (
        <div className="card" style={{ padding: '12px 18px', marginBottom: 18 }}>
          <b>Fewer leads than the target, on purpose.</b>
          <p className="small" style={{ margin: '6px 0 0' }}>{run.shortfall_reason}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="strip">
          {notifications.length === 0
            ? <div className="muted">No notifications have been emitted for this run.</div>
            : notifications.map((row) => {
                const s = NOTIFY_STATE[row.state] ?? { text: row.state, className: '' };
                return (
                  <div key={`${row.kind}:${row.scope}`}>
                    <b>{row.kind.replace(/_/g, ' ')}</b>{' '}
                    <span className={s.className}>{s.text}</span>
                    {row.error_code && <span className="muted small"> ({row.error_code})</span>}
                  </div>
                );
              })}
        </div>
      </div>

      {icp && (
        <details className="card" style={{ padding: '12px 18px', marginBottom: 18 }}>
          <summary><b>The criteria these companies were judged against</b></summary>
          <pre className="excerpt" style={{ marginTop: 12 }}>
            {JSON.stringify(icp, null, 2)}
          </pre>
        </details>
      )}

      <h2>{stats.assessed} companies judged</h2>
      <p className="small muted">
        Leads marked for review are shown but are not counted toward the target.
      </p>

      {leads.length === 0 ? (
        <div className="card" style={{ padding: 18 }}>
          <p style={{ margin: 0 }}>
            No companies have been judged yet. This page updates as the run works.
          </p>
        </div>
      ) : (
        <LeadTabs groups={groups} />
      )}

      <hr className="rule" />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <a href={`/api/runs/${id}/export?format=csv`}><button className="quiet">
          Download CSV
        </button></a>
        <a href={`/api/runs/${id}/export?format=md`}><button className="quiet">
          Download Markdown
        </button></a>
        {/* A short run has already paid for its criteria and for every company
            it discovered. Continuing keeps both; starting again buys them
            twice. */}
        {icp && ['complete', 'partial', 'failed'].includes(run.status)
          && stats.qualified < run.target_leads && (
          <ContinueRun runId={id} qualified={stats.qualified} target={run.target_leads} />
        )}
        {canDeleteRun(user, run) &&
          <ConfirmDelete runId={id} objective={run.objective} leadCount={leads.length} />}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Both exports carry the criteria, the reasoning and the sources. A lead list without its
        evidence is the thing this system exists to replace.
      </p>
      </main>
    </>
  );
}
