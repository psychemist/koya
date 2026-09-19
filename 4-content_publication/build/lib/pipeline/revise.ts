import { query, one } from '../db';
import { event } from '../audit';
import { call, wrapSource, SOURCE_RULE } from '../claude/client';
import { MODELS } from '../claude/models';
import { ARTICLE_SCHEMA, CHANNEL_SCHEMA } from '../claude/schemas';
import { DRAFT_SYSTEM, CHANNEL_SYSTEM } from '../claude/prompts';
import { config } from '../config';
import { selectedExcerpts } from './generate';
import { evaluate, type EvalResult } from './evaluate';

/** Hard cap. Beyond this the request escalates to a person, never auto-approves. */
export const MAX_REVISIONS = 2;

export type LoopResult = {
  passes: number;
  finalScore: number;
  blocking: number;
  costUsd: number;
  outcome: 'clean' | 'needs_human';
  discardedWorsePass: boolean;
  /**
   * Whether the loop reached a verdict, as opposed to running out of wall
   * clock with work still to do.
   *
   * `outcome` always describes the assets as they stand, so it is never a
   * lie, but it is only FINAL when this is true. A caller that advanced the
   * request on `outcome` alone would report "needs a person" for a draft
   * whose second pass simply had not started yet.
   */
  done: boolean;
};

/**
 * The evaluator-optimizer loop, fenced on four sides.
 *
 * Anthropic's own guidance pairs this pattern with a warning: it costs more
 * tokens, and complexity is only worth adding when it demonstrably improves
 * the outcome. So:
 *
 *  1. TWO PASSES, HARD CAP. Then `needs_human`, never silent acceptance.
 *  2. ONLY FAILING ASSETS ARE REWRITTEN. Everything else stays byte-identical.
 *  3. MONOTONICITY GUARD. If a pass scores WORSE than its parent, the parent
 *     is kept and the loop stops. Loops can make things worse; a loop that
 *     cannot tell is worse than no loop at all.
 *  4. TARGETED INSTRUCTIONS. A deterministic flag carries the exact fix
 *     ("the X post is 312 characters; cut to 280 without losing the hook").
 *     "Try again" is a coin flip.
 */
