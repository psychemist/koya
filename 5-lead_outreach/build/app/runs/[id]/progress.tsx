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
type Snapshot = {
  status: string; turns: number; candidatesRemaining: number; scrapesRemaining: number;
  stats: { qualified: number; assessed: number; flaggedPages: number; blockedDrafts: number };
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
    </div>
  );
}
