import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { tick, claimTick } from '@/lib/pipeline/queue';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Driven by an n8n Schedule Trigger.
 *
 * Shared-secret guarded: an unauthenticated tick endpoint lets anyone on the
 * internet drain the queue at a time of their choosing, which for a publishing
 * system means choosing when a client's post goes out.
 *
 * The response is deliberately detailed. n8n's own execution history prunes
 * after 14 days and does not save manual executions at all, so what this
 * returns is what an operator reads when something looks wrong — the durable
 * record is the events table, not the n8n log.
 */
export async function POST(req: Request) {
  const secret = config.n8nNotifySecret();
  const provided = req.headers.get('x-koya-tick-key') ?? '';
  const expected = secret ? createHmac('sha256', secret).update('queue-tick').digest('hex') : '';

  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json(
      { error: { code: 'unauthorised', message: 'Invalid or missing tick key.' } },
      { status: 401 });
  }

  /*
   * The schedule is no longer the only caller, so it claims like everyone
   * else. n8n retries a failed execution and can overlap a long one, and an
   * overlapping tick would revise a second request concurrently for no
   * reason. At a 5-minute cadence against a 60s floor the schedule always
   * wins in the normal case, so this costs the heartbeat nothing.
   *
   * A skip is NOT an incident: `needsAttention` stays false so the n8n IF
   * node does not page #content-errors because the app happened to nudge
   * the queue a few seconds earlier.
   */
  const claim = await claimTick('schedule');
  if (!claim.won) {
    return NextResponse.json({
      skipped: true,
      reason: `Another tick was claimed ${claim.secondsAgo}s ago.`,
      retryInSeconds: claim.retryInSeconds,
      needsAttention: false,
      summary: `Skipped: a tick ran ${claim.secondsAgo}s ago.`,
    });
  }

  const result = await tick(10);
  return NextResponse.json({
    ...result,
    // An operator should be able to tell "nothing was due" from "nothing worked".
    // What an operator reads when something looks wrong. `queued_manual` is
    // named separately from `blocked`, because it is the expected outcome for
    // a channel nobody opted into paying for, and folding it into the failure
    // count is how alerting starts crying wolf.
    summary: [
      result.claimed === 0 ? 'Nothing was due.' : `${result.sent} sent`,
      result.claimed === 0 ? '' : `${result.blocked} blocked`,
      result.claimed === 0 ? '' : `${result.failed} failed`,
      result.queuedManual ? `${result.queuedManual} to post by hand` : '',
      result.swept.length ? `${result.swept.length} stalled request(s) recovered` : '',
    ].filter(Boolean).join(', ') + '.',
    /** True when a person should look. queued_manual deliberately excluded. */
    needsAttention: result.failed > 0 || result.blocked > 0 || result.swept.length > 0,
  });
}