export async function reviseUntilClean(opts: {
  requestId: string; correlationId: string; actorId: string;
  /**
   * Epoch ms after which no NEW pass is started.
   *
   * A pass is a full-article generation, measured at 146s on average and 218s
   * at worst, and there is no way to interrupt one once the model call is in
   * flight. So the deadline is checked BEFORE committing to a pass, never
   * during. Whatever is left is picked up by the next tick, which is why
   * `passes` is persisted rather than recounted.
   */
  deadline?: number;
  /** Passes already spent by an earlier tick on this same generation. */
  startPasses?: number;
  /** Whether an earlier tick already discarded a pass on the guard. */
  startDiscardedWorse?: boolean;
}): Promise<LoopResult> {
  let evalResult: EvalResult = await evaluate({
    requestId: opts.requestId, correlationId: opts.correlationId,
  });
  let costUsd = evalResult.costUsd;
  let passes = opts.startPasses ?? 0;
  let discardedWorsePass = opts.startDiscardedWorse ?? false;
  let ranOutOfTime = false;

  while (evalResult.blocking > 0 && passes < MAX_REVISIONS) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      ranOutOfTime = true;
      break;
    }
    passes++;
    const previousScore = evalResult.score;

    const revised = await reviseFailing(opts, evalResult);
    costUsd += revised.costUsd;

    if (!revised.changed) {
      // Nothing was rewritten, so re-evaluating would burn tokens to reach the
      // identical verdict.
      break;
    }

    const next = await evaluate({ requestId: opts.requestId, correlationId: opts.correlationId });
    costUsd += next.costUsd;

    // ---- monotonicity guard ----
    if (next.tier1Ran && evalResult.tier1Ran && next.score < previousScore) {
      /**
       * REVERT WHAT THE JUDGE ACTUALLY JUDGED.
       *
       * Tier 1 scores the ARTICLE and nothing else. The first version of this
       * reverted every asset the pass had touched, so a dip in the article's
       * prose score also undid the channel fixes made in the same pass. A real
       * run did exactly that: the X post had been cut from 338 characters to
       * 276, which is the difference between failing the length gate and
       * passing it, and the revert put the 338-character version back. The
       * request finished as `needs_human` carrying a blocking finding that had
       * already been fixed.
       *
       * A channel asset is governed by Tier 0, which is deterministic and not
       * a matter of taste. If its own blocking count did not get worse, the
       * new version is not worse, and there is nothing to undo.
       */
      const toRevert = selectRevertTargets(revised.touched, evalResult.flags, next.flags);

      // Keeping the better draft is an IMPROVEMENT on what already exists. If
      // it fails, the right outcome is the worse-but-complete draft plus a
      // recorded reason, never the loss of both: this pipeline has already run
      // for minutes and spent real money by the time it reaches this line.
      try {
        await rollbackTo(opts.requestId, toRevert);
        discardedWorsePass = toRevert.length > 0;

        /**
         * RE-EVALUATE AFTER A REVERT. The findings have to describe the draft
         * that is now current.
         *
         * A revert writes a NEW revision carrying the parent's body, and the
         * open findings at that moment describe the revision it just replaced.
         * On a real run that left a 338-character X post as the current
         * revision with no length finding against it, because the finding had
         * been resolved by the 276-character version the revert threw away.
         *
         * `approve` counts open blocking flags, so the gate would have passed
         * a post that breaks X's hard limit. Undoing a change and leaving the
         * verdict about the undone change in place is the same mistake as
         * never closing out the previous run's flags, arriving from the other
         * direction.
         *
         * Tier 1 here is Haiku, so the correctness is worth its cost.
         */
        if (toRevert.length) {
          const after = await evaluate({
            requestId: opts.requestId, correlationId: opts.correlationId,
          });
          costUsd += after.costUsd;
          evalResult = after;
        } else {
          // Nothing was undone, so this pass's drafts are what exist and its
          // evaluation is the current one. Holding on to the previous result
          // here would report a blocking count for assets that have since been
          // replaced, which is the same class of lie the rest of this file
          // exists to prevent.
          evalResult = next;
        }
      } catch (e) {
        await event({
          correlationId: opts.correlationId, requestId: opts.requestId,
          stage: 'revise.rollback', outcome: 'failed',
          detail: { error: e instanceof Error ? e.message : String(e), touched: revised.touched },
        });
      }
      await event({
        correlationId: opts.correlationId, requestId: opts.requestId,
        stage: 'revise.monotonicity', outcome: 'blocked',
        detail: {
          previousScore, attemptedScore: next.score,
          reverted: toRevert.map((t) => t.kind),
          kept: revised.touched.filter((t) => !toRevert.includes(t)).map((t) => t.kind),
        },
      });
      break;
    }

    evalResult = next;
  }

  const outcome = evalResult.blocking === 0 ? 'clean' : 'needs_human';

  /*
   * A PAUSE IS NOT A VERDICT, and the event log has to say which one this is.
   *
   * `revise.loop` is read as "the loop finished and this is what it decided".
   * Writing it for a tick that simply ran out of clock would record a
   * `needs_human` verdict for a draft whose next pass had not been tried,
   * and the next tick would then write a second, contradictory verdict for
   * the same generation.
   *
   * Writing SOMETHING either way matters beyond tidiness: sweepStalledRequests
   * uses the newest event as the liveness heartbeat, so a loop waiting for its
   * next tick keeps proving it is alive and is not swept out from under itself.
   */
  await event({
    correlationId: opts.correlationId, requestId: opts.requestId,
    stage: ranOutOfTime ? 'revise.paused' : 'revise.loop',
    outcome: ranOutOfTime ? 'ok' : outcome === 'clean' ? 'ok' : 'blocked',
    costUsd,
    detail: {
      passes, blocking: evalResult.blocking, score: evalResult.score, discardedWorsePass,
      ...(ranOutOfTime ? { resumesNextTick: true, passesRemaining: MAX_REVISIONS - passes } : {}),
    },
  });

  return {
    passes, finalScore: evalResult.score, blocking: evalResult.blocking,
    costUsd, outcome, discardedWorsePass, done: !ranOutOfTime,
  };
}

