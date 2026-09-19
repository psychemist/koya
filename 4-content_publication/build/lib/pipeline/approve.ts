import { query, one, tx } from '../db';
import { stableHash } from '../hash';
import { Errors } from '../errors';
import { config } from '../config';
import { decisionRefusal } from '../auth';
import type { AssetKind } from '../gates/types';

/**
 * The evidence bundle — what the reviewer is shown, and what gets hashed.
 *
 * Under EU AI Act Article 50 the labelling duty for AI-generated text falls
 * away only where there has been "human review or editorial control … provided
 * such checks are substantive and not limited to superficial matters or
 * cursory approval". A one-click Approve cannot be SHOWN to be substantive, so
 * it does not discharge the obligation it appears to discharge.
 *
 * Hashing what was on screen is what turns "someone clicked approve" into
 * "a named person reviewed this material" — and it is what makes the
 * six-month-later audit answerable.
 */
export async function evidenceBundle(requestId: string, kind: AssetKind) {
  const asset = await one<any>(
    `select id, kind, revision, body, subject_line
       from public.assets where request_id=$1 and kind=$2 order by revision desc limit 1`,
    [requestId, kind]);
  if (!asset) throw Errors.notFound('Asset');

  const [claims, evaluations, flags, sources] = await Promise.all([
    query(`select text, status, excerpt_id, checker from public.claims
            where asset_id=$1 order by status, text`, [asset.id]),
    query(`select tier, criterion, score, verdict, evidence, required_action
             from public.evaluations where asset_id=$1 order by tier, criterion`, [asset.id]),
    query(`select id, code, severity, status, message from public.flags
            where request_id=$1 and (asset_kind=$2 or asset_kind is null)
            order by severity, code`, [requestId, kind]),
    query(`select coalesce(final_url, submitted_url) as url, title, fetch_status,
                  quarantined, provider
             from public.sources where request_id=$1 order by submitted_url`, [requestId]),
  ]);

  const bundle = { asset, claims, evaluations, flags, sources };
  return { bundle, hash: stableHash(bundle) };
}

/**
 * Five refusals, all server-side, each with its own test.
 *
 * The UI hides these buttons too, but the UI is not the control — a route that
 * trusts the UI is a route with no authorisation at all.
 */
