import { query, one, pool, advance } from '../db';
import { event } from '../audit';
import { connectorFor, type Channel } from '../publish';
import { approvalIsCurrent } from './approve';
import { reviseUntilClean, MAX_REVISIONS } from './revise';
import { notify } from '../notify';
import { correlationId } from '../hash';

/**
 * The queue is the product; connectors are adapters.
 *
 * Two mechanisms doing two DIFFERENT jobs, and conflating them is how
 * duplicates happen:
 *
 *   FOR UPDATE SKIP LOCKED  stops TWO WORKERS taking the same row.
 *   UNIQUE(idempotency_key) stops ONE WORKER'S RETRY posting twice, by being
 *                           passed through to the provider.
 *
 * A duplicate post on a client's LinkedIn is the failure that gets an agency
 * fired, and "we timed out" is not the same as "we did not post".
 */
export async function enqueue(opts: {
  requestId: string; channel: Channel; assetRevision: number;
  payload: Record<string, unknown>; dueAt: Date;
}) {
  /*
   * THE KEY IDENTIFIES A PUBLICATION, NOT A MOMENT.
   *
   * It used to be `${requestId}:${channel}:${dueAt to the minute}`, and for
   * immediate publishing `dueAt` is `new Date()` taken at approval time. The
   * approve route re-enqueues EVERY already-approved channel on each
   * approval and relies on this key to collapse the repeats, so the whole
   * design rested on two approvals producing the same key.
   *
   * They did not. A real run approved LinkedIn at 02:27:59 and X at 02:28:26;
   * the second approval re-enqueued LinkedIn under `...T02:28`, the conflict
   * clause saw a key it had never seen, and a second row was created for a
   * post that had already been queued. Both dispatched, each carrying its own
   * `x-li-idempotency-key`, so LinkedIn saw two distinct requests rather than
   * a retry of one. The unique index, the conflict clause and the provider
   * header all failed from this single cause, and 27 seconds either way would
   * have hidden it.
   *
   * request + channel + asset revision IS the publication. Approving the same
   * revision twice is the same post and collapses; a new revision is a
   * genuinely different post and gets its own row, which is the behaviour the
   * approval model already assumes when it says an approval names an exact
   * revision.
   */
  const key = `${opts.requestId}:${opts.channel}:${opts.assetRevision}`;
  return one<{ id: string }>(
    `insert into public.publish_queue
       (request_id, channel, asset_revision, payload, due_at, idempotency_key)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (idempotency_key) do nothing
     returning id`,
    [opts.requestId, opts.channel, opts.assetRevision, JSON.stringify(opts.payload),
     opts.dueAt.toISOString(), key]);
}

/**
 * How long one tick will spend revising before handing the rest to the next.
 *
 * The tick route is capped at 300s like every other route. A revision pass is
 * a full-article generation — 146s on average, 218s at worst — and it cannot
 * be interrupted once the model call is in flight. So the budget stops NEW
 * passes with enough left over for a pass already running to land, plus the
 * evaluate that follows it.
 *
 * The common case still finishes in the tick that starts it: one pass plus
 * two evaluates is around 200s.
 */
const REVISION_BUDGET_MS = 150_000;

/**
 * The floor between two ticks, DERIVED from the revision budget rather than
 * picked.
 *
 * A fixed 60s floor was wrong and the arithmetic says so: a tick that claims
 * at T revises until T+150s, so a second claim succeeds at T+61 while the
 * first is still mid-pass. Both then pick a different request and start a
 * 146-second generation, which is the concurrent spend this guard exists to
 * prevent, arrived at through the guard itself.
 *
 * Deriving it means the two cannot drift apart later: raise the budget and
 * the floor follows. The 30s of slack covers the publish drain and the pass
 * already in flight when the budget expires.
 */
const TICK_MIN_INTERVAL_S = Math.ceil(REVISION_BUDGET_MS / 1000) + 30;

export type TickClaim =
  | { won: true }
  | { won: false; secondsAgo: number; retryInSeconds: number };