async function reviseFailing(
  opts: { requestId: string; actorId: string; correlationId: string },
  ev: EvalResult,
): Promise<{ costUsd: number; changed: boolean; touched: { kind: string; revision: number }[] }> {
  const req = await one<any>(`select * from public.content_requests where id=$1`, [opts.requestId]);
  const ex = await selectedExcerpts(opts.requestId);
  const band: [number, number] = [req.section_target_min ?? 700, req.section_target_max ?? 800];
  const angle = await one<any>(
    `select * from public.angles where request_id=$1 and selected_at is not null limit 1`,
    [opts.requestId]);

  const failing = [...new Set(
    ev.flags.filter((f) => f.severity === 'blocking').map((f) => f.assetKind),
  )];

  let costUsd = 0;
  const touched: { kind: string; revision: number }[] = [];

  for (const kind of failing) {
    const asset = await one<any>(
      `select * from public.assets where request_id=$1 and kind=$2 order by revision desc limit 1`,
      [opts.requestId, kind]);
    if (!asset) continue;

    // The instructions are the flags' own `action` strings, which were written
    // to be handed straight to a model.
    const instructions = ev.flags
      .filter((f) => f.assetKind === kind && f.severity === 'blocking')
      .map((f, i) => `${i + 1}. ${f.action}`).join('\n');

    const isArticle = kind === 'article';
    const res = await call<any>({
      model: MODELS.draft,
      /**
       * A revision ran out of room at 32k on a pass carrying 14 required
       * changes, and the whole generate was wound back because of it.
       *
       * Thinking is charged to the SAME ceiling as the answer, so a long list
       * of instructions buys a long deliberation that then has no room left
       * to write in. Two levers, and both are needed:
       *
       *   effort 'medium'  bounds how much of the budget goes on thinking.
       *                    Applying a named list of fixes to an existing
       *                    draft is the most constrained task in the pipeline,
       *                    so the top of the effort range buys little here.
       *   a higher ceiling because the article being rewritten is itself
       *                    ~3.5k tokens before a word is changed.
       */
      effort: 'medium',
      maxTokens: isArticle ? 48000 : 16000,
      schema: (isArticle ? ARTICLE_SCHEMA : CHANNEL_SCHEMA) as unknown as Record<string, unknown>,
      system: [{ type: 'text', text: isArticle
        ? DRAFT_SYSTEM(band, angle?.primary_keyword ?? '')
        : CHANNEL_SYSTEM[kind as 'linkedin' | 'x' | 'newsletter'], cache: true }],
      user: [
        { type: 'text', text:
          `${SOURCE_RULE}\n\n${ex.map((e) => wrapSource(e.label, e.url, e.text)).join('\n\n')}`,
          cache: true },
        { type: 'text', text:
          `--- CURRENT ${kind.toUpperCase()} ---\n\n${asset.body}\n\n` +
          `--- REQUIRED CHANGES ---\n${instructions}\n\n` +
          `Apply exactly these changes. Change nothing else. Keep every citation label ` +
          `that is still supported, and do not introduce a fact no excerpt carries.` },
      ],
    });
    costUsd += res.costUsd;

    const nextRev = asset.revision + 1;
    const body = isArticle
      ? `# ${res.value.title}\n\n` +
        res.value.sections.map((s: any) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
      : res.value.body;

    await query(
      `insert into public.assets
         (request_id, kind, revision, parent_revision, body, sections, subject_line,
          origin, model, prompt_version, tokens_in, tokens_out,
          cache_read_tokens, cost_usd, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,'auto_revise',$8,$9,$10,$11,$12,$13,$14)`,
      [opts.requestId, kind, nextRev, asset.revision, body,
       isArticle ? JSON.stringify(res.value.sections) : '[]',
       res.value.subject_line ?? asset.subject_line,
       res.model, config.promptVersion, res.usage.input, res.usage.output,
       res.usage.cacheRead, res.costUsd, opts.actorId]);

    touched.push({ kind, revision: nextRev });
  }

  return { costUsd, changed: touched.length > 0, touched };
}


/**
 * Which of the assets a pass touched should actually go back.
 *
 * Tier 1 scores the ARTICLE and nothing else, so the judge's verdict is only
 * evidence about the article. A channel asset is governed by Tier 0, which is
 * deterministic and not a matter of taste: if its own blocking count did not
 * get worse, the new version is not worse, and there is nothing to undo.
 *
 * Reverting everything a pass touched is how a real run threw away an X post
 * that had been cut from 338 characters to 276, because the article's prose
 * score happened to dip in the same pass.
 */
export function selectRevertTargets<T extends { kind: string }>(
  touched: T[],
  before: { assetKind: string; severity: string }[],
  after: { assetKind: string; severity: string }[],
): T[] {
  const blockingByKind = (flags: { assetKind: string; severity: string }[]) => {
    const m = new Map<string, number>();
    for (const f of flags) {
      if (f.severity === 'blocking') m.set(f.assetKind, (m.get(f.assetKind) ?? 0) + 1);
    }
    return m;
  };
  const was = blockingByKind(before);
  const now = blockingByKind(after);

  return touched.filter((t) =>
    t.kind === 'article'
      ? true                                              // the judge's verdict
      : (now.get(t.kind) ?? 0) > (was.get(t.kind) ?? 0)); // strictly worse only
}

/**
 * Undo a pass that scored worse.
 *
 * The revision is not erased — it is superseded by a copy of its parent,
 * recorded with origin 'revert'. The failed attempt stays in the history,
 * because "we tried this and it was worse" is exactly the kind of thing the
 * review history exists to preserve.
 */
async function rollbackTo(requestId: string, touched: { kind: string; revision: number }[]) {
  for (const t of touched) {
    const parent = await one<any>(
      `select * from public.assets where request_id=$1 and kind=$2 and revision=$3`,
      [requestId, t.kind, t.revision - 1]);
    if (!parent) continue;
    await query(
      `insert into public.assets
         (request_id, kind, revision, parent_revision, body, sections, subject_line,
          origin, model, prompt_version, cost_usd)
       values ($1,$2,$3,$4,$5,$6,$7,'revert',$8,$9,0)`,
      [requestId, t.kind, t.revision + 1, t.revision, parent.body,
       // JSON.stringify IS LOAD-BEARING, and leaving it out broke the one
       // safety feature this function exists to provide.
       //
       // `sections` is a jsonb ARRAY, so node-postgres hands it back as a JS
       // array. Passing a JS array straight back as a parameter makes the
       // driver format it as a POSTGRES array literal, `{...}`, not as JSON,
       // and the jsonb column rejects it: `invalid input syntax for type
       // json`. Object-valued columns survive the round trip because the
       // driver stringifies those, which is exactly why this hid for so long:
       // object columns worked and `sections` did not.
       //
       // The effect was that the monotonicity guard threw every single time
       // it fired. A run whose second pass scored 3.6 against 3.8 hit this,
       // the error escaped the loop, and the whole generate was rolled back
       // and reported as failed. The guard that exists to keep the BETTER
       // draft was instead destroying both.
       JSON.stringify(parent.sections ?? []),
       parent.subject_line,
       parent.model, parent.prompt_version]);
  }
}
