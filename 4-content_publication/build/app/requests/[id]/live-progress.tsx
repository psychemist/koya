'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Progress, Stage, StageState } from '@/lib/pipeline/progress';

/**
 * Where the run has got to, while it is getting there.
 *
 * A full pass is two to four minutes of nothing happening on screen. The
 * button said "Writing and checking" and then the page sat still, so the
 * honest question a person asks at ninety seconds, whether this is working or
 * hung, had no answer anywhere in the interface. People reload, and reloading
 * during a run is how somebody ends up believing it failed.
 *
 * Three things make this worth the polling:
 *
 *  1. THE ELAPSED CLOCK ON THE ACTIVE STAGE. "Writing the article, 47s" is the
 *     difference between waiting and wondering. It ticks locally between
 *     polls, so it moves every second rather than in 2.5-second jumps.
 *  2. THE DETAIL LINE. "7 read, 2 skipped, 1 quarantined" is the number that
 *     would otherwise send someone to count rows in the Sources tab.
 *  3. THE HUMAN GATES ARE STAGES TOO. The pipeline stopping to wait for a
 *     person is not a pause in the work, it IS the work, and a progress view
 *     that showed only the machine steps would teach people the opposite.
 *
 * It refreshes the server components once the run finishes, so the drafts
 * appear without anybody reloading.
 */
const POLL_MS = 2500;
/** Once the request has genuinely stopped moving, poll far less often. */
const STALLED_POLL_MS = 20_000;
/**
 * How long with no forward movement before this calls itself stalled.
 *
 * `updatedAt` moves every time cost accrues, and a single drafting call is
 * legitimately silent on that front for a minute or two, so this has to sit
 * well above the slowest ordinary stage rather than the fastest one. Five
 * minutes is comfortably longer than any real pass; below that, calling a
 * live run "stalled" would be the false alarm this view exists not to sound.
 *
 * This exists for a genuinely uncaught server bug wearing the same clothes as
 * a legitimate long stage. One confirmed instance of it is fixed in
 * app/api/requests/[id]/research/route.ts, but that fix only closes the one
 * failure mode found; nothing here can promise there is no other one, and a
 * silent poll every 2.5 seconds forever is the wrong way to find out.
 *
 * Raised from five minutes to twelve when revision moved onto the heartbeat.
 * A request now sits at `evaluating` as a HANDOFF, waiting for the next tick
 * to claim it, and the tick runs every five minutes. So five minutes of a
 * static `updatedAt` stopped meaning "stuck" and started meaning "queued",
 * and the banner would have fired on the healthy path every single time. At
 * twelve, a whole missed tick still does not cry wolf, and a genuinely dead
 * pipeline is still named long before the thirty-minute sweep reaches it.
 */
const STALL_MS = 12 * 60 * 1000;

/**
 * How long to wait before offering to drive the queue again, when the server
 * has not said otherwise.
 *
 * Only the opening bid. The server owns the real floor — it is derived there
 * from the revision budget — and a rejected nudge comes back with the seconds
 * remaining, which this then honours. Hard-coding the floor on both sides
 * would be two numbers that have to agree forever, and the client's copy
 * would be the one that silently went stale.
 */
const NUDGE_MS = 30_000;

const DOT: Record<StageState, string> = {
  done: 'bg-ok',
  active: 'bg-waiting',
  waiting: 'bg-advisory',
  failed: 'bg-blocking',
  skipped: 'bg-rule-strong',
  pending: 'bg-rule-strong',
};