export async function approve(opts: {
  requestId: string;
  kind: AssetKind;
  actorId: string;
  actorRole: string;
  decision: 'approved' | 'changes_requested' | 'rejected';
  note?: string;
  evidenceHash: string;
  expectedVersion: number;
}) {
  return tx(async (c) => {
    const req = (await c.query(
      `select * from public.content_requests where id=$1 for update`, [opts.requestId])).rows[0];
    if (!req) throw Errors.notFound('Request');

    /*
     * (1) status must permit a decision.
     *
     * `scheduled` is included deliberately. The request has ONE status
     * column shared by up to four assets (the article plus up to three
     * channels), each decided separately. The moment the FIRST approved
     * channel gets queued, the request advances to `scheduled` — which
     * used to lock out every asset that had not been decided yet: approve
     * the LinkedIn post, and the X and newsletter posts could never be
     * approved at all, forever, because the request was no longer
     * `needs_review`. A request already scheduled still has real,
     * undecided work sitting on it.
     */
    if (!['needs_review', 'needs_human', 'scheduled'].includes(req.status)) {
      throw Errors.conflict(
        `This request is ${req.status}, so it cannot be approved right now. Nothing was lost.`);
    }

    // (1b) Nothing left to decide if this exact revision is already approved.
    if (opts.decision === 'approved') {
      const already = (await c.query(
        `select 1 from public.approvals
          where request_id=$1 and asset_kind=$2 and decision='approved'
            and asset_revision=(
              select revision from public.assets
               where request_id=$1 and kind=$2 order by revision desc limit 1)`,
        [opts.requestId, opts.kind])).rows[0];
      if (already) {
        throw Errors.conflict(
          `This revision of the ${opts.kind} has already been approved. Reload to see its ` +
          `current state.`);
      }
    }

    // (2) optimistic concurrency — two reviewers acting at once must lose safely
    if (req.version !== opts.expectedVersion) {
      throw Errors.conflict(
        'Someone else changed this request while you were reviewing. ' +
        'Reload to see their change. Nothing you did was lost.');
    }

    /*
     * (3) ROLE AND SEPARATION OF DUTIES, and it now covers all three decisions.
     *
     * The previous version gated the ROLE check on `decision === 'approved'`
     * only, so any signed-in manager could reject or send back somebody else's
     * draft. Both of those write a row to `approvals`, notify the author and
     * stop the work, which makes them editorial decisions with exactly the
     * standing of an approval and none of the authorisation.
     *
     * The rule lives in lib/auth so the review screen can state it in the same
     * words rather than keeping a second copy that drifts. This is still the
     * control: the screen explains, the route refuses.
     */
    const selfApproval = req.requester_id === opts.actorId;
    const soloOverride = selfApproval && config.soloOperatorOverride;
    const refusal = decisionRefusal({
      actorId: opts.actorId, actorRole: opts.actorRole,
      requesterId: req.requester_id, decision: opts.decision, soloOverride,
    });
    if (refusal) throw Errors.blocked(refusal);

    // (4) blocking flags refuse approval, in the database, not in the UI
    if (opts.decision === 'approved') {
      const open = (await c.query(
        `select count(*)::int as n from public.flags
          where request_id=$1 and severity='blocking' and status='open'
            and (asset_kind=$2 or asset_kind is null)`,
        [opts.requestId, opts.kind])).rows[0]?.n ?? 0;
      if (open > 0) {
        throw Errors.blocked(
          `${open} blocking issue${open === 1 ? '' : 's'} still open on the ${opts.kind}. ` +
          `Resolve or waive each one. A waiver needs a written reason.`);
      }
    }

    /*
     * (4b) THE ARTICLE CANNOT BE APPROVED UNTIL THE JUDGE HAS SCORED IT.
     *
     * Tier 0 is deterministic and runs on every asset; Tier 1 is the model
     * judge and it scores the ARTICLE only. An article with no Tier 1 rows
     * has passed the mechanical checks and has had no opinion formed about
     * whether it is any good — and "no blocking flags" then means nothing was
     * asked, not that nothing was wrong. Approving there is approving an
     * unreviewed draft while the screen implies otherwise.
     *
     * It is a real state, not a hypothetical. Three article revisions in the
     * database sit at zero Tier 1 rows: two where a revision pass wrote a new
     * revision and the process died before the re-evaluate, and one from a
     * revert. A human edit does it too by design — the edit route re-runs
     * Tier 0 with `skipJudge: true`, so every hand-edited article lands here.
     *
     * The scores are keyed to the asset id, so this asks about the CURRENT
     * revision specifically. A judgement of the revision before the edit is
     * not a judgement of this one, which is the same rule that already voids
     * an approval when the asset changes underneath it.
     */
    if (opts.decision === 'approved' && opts.kind === 'article') {
      const judged = (await c.query(
        `select (select count(*)::int from public.evaluations e
                  where e.asset_id = a.id and e.tier = 1) as n
           from public.assets a
          where a.request_id=$1 and a.kind='article'
          order by a.revision desc limit 1`,
        [opts.requestId])).rows[0]?.n ?? 0;
      if (judged === 0) {
        throw Errors.blocked(
          'The judge has not scored this revision of the article, so there is nothing to ' +
          'approve against. Re-run the checks from the review screen. This happens after a ' +
          'hand edit, which re-runs the mechanical checks but not the judge.');
      }
    }

    // (5) the approval names the EXACT revision it applies to. Comparing this
    //     to the current revision later is how "any edit voids the approval"
    //     is enforced — one comparison, not a trigger and not a convention.
    const asset = (await c.query(
      `select revision from public.assets where request_id=$1 and kind=$2
        order by revision desc limit 1`, [opts.requestId, opts.kind])).rows[0];
    if (!asset) throw Errors.notFound('Asset');

    await c.query(
      `insert into public.approvals
         (request_id, asset_kind, actor_id, decision, note, evidence_hash, asset_revision, solo_override)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [opts.requestId, opts.kind, opts.actorId, opts.decision, opts.note ?? null,
       opts.evidenceHash, asset.revision, soloOverride]);

    return { revision: asset.revision, soloOverride };
  });
}

/**
 * A blocking flag cleared by a written reason instead of a rewrite.
 *
 * The schema has supported this since the gate was built — `flags.status`
 * has always included 'waived', with a NOT NULL check on `waiver_reason` and
 * a `waived_by`/`waived_at` pair (db/migrations/0001_init.sql) — and the
 * review screen's own copy has told reviewers "resolve or waive each one"
 * the whole time. No route ever implemented the second half, so waiving was
 * a sentence on screen that did nothing.
 *
 * Same authorisation as approving, and for the same reason: the author
 * cannot wave away a check on their own work, because a waiver is exactly
 * the kind of decision separation of duties exists to catch.
 */
export async function waiveFlag(opts: {
  flagId: string;
  requestId: string;
  actorId: string;
  actorRole: string;
  reason: string;
}) {
  const reason = opts.reason.trim();
  if (!reason) throw Errors.validation('A waiver needs a written reason.');

  return tx(async (c) => {
    const req = (await c.query(
      `select requester_id from public.content_requests where id=$1 for update`,
      [opts.requestId])).rows[0];
    if (!req) throw Errors.notFound('Request');

    const selfApproval = req.requester_id === opts.actorId;
    const soloOverride = selfApproval && config.soloOperatorOverride;
    const refusal = decisionRefusal({
      actorId: opts.actorId, actorRole: opts.actorRole,
      requesterId: req.requester_id, decision: 'approved', soloOverride,
    });
    if (refusal) throw Errors.blocked(refusal);

    const flag = (await c.query(
      `select id, status from public.flags where id=$1 and request_id=$2 for update`,
      [opts.flagId, opts.requestId])).rows[0];
    if (!flag) throw Errors.notFound('Flag');
    if (flag.status !== 'open') {
      throw Errors.conflict(
        'This finding is no longer open. Reload to see its current state.');
    }

    await c.query(
      `update public.flags
          set status='waived', waiver_reason=$2, waived_by=$3, waived_at=now()
        where id=$1`,
      [opts.flagId, reason, opts.actorId]);
  });
}

/**
 * Is the approval still valid for what the asset says NOW?
 *
 * Without this, "a human approved it" is defeated by approving a clean draft
 * and editing it before the queue fires. Called at approval time AND again
 * immediately before dispatch, because a flag can reopen in between.
 */
export async function approvalIsCurrent(requestId: string, kind: AssetKind): Promise<{
  valid: boolean; reason?: string;
}> {
  const approval = await one<any>(
    `select * from public.approvals
      where request_id=$1 and asset_kind=$2 and decision='approved'
      order by created_at desc limit 1`, [requestId, kind]);
  if (!approval) return { valid: false, reason: 'This asset has not been approved.' };

  const asset = await one<{ revision: number }>(
    `select revision from public.assets where request_id=$1 and kind=$2
      order by revision desc limit 1`, [requestId, kind]);
  if (!asset) return { valid: false, reason: 'The asset no longer exists.' };

  if (asset.revision !== approval.asset_revision) {
    return {
      valid: false,
      reason: `Approved revision ${approval.asset_revision}, but the ${kind} is now at ` +
              `revision ${asset.revision}. The edit voided the approval, so it needs approving again.`,
    };
  }

  const open = await one<{ n: number }>(
    `select count(*)::int as n from public.flags
      where request_id=$1 and severity='blocking' and status='open'
        and (asset_kind=$2 or asset_kind is null)`, [requestId, kind]);
  if ((open?.n ?? 0) > 0) {
    return { valid: false, reason: `A blocking issue reopened after approval. Not sending.` };
  }
  return { valid: true };
}
