'use client';

import { useEffect, useState } from 'react';

type Snapshot = {
  status: string; turns: number; candidatesRemaining: number; scrapesRemaining: number;
  apifySpendUsd: number; claudeCostUsd: number;
  stats: { qualified: number; assessed: number; flaggedPages: number; blockedDrafts: number };
};

const TERMINAL = ['complete', 'partial', 'failed'];

const money = (v: number) => `$${Number(v ?? 0).toFixed(2)}`;

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
        <div><b>Status</b> {status.replace(/_/g, ' ')}</div>
        {snap && (
          <>
            <div><b>Turns</b> {snap.turns}</div>
            <div><b>Candidates left</b> {snap.candidatesRemaining}</div>
            <div><b>Pages left</b> {snap.scrapesRemaining}</div>
            <div><b>Apify</b> {money(snap.apifySpendUsd)}</div>
            <div>
              <b>Claude</b> {money(snap.claudeCostUsd)}{' '}
              <span className="muted">(estimate, not billing data)</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
