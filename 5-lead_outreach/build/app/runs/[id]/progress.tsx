'use client';

import { useEffect, useState } from 'react';

import { runStateClass } from '../../ui/status';

/**
 * Deliberately no cost.
 *
 * Spend is a shared budget question, asked once on the admin page rather than
 * on every operator's run. What belongs here is what is LEFT, because that is
 * what tells a reviewer whether the run can still reach the target, and it is
 * the number they can act on.
 */
type Activity = {
  tool_name: string; purpose: string | null; status: string; created_at: string;
};

type Snapshot = {
  status: string; turns: number; candidatesRemaining: number; scrapesRemaining: number;
  stats: { qualified: number; assessed: number; flaggedPages: number; blockedDrafts: number };
  activity: Activity[];
};

/** The tool name is an implementation detail. What a reviewer is watching for
 *  is which of the five stages the run is in. */
const STAGE: Record<string, string> = {
  save_icp: 'Agreeing the criteria',
  discover_companies: 'Searching for companies',
  scrape_company_site: 'Reading a company site',
  save_lead: 'Recording a verdict',
  save_outreach: 'Drafting outreach',
  get_run_state: 'Checking what is left',
  finish_run: 'Checking the list before finishing',
};

const stageOf = (t: string) => STAGE[t.replace(/^mcp__leadgen__/, '')] ?? t.replace(/_/g, ' ');

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { timeStyle: 'medium' });
};

const TERMINAL = ['complete', 'partial', 'failed'];

export function Progress({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    if (TERMINAL.includes(status)) return;
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/progress`);
        if (!res.ok || !live) return;
        const body = (await res.json()) as Snapshot;
        setSnap(body);
        if (body.status !== status) {
          setStatus(body.status);
          // The page is server rendered, so a finished run needs a reload to
          // show the leads it produced rather than a second copy of the data.
          if (TERMINAL.includes(body.status)) window.location.reload();
        }
      } catch { /* a missed poll is not worth reporting */ }
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [runId, status]);

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="strip">
        <div>
          <b>Status</b>{' '}
          <span className={runStateClass(status)}>{status.replace(/_/g, ' ')}</span>
        </div>
        {snap && (
          <>
            <div><b>Turns</b> {snap.turns}</div>
            <div><b>Candidates left</b> {snap.candidatesRemaining}</div>
            <div><b>Pages left</b> {snap.scrapesRemaining}</div>
            <div><b>Qualified</b> {snap.stats.qualified}</div>
            <div><b>Judged</b> {snap.stats.assessed}</div>
          </>
        )}
      </div>

      {/* Only while something is happening. On a finished run the leads below
          are the answer, and a frozen activity list reads like a stalled one. */}
      {snap && !TERMINAL.includes(status) && snap.activity?.length > 0 && (
        // `.card` carries no padding of its own: `.strip` above supplies its
        // own 13px 18px. Matching that 18px here is what keeps the timestamps
        // off the left border and the status badges off the right one. The
        // rule stays on this outer element so it spans the full card, the way
        // the strip's own edge does.
        <div style={{ borderTop: '1px solid var(--rule, #e5e5e5)' }}>
          <div style={{ padding: '12px 18px 14px' }}>
          <div className="small muted" style={{ marginBottom: 4 }}>Latest activity</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {snap.activity.map((a, i) => (
              <li
                key={`${a.created_at}-${i}`}
                className="small"
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 14,
                  padding: '9px 0',
                  lineHeight: 1.5,
                  // A hairline per row rather than one under the heading. Rows
                  // wrap on a narrow screen, and without a rule a wrapped
                  // purpose reads as part of the row beneath it.
                  borderTop: i === 0 ? 'none' : '1px solid var(--rule, #ededed)',
                  // The newest call is the one being watched. The rest recede
                  // rather than disappear: they are still the evidence trail.
                  opacity: i === 0 ? 1 : 0.78,
                }}
              >
                <span
                  className="muted"
                  style={{
                    // Fixed width so the stage names form a column instead of
                    // stepping in and out with the width of each timestamp.
                    fontVariantNumeric: 'tabular-nums', minWidth: '7.5ch', flexShrink: 0,
                  }}
                >
                  {clock(a.created_at)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{stageOf(a.tool_name)}</span>
                  {a.purpose && (
                    <span className="muted" style={{ marginLeft: 8 }}>{a.purpose}</span>
                  )}
                </span>
                {a.status !== 'ok' && (
                  <span
                    className={a.status === 'denied' ? 'state-degraded' : 'state-failed'}
                    style={{ flexShrink: 0, marginLeft: 4 }}
                  >
                    {a.status === 'started' ? 'running' : a.status}
                  </span>
                )}
              </li>
            ))}
          </ol>
          </div>
        </div>
      )}
    </div>
  );
}
