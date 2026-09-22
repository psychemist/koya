import { notFound } from 'next/navigation';
import { query } from '../../../lib/db.ts';
import { loadRun, runStats } from '../../../lib/runs.ts';
import { notificationStatus } from '../../../lib/notify/index.ts';
import { ConfirmDelete } from '../../ui/confirm';
import { Progress } from './progress';
import { DraftEditor } from './draft-editor';
import { ClarifyForm } from './clarify-form';
import { requireUserPage, canSeeRun, canDeleteRun } from '../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

type Lead = {
  id: string; company_name: string; company_domain: string; qualification_status: string;
  confidence: string; fit_reasons: string[]; concerns: string[]; source_urls: string[];
  source_summary: string | null; drafts_blocked: string | null; human_status: string | null;
};

type Draft = {
  id: string; lead_id: string; step: number; subject: string | null; body: string;
  personalization_note: string | null; source_url: string | null; edited_by_human: boolean;
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
              concerns, source_urls, source_summary, drafts_blocked, human_status
         from public.leads where run_id = $1
        order by case qualification_status when 'qualified' then 0
                 when 'needs_review' then 1 else 2 end, company_name`, [id]),
    query<Draft>(
      `select d.id, d.lead_id, d.step, d.subject, d.body, d.personalization_note,
              d.source_url, d.edited_by_human
         from public.outreach_drafts d join public.leads l on l.id = d.lead_id
        where l.run_id = $1 order by d.step`, [id]),
    query<Page>(
      `select company_domain, url, screened_summary, injection_flagged, injection_reason, raw_text
         from public.scraped_pages where run_id = $1 order by created_at`, [id]),
    notificationStatus(id),
  ]);

  const icp = run.icp as Record<string, unknown> | null;

  return (
    <main className="wrap">
      <p className="small">
        <a href="/">Your runs</a>
        {user.role === 'admin' && <> · <a href="/admin">Team and spend</a></>}
      </p>
      <h1>{run.objective}</h1>

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

      <h2>
        {stats.qualified} qualified, {stats.needsReview} to review,{' '}
        {stats.notQualified} not qualified
      </h2>
      <p className="small muted">
        Leads marked for review are shown but are not counted toward the target.
      </p>

      {leads.length === 0 && (
        <div className="card" style={{ padding: 18 }}>
          <p style={{ margin: 0 }}>
            No companies have been judged yet. This page updates as the run works.
          </p>
        </div>
      )}

      {leads.map((lead) => {
        const leadPages = pages.filter((p) => p.company_domain === lead.company_domain);
        const leadDrafts = drafts.filter((d) => d.lead_id === lead.id);
        return (
          <article key={lead.id} className="card lead" data-verdict={lead.qualification_status}>
            <div className="lead-head">
              <h3>{lead.company_name}</h3>
              <a className="small" href={`https://${lead.company_domain}`}
                 target="_blank" rel="noreferrer">{lead.company_domain}</a>
              <span className="small muted">
                {lead.qualification_status.replace(/_/g, ' ')}, confidence {lead.confidence}
              </span>
              {lead.human_status && (
                <span className="small"><b>You marked this {lead.human_status}</b></span>
              )}
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
          </article>
        );
      })}

      <hr className="rule" />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <a href={`/api/runs/${id}/export?format=csv`}><button className="quiet">
          Download CSV
        </button></a>
        <a href={`/api/runs/${id}/export?format=md`}><button className="quiet">
          Download Markdown
        </button></a>
        {canDeleteRun(user, run) &&
          <ConfirmDelete runId={id} objective={run.objective} leadCount={leads.length} />}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Both exports carry the criteria, the reasoning and the sources. A lead list without its
        evidence is the thing this system exists to replace.
      </p>
    </main>
  );
}
