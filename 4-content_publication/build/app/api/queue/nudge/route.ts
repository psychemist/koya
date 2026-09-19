import { after } from 'next/server';
import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { tick, claimTick } from '@/lib/pipeline/queue';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The app's own heartbeat, for when nothing else is beating.
 *
 * Since revision moved onto the tick, the tick is the only thing that
 * finishes a generation — and its only caller was an n8n schedule. With n8n
 * down, or simply not running on a developer's machine, a request waited at
 * `evaluating` forever with a finished draft nobody could approve. That is
 * precisely the dead end the move was meant to remove, arrived at from the
 * other side.
 *
 * So the people watching a request can drive it. The progress poller calls
 * this when it sees a request parked at `evaluating`, which means the nudge
 * comes from exactly the person who needs it and stops the moment nobody is
 * looking. It is not a replacement for the schedule: a request nobody has
 * open still needs n8n, and this does not publish anything the schedule
 * would not have published a few minutes later.
 *
 * TWO GUARDS, because this is reachable from every open tab at once:
 *
 *  1. `claimTick` is the rate limit AND the mutual exclusion, in one atomic
 *     UPDATE. Twenty pollers firing together produce one tick, and the other
 *     nineteen are told when to try again. A tick can start a 146-second
 *     revision pass that spends real money, so this is about bounding spend,
 *     not about tidiness.
 *  2. `requireUser`, so the endpoint is not an anonymous lever for making
 *     somebody else's queue drain on a schedule of the caller's choosing.
 *     The schedule route has its shared secret; this has a session.
 *
 * The work runs in `after()` rather than being awaited, so the response
 * returns at once. A tick is up to two and a half minutes of revision, and
 * holding a browser connection open for that would mean a person navigating
 * away aborts the handler mid-pass. Whatever `after` does not finish is
 * left where the next tick finds it.
 */
export async function POST() {
  return handle('queue.nudge', async () => {
    await requireUser();

    const claim = await claimTick('nudge');
    if (!claim.won) {
      return {
        ticked: false,
        secondsAgo: claim.secondsAgo,
        retryInSeconds: claim.retryInSeconds,
      };
    }

    after(async () => {
      try {
        await tick(10);
      } catch (e) {
        // `after` swallows what it catches, and a heartbeat that fails
        // silently is worse than one that does not run: the request keeps
        // waiting and nothing anywhere says why. tick() already handles
        // per-row failure, so reaching here means the tick itself broke.
        console.error(JSON.stringify({
          level: 'error', at: 'queue_nudge_failed',
          reason: e instanceof Error ? e.message : String(e),
        }));
      }
    });

    return { ticked: true };
  });
}