export default function LiveProgress({
  requestId, initial,
}: { requestId: string; initial: Progress }) {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress>(initial);
  const [stale, setStale] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wasRunning = useRef(initial.running);
  const [open, setOpen] = useState(initial.running);

  // The evidence a stall detector needs: when did the record last actually
  // change, as opposed to when this component last happened to ask.
  const lastChangedAt = useRef(Date.now());
  const lastUpdatedAt = useRef(initial.updatedAt);
  const [stalled, setStalled] = useState(false);
  const [checking, setChecking] = useState(false);

  // Client-side half of the nudge guard. The server's claim is what actually
  // bounds this; these two only stop one tab from firing a request every 2.5
  // seconds that the server will certainly reject.
  const nextNudgeAt = useRef(0);
  const nudging = useRef(false);

  // The clock, kept separate from the poll so the elapsed time moves every
  // second instead of jumping 2.5 seconds at a time. It also re-evaluates the
  // stall condition every second, independent of whether a poll just ran,
  // because the stall is defined by silence and silence has no event to hang
  // a check off.
  useEffect(() => {
    if (!progress.running) return;
    const t = setInterval(() => {
      setNow(Date.now());
      setStalled(Date.now() - lastChangedAt.current > STALL_MS);
    }, 1000);
    return () => clearInterval(t);
  }, [progress.running]);

  async function nudge(): Promise<void> {
    if (nudging.current || Date.now() < nextNudgeAt.current) return;
    nudging.current = true;
    nextNudgeAt.current = Date.now() + NUDGE_MS;
    try {
      const res = await fetch('/api/queue/nudge', { method: 'POST' });
      // A refused nudge carries the seconds left on the server's floor, so
      // back off by exactly that rather than by a guess. Without it this tab
      // would keep asking every 30s for a floor three times that long, and
      // every open tab would do the same.
      const json = await res.json().catch(() => null);
      const retry = json?.data?.retryInSeconds;
      if (typeof retry === 'number' && retry > 0) {
        nextNudgeAt.current = Date.now() + retry * 1000;
      }
    } catch {
      // Failure is not surfaced, on purpose. This is an optimisation on top
      // of the schedule, not something the request depends on, so a nudge
      // that does not land costs a few minutes of waiting and nothing else.
      // Telling somebody their draft is fine but the queue hint failed would
      // be noise about a thing they cannot act on.
    } finally {
      nudging.current = false;
    }
  }

  async function poll(): Promise<void> {
    try {
      const res = await fetch(`/api/requests/${requestId}/progress`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      const next: Progress = json.data;
      if (next.updatedAt !== lastUpdatedAt.current) {
        lastUpdatedAt.current = next.updatedAt;
        lastChangedAt.current = Date.now();
        setStalled(false);
      }
      setProgress(next);
      setStale(null);

      /*
       * A request parked at `evaluating` is waiting for a tick, not working.
       *
       * Generation now hands off there, so without something driving the
       * queue this is where it stops. The schedule gets to it within five
       * minutes; nudging means the person actually watching does not wait
       * that long, and on a machine with no n8n at all it is the difference
       * between finishing and never finishing.
       *
       * Fired for the CURRENT status only, so it stops the moment the tick
       * takes the row to `revising`. Nobody watching means nobody nudging,
       * which is the correct amount of work for a page nobody has open.
       */
      if (next.status === 'evaluating') void nudge();
    } catch {
      // A poll failing is NOT the run failing, and saying so would be the
      // worst kind of wrong here. But a view that silently stops updating
      // while still looking live is the failure this whole component exists
      // to prevent, so it says which one it is.
      setStale('The last update did not come through. The run itself is unaffected.');
    }
  }

  useEffect(() => {
    if (!progress.running) {
      // The run has finished. Pull the server components through once so the
      // drafts, flags and cost appear without anybody reloading, then stop
      // asking. A page left open on a finished request costs nothing.
      if (wasRunning.current) {
        wasRunning.current = false;
        router.refresh();
      }
      return;
    }
    wasRunning.current = true;

    /*
     * A RECURSIVE TIMEOUT, NOT setInterval, because the delay has to be able
     * to change while the loop is running.
     *
     * Once nothing has moved for STALL_MS, this backs off from every 2.5
     * seconds to every 20. That is the direct fix for a request that gets
     * wedged in a transient status and is never coming back on its own: even
     * with the one confirmed cause of that patched server-side, this view
     * should never again hammer the database every 2.5 seconds indefinitely
     * for a reason nobody has thought of yet. It keeps polling rather than
     * stopping outright, so a request that DOES recover (a slow judge pass, a
     * deploy that briefly interrupted the server) is picked up without
     * anyone having to reload.
     */
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await poll();
      if (cancelled) return;
      const delay = Date.now() - lastChangedAt.current > STALL_MS ? STALLED_POLL_MS : POLL_MS;
      timer = setTimeout(loop, delay);
    };
    timer = setTimeout(loop, POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress.running, requestId, router]);

  const current = progress.stages.find((s) => s.state === 'active')
    ?? progress.stages.find((s) => s.state === 'waiting');
  const doneCount = progress.stages.filter((s) => s.state === 'done').length;
  const elapsed = progress.running
    ? Math.max(0, Math.round((now - new Date(progress.updatedAt).getTime()) / 1000))
    : 0;

  return (
    <section className="sheet overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunk/40"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="relative flex size-2.5 shrink-0">
          {progress.running && (
            // The one moving thing on the page, and it only moves while
            // something actually is.
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-waiting opacity-60" />
          )}
          <span className={`relative inline-flex size-2.5 rounded-full ${
            progress.running ? 'bg-waiting' : current?.state === 'waiting' ? 'bg-advisory' : 'bg-ok'}`}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {current?.label ?? 'Finished'}
            {progress.running && elapsed > 0 && (
              <span className="ml-2 font-normal tabular-nums text-muted">{fmt(elapsed)}</span>
            )}
          </span>
          {current?.detail && (
            <span className="block truncate text-xs text-muted">{current.detail}</span>
          )}
        </span>

        <span className="shrink-0 text-xs tabular-nums text-muted">
          {doneCount} of {progress.stages.length}
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <svg width="8" height="10" viewBox="0 0 8 10">
            <path d="M1 1 6 5 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
      </button>

      {/* The bar is the same information as the count, for the glance that does
          not read numbers. aria-hidden because the count beside it already
          says this to a screen reader. */}
      <div aria-hidden="true" className="h-0.5 w-full bg-sunk">
        <div
          className={`h-full transition-all duration-500 ${
            current?.state === 'failed' ? 'bg-blocking'
            : progress.running ? 'bg-waiting'
            : current?.state === 'waiting' ? 'bg-advisory' : 'bg-ok'}`}
          style={{ width: `${(doneCount / progress.stages.length) * 100}%` }}
        />
      </div>

      {open && (
        <ol className="divide-y divide-rule">
          {progress.stages.map((s) => <Row key={s.key} stage={s} now={now} />)}
        </ol>
      )}

      {/*
        A DISTINCT BANNER, NOT JUST A SLOWER SPINNER.
        Backing off the poll interval silently would fix the hammering but
        hide the fact that something is actually wrong. Saying so, with a
        control that lets a person act rather than only watch, is the whole
        point of catching this at all.
      */}
      {stalled && (
        <div className="border-t border-advisory/30 bg-advisory-bg px-4 py-2.5">
          <p role="status" className="text-xs text-advisory">
            This has not moved in over twelve minutes, which is longer than a real run takes
            even allowing for the queue. It may be stuck.
          </p>
          <button
            type="button"
            className="btn btn-quiet mt-1.5 h-7 px-2.5 py-0 text-xs"
            disabled={checking}
            onClick={async () => { setChecking(true); await poll(); setChecking(false); }}
          >
            {checking ? 'Checking' : 'Check now'}
          </button>
        </div>
      )}

      {stale && (
        <p role="status" className="border-t border-rule px-4 py-2 text-xs text-advisory">
          {stale}
        </p>
      )}
    </section>
  );
}

function Row({ stage, now }: { stage: Stage; now: number }) {
  const pending = stage.state === 'pending';
  return (
    <li className={`flex items-start gap-3 px-4 py-2.5 ${pending ? 'opacity-45' : ''}`}>
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[stage.state]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className={stage.state === 'active' ? 'font-semibold' : 'font-medium'}>
            {stage.label}
          </span>
          {stage.human && (
            <span className="pill bg-sunk text-ink-70">waits for a person</span>
          )}
          {stage.state === 'failed' && (
            <span className="pill bg-blocking-bg text-blocking">failed</span>
          )}
        </p>
        <p className="text-xs text-muted">{stage.detail ?? stage.blurb}</p>
      </div>
      <span className="shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted">
        {stage.latencyMs != null && <span className="block">{fmt(stage.latencyMs / 1000)}</span>}
        {stage.costUsd ? <span className="block">${stage.costUsd.toFixed(3)}</span> : null}
        {stage.state === 'active' && stage.at && (
          <span className="block">{fmt((now - new Date(stage.at).getTime()) / 1000)}</span>
        )}
      </span>
    </li>
  );
}

const fmt = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