/**
 * The right to run one tick, which is also the rate limit.
 *
 * Two callers now reach the tick: the n8n schedule, and any in-app nudge.
 * A tick can start a revision pass that runs for 146 seconds and spends real
 * money, and the nudge is reachable from every open progress poller at once,
 * so "two ticks at the same moment" went from theoretical to routine.
 *
 * Racing ticks would not corrupt anything — a revision row is claimed by
 * status and a queue row by FOR UPDATE SKIP LOCKED, so no unit of work is
 * ever done twice — but they would each pick up a DIFFERENT request and
 * revise both at once, which is unbounded spend triggered by nothing more
 * than two people having a page open.
 *
 * So the claim is one atomic statement and needs no advisory lock. Under
 * READ COMMITTED, two concurrent callers both attempt the UPDATE; one takes
 * the row lock and commits, the other blocks, re-evaluates the predicate
 * against the newly committed row, sees a recent `last_run_at`, and updates
 * nothing. Exactly one gets a row back.
 *
 * Fail CLOSED. If the claim query itself errors, nobody ticks. A tick that
 * is skipped is retried in sixty seconds by whoever asks next; a tick that
 * runs because its own guard was broken is the spend this exists to bound.
 */
export async function claimTick(
  source: 'schedule' | 'nudge',
  minIntervalSeconds = TICK_MIN_INTERVAL_S,
): Promise<TickClaim> {
  const won = await one<{ last_run_at: Date }>(
    `update public.tick_state
        set last_run_at = now(), started_at = now(), last_source = $2
      where last_run_at < now() - ($1 || ' seconds')::interval
     returning last_run_at`,
    [String(minIntervalSeconds), source],
  ).catch(() => null);

  if (won) return { won: true };

  const cur = await one<{ secs: number }>(
    `select greatest(0, extract(epoch from (now() - last_run_at))::int) as secs
       from public.tick_state`).catch(() => null);
  const secondsAgo = cur?.secs ?? 0;
  return {
    won: false,
    secondsAgo,
    retryInSeconds: Math.max(0, minIntervalSeconds - secondsAgo),
  };
}

/**
 * Wind back requests that were abandoned mid-flight.
 *
 * The generate route already unwinds its own status when the work throws. It
 * cannot unwind anything when the PROCESS dies: a deploy, an OOM kill, a
 * container recycle, or a dev server restarted under a long run. The request
 * is then left in a transient status (`researching`, `planning`, `drafting`,
 * `evaluating`) that no route accepts as a starting point, which is the exact
 * dead end that cost $0.196 and produced nothing the first time it happened.
 *
 * So the sweep lives on the heartbeat, which is the only thing guaranteed to
 * run after a crash. Same reasoning as reclaiming a queue row stranded at
 * `claimed`, applied one level up.
 *
 * Thirty minutes, because a full research pass plus two revision passes is
 * minutes, not half an hour, and the window has to be comfortably longer than
 * the slowest legitimate run. Where it lands is chosen to be actionable:
 * `angles_ready` if angles exist to choose from, otherwise `draft`, which is
 * where research starts. Nothing is deleted and the spend stays counted.
 *
 * THE HEARTBEAT IS THE EVENT LOG, NOT `updated_at`. A first version compared
 * `updated_at`, which only moves when the status does, so a request sitting
 * legitimately in `evaluating` for a long judge pass looks identical to one
 * whose process died. Sweeping on that signal would kill live work, which is
 * a worse bug than the one being fixed. Every stage writes to `events` as it
 * goes, so the newest event for the request is what says it is still alive.
 */
export async function sweepStalledRequests(olderThanMinutes = 30): Promise<
  { id: string; from: string; to: string }[]
