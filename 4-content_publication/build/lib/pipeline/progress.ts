import { query, one } from '../db';

/**
 * What the pipeline is doing, right now, from the audit log.
 *
 * DERIVED, NOT STORED. There is no progress table and there should not be one:
 * a second place recording what happened is a second place that can disagree
 * with what happened, and this project has already been bitten once by exactly
 * that (an in-memory result and a database row making different claims about
 * the same evaluation). `events` is written by each stage as it completes and
 * is the audit log the whole design rests on. Reading progress out of it means
 * the screen cannot drift from the record.
 *
 * It also means the view survives a crash for free. A dead process writes no
 * further events, the stage stays `active` with its elapsed time climbing, and
 * the queue tick's stall sweep is what eventually moves it. Nothing here has
 * to guess.
 *
 * THE TRANSIENT STATUSES ARE WHAT MAKE A STAGE "ACTIVE", not the absence of a
 * completion event. A run that has finished and moved on has no event for the
 * stage it is currently in either, so keying on absence alone would show every
 * completed request as permanently mid-research.
 */
export type StageState = 'pending' | 'active' | 'waiting' | 'done' | 'failed' | 'skipped';

export type Stage = {
  key: string;
  label: string;
  /** What the stage is for, in one line. Shown under the label. */
  blurb: string;
  state: StageState;
  detail?: string;
  at?: string;
  latencyMs?: number;
  costUsd?: number;
  /** True where the pipeline stops and waits for a person. */
  human?: boolean;
};

export type Progress = {
  requestId: string;
  status: string;
  costUsd: number;
  updatedAt: string;
  stages: Stage[];
  /** Is anything actually moving? The client polls only while this is true. */
  running: boolean;
  /** Where the pipeline is parked waiting on someone, if it is. */
  waitingOn: string | null;
};

type Ev = {
  stage: string; outcome: string; detail: any;
  latency_ms: number | null; cost_usd: string | null; created_at: Date;
};

/** The statuses that mean a process is mid-flight rather than parked. */
const TRANSIENT: Record<string, string> = {
  researching: 'research',
  planning: 'plan',
  drafting: 'draft',
  evaluating: 'evaluate',
  // Claimed by a tick and being revised right now. `evaluating` is the same
  // spine position, but it now means "handed off, waiting for a tick to pick
  // it up" rather than "a process is working on it this second".
  revising: 'revise',
};

const HUMAN_WAIT: Record<string, { stage: string; what: string }> = {
  angles_ready: { stage: 'choose', what: 'Somebody has to pick an angle. Nothing is written until they do.' },
  needs_review: { stage: 'review', what: 'Waiting on an editor to approve, send back or reject it.' },
  needs_human: { stage: 'review', what: 'The checks could not be cleared automatically. An editor has to decide.' },
  changes_requested: { stage: 'review', what: 'Sent back to the author with a note.' },
};

/** Order matters: it is the order the pipeline runs in and the screen reads in. */
const SPINE: { key: string; label: string; blurb: string; human?: boolean }[] = [
  { key: 'intake', label: 'Request raised',
    blurb: 'Checked against what has already been published, before anything costs money.' },
  { key: 'research', label: 'Reading the sources',
    blurb: 'Fetches what you gave it and the competing articles, and quarantines prompt injection.' },
  { key: 'plan', label: 'Planning three angles',
    blurb: 'Three outlines, not three articles. Opus runs once, here.' },
  { key: 'choose', label: 'Pick an angle', human: true,
    blurb: 'Human gate one. Nothing is written until somebody chooses.' },
  { key: 'draft', label: 'Writing the article',
    blurb: 'Sonnet drafts against the chosen outline, from the selected excerpts only.' },
  { key: 'adapt', label: 'Adapting for each channel',
    blurb: 'Three separate calls sharing one cached prefix, so one failure cannot take the others.' },
  { key: 'evaluate', label: 'Running the checks',
    blurb: 'The mechanical gates first, then a judge that is a different model from the writer.' },
  { key: 'revise', label: 'Revising against the findings',
    blurb: 'Up to two passes, and a pass that scores worse is rolled back.' },
  { key: 'review', label: 'Human review', human: true,
    blurb: 'Human gate two. An editor other than the author signs it off.' },
  { key: 'publish', label: 'Publishing',
    blurb: 'The approval is rechecked immediately before anything leaves the building.' },
];

/** Which event completes which stage. */
const COMPLETES: Record<string, string> = {
  'intake.create': 'intake',
  'plan.angles': 'plan',
  'generate.draft': 'draft',
  'generate.adapt': 'adapt',
  'evaluate.tier1': 'evaluate',
  'revise.loop': 'revise',
  'approve': 'review',
  'publish.dispatch': 'publish',
};

/** Statuses from which everything earlier in the spine has definitely happened. */
const REACHED_BY_STATUS: Record<string, number> = {
  draft: 1, researching: 1, research_failed: 2, planning: 2, angles_ready: 3,
  drafting: 4, evaluating: 6, revising: 6, needs_review: 8, needs_human: 8,
  changes_requested: 8, rejected: 8, scheduled: 9, published: 10, publish_failed: 9,
};

