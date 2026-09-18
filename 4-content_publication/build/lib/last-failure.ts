import { one } from './db';

/**
 * The most recent failure on a request, read back out of the audit log.
 *
 * When generation fails, the request is wound back to `angles_ready` so a
 * person can act on it. That leaves a screen which looks exactly like a
 * request that has never been attempted: three angles, a Write button, and no
 * sign that a minute ago it tried, failed, and spent money doing it. The user
 * picks the same angle and waits for the same failure.
 *
 * `events` already holds the reason and the correlation ID, so nothing new
 * has to be stored. This reads the last one back and the workspace renders it
 * above the angles. A failure the operator has to go to the database to find
 * is, from the desk's point of view, a failure that was never reported.
 */
export type LastFailure = {
  stage: string;
  message: string;
  correlationId: string;
  at: Date;
};

export async function lastFailure(requestId: string): Promise<LastFailure | null> {
  const row = await one<{
    stage: string; detail: any; correlation_id: string; created_at: Date;
  }>(
    `select stage, detail, correlation_id, created_at
       from public.events
      where request_id = $1
        and outcome = 'failed'
        -- Notification failures are NOT pipeline failures, and conflating them
        -- is how the workspace ended up announcing "the last attempt failed at
        -- notify fallback" above a request whose real problem was that the
        -- draft ran out of output space. Delivery has its own panel, which
        -- says plainly who was and was not told.
        and stage not like 'notify.%'
        -- PER-ITEM STAGES ARE EXCLUDED FOR THE SAME REASON, one level down.
        --
        -- research.fetch and research.extract run once per URL, and
        -- discovery deliberately asks for ten expecting to lose some. One
        -- site refusing one path is not a failed research pass, but it wrote
        -- a failed event, and this query reads the newest one. The result was
        -- a red banner reading "the last attempt failed at research fetch,
        -- nothing was half-written, the request was put back to a state you
        -- can act from" over a request that had succeeded, lost one source of
        -- ten, and was waiting on somebody to pick an angle.
        --
        -- Every one of those outcomes is already on screen in the Sources
        -- list, with its own reason, which is where a partial loss belongs.
        -- This banner answers one question only: did the run as a whole stop.
        and stage not in ('research.fetch', 'research.extract')
      order by created_at desc
      limit 1`,
    [requestId],
  ).catch(() => null);

  if (!row) return null;
  return {
    stage: row.stage,
    message: String(row.detail?.error ?? row.detail?.reason ?? 'No reason was recorded.'),
    correlationId: row.correlation_id,
    at: row.created_at,
  };
}