> {
  const stalled = await query<{ id: string; status: string; angles: number }>(
    `select r.id, r.status,
            (select count(*)::int from public.angles a where a.request_id = r.id) as angles
       from public.content_requests r
      where r.status in ('researching','planning','drafting','evaluating','revising')
        and greatest(
              r.updated_at,
              coalesce((select max(e.created_at) from public.events e
                         where e.request_id = r.id), r.updated_at)
            ) < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  ).catch(() => []);

  const moved: { id: string; from: string; to: string }[] = [];
  for (const r of stalled) {
    const to = r.angles > 0 ? 'angles_ready' : 'draft';
    const ok = await query(
      `update public.content_requests
          set status=$2, version = version + 1, updated_at = now()
        where id=$1 and status=$3`,
      [r.id, to, r.status]).then(() => true).catch(() => false);
    if (!ok) continue;

    // The selection goes with it: the picker has to render for the choice to
    // be retakeable.
    if (to === 'angles_ready') {
      await query(
        `update public.angles set selected_by=null, selected_at=null where request_id=$1`,
        [r.id]).catch(() => {});
    }
    moved.push({ id: r.id, from: r.status, to });
  }
  return moved;
}

export type RevisionOutcome = {
  requestId: string;
  state: 'needs_review' | 'needs_human' | 'paused' | 'failed';
  passes: number;
};

/**
 * Drive the revision loop for requests waiting at `evaluating`.
 *
 * This is the half of generation that no longer fits in an HTTP request.
 * The generate route now stops once the draft and the channel assets exist,
 * leaving the request at `evaluating` as a HANDOFF, and this picks it up.
 *
 * `revising` is the claim. `advance` is status-guarded, so of two concurrent
 * ticks reaching for the same row exactly one wins and the other sees no row
 * — the same guarantee `FOR UPDATE SKIP LOCKED` gives the publish queue, by
 * the same reasoning: a second worker starting a second revision of one draft
 * would have two passes writing revisions of the same asset.
 *
 * Nothing here throws. A request whose revision fails goes back to
 * `evaluating` for the next tick to retry, and a request whose TICK dies
 * mid-pass is left at `revising`, which sweepStalledRequests now recognises.
 */
export async function driveRevisions(deadline: number): Promise<RevisionOutcome[]> {
  const out: RevisionOutcome[] = [];

  while (Date.now() < deadline) {
    const claimed = await one<{
      id: string; revise_passes: number; revise_discarded_worse: boolean; actor_id: string | null;
    }>(
      `update public.content_requests
          set status='revising', version = version + 1, updated_at = now()
        where id = (
          select r.id from public.content_requests r
           where r.status = 'evaluating'
           order by r.updated_at
           for update skip locked
           limit 1
        )
       returning id, revise_passes, revise_discarded_worse,
         coalesce(
           (select a.selected_by from public.angles a
             where a.request_id = content_requests.id and a.selected_at is not null
             limit 1),
           requester_id) as actor_id`,
    ).catch(() => null);
    if (!claimed) break;

    const cid = correlationId();
    try {
      const loop = await reviseUntilClean({
        requestId: claimed.id,
        correlationId: cid,
        actorId: claimed.actor_id ?? '',
        deadline,
        startPasses: claimed.revise_passes,
        startDiscardedWorse: claimed.revise_discarded_worse,
      });

      const patch = {
        revise_passes: loop.passes,
        revise_discarded_worse: loop.discardedWorsePass,
      };

      if (!loop.done) {
        // Out of clock with passes still available. Back to `evaluating`, which
        // is where this started, so the next tick claims it and carries on from
        // the pass count just written rather than from zero.
        await advance(claimed.id, 'revising', 'evaluating', patch);
        out.push({ requestId: claimed.id, state: 'paused', passes: loop.passes });
        break;
      }

      const status = loop.outcome === 'clean' ? 'needs_review' : 'needs_human';
      await advance(claimed.id, 'revising', status, patch);
      await notifyVerdict(claimed.id, cid, loop);
      out.push({ requestId: claimed.id, state: status, passes: loop.passes });
    } catch (e) {
      /*
       * A FAILED REVISION IS NOT A FAILED REQUEST.
       *
       * The draft and the channel assets already exist and are already paid
       * for. Sending this to `angles_ready` would throw them away over a
       * transient model error, so it goes back to `evaluating` and the next
       * tick tries again. A row that fails every time stops moving, and the
       * thirty-minute sweep is what eventually notices.
       */
      await advance(claimed.id, 'revising', 'evaluating');
      await event({
        correlationId: cid, requestId: claimed.id,
        stage: 'revise.failed', outcome: 'failed',
        detail: { error: e instanceof Error ? e.message : String(e), passes: claimed.revise_passes },
      });
      out.push({ requestId: claimed.id, state: 'failed', passes: claimed.revise_passes });
    }
  }

  return out;
}

/** The verdict notification, which used to be sent by the generate route. */
async function notifyVerdict(
  requestId: string,
  cid: string,
  loop: Awaited<ReturnType<typeof reviseUntilClean>>,
) {
  const angle = await one<{ title: string }>(
    `select title from public.angles
      where request_id=$1 and selected_at is not null limit 1`, [requestId]).catch(() => null);
  const fresh = await one<{ cost_usd: string }>(
    `select cost_usd from public.content_requests where id=$1`, [requestId]).catch(() => null);

  await notify({
    kind: loop.outcome === 'clean' ? 'needs_review' : 'needs_human',
    requestId, correlationId: cid,
    title: loop.outcome === 'clean'
      ? 'Draft passed the checks and is ready for review'
      : `Draft still has ${loop.blocking} blocking issue(s) and needs a person`,
    lines: [
      angle?.title ? `**Angle:** ${angle.title}` : '',
      `**Revision passes:** ${loop.passes} of ${MAX_REVISIONS}` +
        (loop.discardedWorsePass ? ' (one pass scored worse and was discarded)' : ''),
      loop.finalScore ? `**Judge score:** ${loop.finalScore.toFixed(1)}/5` : '',
      `**Cost so far:** $${Number(fresh?.cost_usd ?? 0).toFixed(3)}`,
    ].filter(Boolean),
    to: await editorsAndRequester(requestId),
    path: `/requests/${requestId}/review`,
  });
}

async function editorsAndRequester(requestId: string) {
  return query<{ email: string; name: string; role: string }>(
    `select u.email, u.name, u.role from public.users u
      where u.id=(select requester_id from public.content_requests where id=$1)
         or u.role in ('editor','admin')`, [requestId]);
}

export type TickResult = {
  claimed: number; sent: number; blocked: number; failed: number;
  /**
   * `queued_manual` counted as `blocked`, which made the alerting cry wolf.
   *
   * An X post with no paid credentials is the EXPECTED outcome, not an
   * incident: the post was researched, written, checked and approved, and a
   * person copies it out. Folding it into `blocked` meant the n8n workflow
   * paged #content-errors on every single X post, and an alert that fires on
   * the normal case is an alert people turn off.
   */
  queuedManual: number;
  /** Requests recovered from a dead process. A non-zero here means a crash. */
  swept: { id: string; from: string; to: string }[];
  // `requestId` is carried on every detail so the notification grouping below
  // can key on it. The previous version zipped `rows[i]` to `details[i]` and
  // relied on every branch pushing exactly one detail - true today, silently
  // wrong the first time someone adds a branch that pushes two or none, and
  // the symptom would be a publishing outcome mailed to the wrong client.
  details: { requestId: string; channel: string; state: string; code?: string }[];
  /**
   * Requests whose revision loop this tick drove, and where each one landed.
   *
   * `paused` is a normal, healthy outcome — the loop ran out of its budget
   * with a pass still owed — so it deliberately does NOT count towards
   * needing attention. `failed` does.
   */
  revisions: RevisionOutcome[];
};

/**
 * One tick. Driven by an n8n Schedule Trigger hitting /api/queue/tick.
 *
 * Claims a bounded batch, then for each row re-verifies the approval is still
 * valid BEFORE dispatching. An approval that was true when the row was queued
 * may not be true now — someone may have edited the asset, or a flag may have
 * reopened.
 */
export async function tick(limit = 10): Promise<TickResult> {
  const cid = correlationId();
  const startedAt = Date.now();

  // Before draining the queue, free anything a dead process left wedged.
  const swept = await sweepStalledRequests();
  for (const m of swept) {
    await event({ correlationId: cid, requestId: m.id, stage: 'sweep.stalled',
      outcome: 'ok', detail: { from: m.from, to: m.to } });
  }
  const client = await pool().connect();
  let rows: any[] = [];

  try {
    // SKIP LOCKED: two concurrent ticks each get a disjoint set, so neither
    // waits and neither takes the other's row.
    const res = await client.query(
      `update public.publish_queue
          set state='claimed', claimed_at=now(), attempts=attempts+1, updated_at=now()
        where id in (
          select id from public.publish_queue
           where due_at <= now() and attempts < 5
             and (
               state in ('queued','failed')
               -- A worker that dies mid-dispatch leaves its row claimed with
               -- nothing watching it. Without this clause the row is stranded
               -- for good: no tick ever selects it again, the queue page shows
               -- it sitting at claimed, and the post never goes out. Ten
               -- minutes is comfortably past the connectors' 20s timeouts, and
               -- reclaiming is safe because the idempotency key travels to the
               -- provider - a genuine double-send collides there rather than
               -- posting twice.
               or (state='claimed' and claimed_at < now() - interval '10 minutes')
             )
           order by due_at
           for update skip locked
           limit $1
        )
        returning *`, [limit]);
    rows = res.rows;
  } finally {
    client.release();
  }

  const out: TickResult = {
    claimed: rows.length, sent: 0, blocked: 0, failed: 0,
    queuedManual: 0, swept, details: [], revisions: [],
  };

  for (const row of rows) {
    const channel = row.channel as Channel;

    // Re-verify at dispatch, not just at approval.
    const check = await approvalIsCurrent(row.request_id, channel === 'newsletter' ? 'newsletter' : channel);
    if (!check.valid) {
      await setState(row.id, 'blocked', 'approval_not_current');
      out.blocked++;
      out.details.push({ requestId: row.request_id, channel, state: 'blocked', code: 'approval_not_current' });
      await event({ correlationId: cid, requestId: row.request_id, stage: 'publish.precheck',
        outcome: 'blocked', detail: { channel, reason: check.reason } });
      continue;
    }

    const connector = connectorFor(channel);
    if (!connector.available()) {
      // `blocked`, never `sent`. An honest failure beats a false success — and
      // for X specifically this is the expected state, not an error.
      const state = channel === 'x' ? 'queued_manual' : 'blocked';
      await setState(row.id, state, `${channel}_not_configured`);
      if (state === 'queued_manual') out.queuedManual++; else out.blocked++;
      out.details.push({ requestId: row.request_id, channel, state, code: `${channel}_not_configured` });
      await event({ correlationId: cid, requestId: row.request_id, stage: 'publish.dispatch',
        outcome: 'blocked', detail: { channel, state } });
      continue;
    }

    const started = Date.now();

    // A connector is allowed to RETURN a failure. It is not allowed to take
    // the tick down with it. Every connector catches its own fetch errors
    // today, but one unhandled throw here - a malformed payload, a JSON parse,
    // a provider SDK raising on a shape it did not expect - would abandon this
    // row at `claimed` and skip every remaining row in the batch along with
    // it. The batch is other clients' posts.
    let result: Awaited<ReturnType<typeof connector.publish>>;
    try {
      result = await connector.publish(row.payload, row.idempotency_key);
    } catch (e) {
      result = {
        ok: false,
        code: `${channel}_connector_threw`,
        // Retryable: an exception is an UNKNOWN, not a refusal. The
        // idempotency key is what makes retrying an unknown safe.
        retryable: true,
      };
      await event({ correlationId: cid, requestId: row.request_id, stage: 'publish.dispatch',
        outcome: 'failed', latencyMs: Date.now() - started,
        detail: { channel, threw: e instanceof Error ? e.message : String(e) } });
    }

    if (result.ok) {
      await query(
        `update public.publish_queue
            set state='sent', provider_message_id=$2, error_code=null, updated_at=now()
          where id=$1`, [row.id, result.providerId]);
      out.sent++; out.details.push({ requestId: row.request_id, channel, state: 'sent' });
      await event({ correlationId: cid, requestId: row.request_id, stage: 'publish.dispatch',
        outcome: 'ok', latencyMs: Date.now() - started,
        detail: { channel, providerId: result.providerId } });
      continue;
    }

    /*
     * A FAILURE THE PROVIDER WILL NEVER ACCEPT IS NOT A RETRY CANDIDATE.
     *
     * This keyed on `blocked` alone, so a connector returning
     * `retryable: false` still landed in `failed` — and the claim above
     * re-selects `failed` rows while `attempts < 5`. The result was a post
     * the provider had definitively refused being offered back to it four
     * more times.
     *
     * That is how the LinkedIn duplicate nearly went out. LinkedIn rejected
     * the second copy with a 422 because it detects duplicate shares, and
     * the connector correctly called it non-retryable — but the row went to
     * `failed` and would have been retried until LinkedIn's own duplicate
     * window expired, at which point the copy it had just refused would have
     * been accepted. A provider's "no" has to be recorded as a no.
     */
    const state = result.blocked || result.retryable === false ? 'blocked' : 'failed';
    await setState(row.id, state, result.code);
    if (state === 'blocked') out.blocked++; else out.failed++;
    out.details.push({ requestId: row.request_id, channel, state, code: result.code });
    await event({ correlationId: cid, requestId: row.request_id, stage: 'publish.dispatch',
      outcome: state === 'blocked' ? 'blocked' : 'failed', latencyMs: Date.now() - started,
      detail: { channel, code: result.code, retryable: result.retryable, attempt: row.attempts } });
  }

  // One notification per request that had rows in this tick, carrying the
  // per-channel outcome. Partial failure is reported AS partial — the
  // newsletter going out while X is blocked is the normal case, not an error.
  await notifyPerRequest(out, cid);

  /*
   * REVISION RUNS LAST, ON WHATEVER CLOCK IS LEFT.
   *
   * Publishing is time-sensitive and cheap — dispatch averages 346ms — while
   * a revision pass is 146s. Letting revision go first would mean a scheduled
   * post waiting up to two and a half minutes behind an article being
   * rewritten, which is the wrong thing to make wait.
   *
   * Whatever does not fit is not lost. Each request is left where the next
   * tick will find it, with its pass count written down.
   */
  out.revisions = await driveRevisions(startedAt + REVISION_BUDGET_MS);
  for (const rev of out.revisions) {
    await event({
      correlationId: cid, requestId: rev.requestId, stage: 'revise.driven',
      outcome: rev.state === 'failed' ? 'failed' : 'ok',
      detail: { state: rev.state, passes: rev.passes },
    });
  }
  return out;
}

async function setState(id: string, state: string, code: string) {
  await query(
    `update public.publish_queue
        set state=$2, error_code=$3, last_error_at=now(), updated_at=now()
      where id=$1`, [id, state, code]);
}

async function notifyPerRequest(out: TickResult, cid: string) {
  const byRequest = new Map<string, { sent: string[]; blocked: string[]; failed: string[] }>();
  for (const d of out.details) {
    const g = byRequest.get(d.requestId) ?? { sent: [], blocked: [], failed: [] };
    if (d.state === 'sent') g.sent.push(d.channel);
    else if (d.state === 'failed') g.failed.push(`${d.channel} (${d.code})`);
    else g.blocked.push(`${d.channel} (${d.code})`);
    byRequest.set(d.requestId, g);
  }

  for (const [requestId, g] of byRequest) {
    const people = await recipientsFor(requestId);
    const anyFailed = g.failed.length > 0;
    await notify({
      kind: anyFailed ? 'publish_failed' : 'published',
      requestId, correlationId: cid,
      title: anyFailed
        ? `Publishing did not complete`
        : `Published to ${g.sent.join(', ') || 'no channel'}`,
      lines: [
        g.sent.length ? `**Sent:** ${g.sent.join(', ')}` : '**Sent:** nothing',
        g.blocked.length ? `**Blocked:** ${g.blocked.join(', ')}` : '',
        g.failed.length ? `**Failed:** ${g.failed.join(', ')}` : '',
      ].filter(Boolean),
      to: people,
      path: `/requests/${requestId}`,
    });
  }
}

/** The requester and every editor — publication outcome is both their business. */
export async function recipientsFor(requestId: string) {
  return query<{ email: string; name: string; role: string }>(
    `select u.email, u.name, u.role from public.users u
      where u.id = (select requester_id from public.content_requests where id=$1)
         or u.role in ('editor','admin')`, [requestId]);
}