export async function progressFor(requestId: string): Promise<Progress | null> {
  const r = await one<{
    id: string; status: string; cost_usd: string; updated_at: Date;
  }>(`select id, status, cost_usd, updated_at from public.content_requests where id=$1`,
     [requestId]);
  if (!r) return null;

  const events = await query<Ev>(
    `select stage, outcome, detail, latency_ms, cost_usd, created_at
       from public.events where request_id=$1 order by created_at asc`, [requestId]);

  const activeKey = TRANSIENT[r.status];
  const wait = HUMAN_WAIT[r.status];
  const reached = REACHED_BY_STATUS[r.status] ?? 0;

  const stages: Stage[] = SPINE.map((spec, i) => {
    const done = [...events].reverse().find(
      (e) => COMPLETES[e.stage] === spec.key && e.outcome === 'ok');

    let state: StageState =
      done ? 'done'
      : spec.key === activeKey ? 'active'
      : wait?.stage === spec.key ? 'waiting'
      : i < reached ? 'done'
      : 'pending';

    // `evaluate` and `revise` share the `evaluating` status, so the status
    // alone cannot say which of the two is running. The events can: once the
    // judge has scored, what is running is the revision.
    if (spec.key === 'revise' && activeKey === 'evaluate'
        && events.some((e) => e.stage === 'evaluate.tier1')) {
      state = 'active';
    }
    if (spec.key === 'evaluate' && activeKey === 'evaluate'
        && events.some((e) => e.stage === 'evaluate.tier1')) {
      state = 'done';
    }

    const failed = [...events].reverse().find(
      (e) => failsStage(e.stage) === spec.key && e.outcome === 'failed');
    if (failed && state !== 'done' && state !== 'active') state = 'failed';

    return {
      key: spec.key,
      label: spec.label,
      blurb: spec.blurb,
      human: spec.human,
      state,
      detail: detailFor(spec.key, events, state, wait),
      at: (done ?? failed)?.created_at?.toISOString(),
      latencyMs: done?.latency_ms ?? undefined,
      costUsd: done?.cost_usd ? Number(done.cost_usd) : undefined,
    };
  });

  return {
    requestId: r.id,
    status: r.status,
    costUsd: Number(r.cost_usd ?? 0),
    updatedAt: r.updated_at.toISOString(),
    stages,
    running: Boolean(activeKey),
    waitingOn: wait?.what ?? null,
  };
}

const failsStage = (stage: string) =>
  ({ 'generate.rolled_back': 'draft', 'publish.dispatch': 'publish',
     'research.extract': 'research' }[stage]);

/**
 * The line under a stage, which is where the useful part lives.
 *
 * "Reading the sources" tells somebody nothing they did not already know from
 * the fact that they clicked the button. "7 read, 2 skipped, 1 quarantined"
 * tells them whether to keep waiting, and it is exactly the number that would
 * otherwise send them to the Sources tab to count rows by hand.
 */
function detailFor(
  key: string, events: Ev[], state: StageState,
  wait?: { stage: string; what: string },
): string | undefined {
  if (state === 'waiting' && wait) return wait.what;
  if (state === 'pending') return undefined;

  if (key === 'research') {
    const fetches = events.filter((e) => e.stage === 'research.fetch');
    if (!fetches.length) return undefined;
    const ok = fetches.filter((e) => e.outcome === 'ok').length;
    const skipped = fetches.filter((e) => e.outcome === 'skipped').length;
    const failed = fetches.filter((e) => e.outcome === 'failed').length;
    const quarantined = events.filter((e) => e.stage === 'research.quarantine').length;
    return [
      `${ok} read`,
      skipped ? `${skipped} skipped` : '',
      failed ? `${failed} failed` : '',
      quarantined ? `${quarantined} quarantined` : '',
    ].filter(Boolean).join(', ');
  }

  if (key === 'plan') {
    const e = events.find((x) => x.stage === 'plan.angles');
    return e?.detail?.angles ? `${e.detail.angles} angles to choose between` : undefined;
  }
  if (key === 'draft') {
    const e = [...events].reverse().find((x) => x.stage === 'generate.draft');
    if (e?.detail?.sections) return `${e.detail.sections} sections, revision ${e.detail.revision}`;
    const rolled = [...events].reverse().find((x) => x.stage === 'generate.rolled_back');
    return rolled ? 'Rolled back, and the angle was released so it can be retried' : undefined;
  }
  if (key === 'adapt') {
    const e = [...events].reverse().find((x) => x.stage === 'generate.adapt');
    if (!e) return undefined;
    const failures: string[] = e.detail?.failures ?? [];
    const requested: string[] = e.detail?.requested ?? [];
    return failures.length
      ? `${requested.length - failures.length} of ${requested.length} written, ${failures.length} failed`
      : `${requested.length} written`;
  }
  if (key === 'evaluate') {
    const t1 = [...events].reverse().find((x) => x.stage === 'evaluate.tier1');
    return t1?.detail?.score ? `Judge scored ${Number(t1.detail.score).toFixed(1)} of 5` : undefined;
  }
  if (key === 'revise') {
    const e = [...events].reverse().find((x) => x.stage === 'revise.loop');
    if (!e) return undefined;
    const passes = e.detail?.passes;
    const blocking = e.detail?.blocking;
    return [
      passes != null ? `${passes} pass${passes === 1 ? '' : 'es'}` : '',
      blocking ? `${blocking} still blocking` : blocking === 0 ? 'nothing blocking' : '',
    ].filter(Boolean).join(', ') || undefined;
  }
  if (key === 'publish') {
    const sent = events.filter((e) => e.stage === 'publish.dispatch' && e.outcome === 'ok').length;
    const failed = events.filter((e) => e.stage === 'publish.dispatch' && e.outcome === 'failed').length;
    if (!sent && !failed) return undefined;
    return [sent ? `${sent} sent` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
  }
  return undefined;
}
