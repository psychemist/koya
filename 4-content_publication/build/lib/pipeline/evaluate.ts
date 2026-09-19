import { query, one } from '../db';
import { event } from '../audit';
import { call, wrapSource, SOURCE_RULE } from '../claude/client';
import { MODELS } from '../claude/models';
import { JUDGE_SCHEMA } from '../claude/schemas';
import { JUDGE_SYSTEM } from '../claude/prompts';
import { config } from '../config';
import { selectedExcerpts } from './generate';
import type { Flag, AssetKind } from '../gates/types';
import {
  checkSeo, checkReadability, checkX, checkLinkedIn, checkNewsletter,
  checkGrounding, checkLinksInSourceSet, checkLinksResolve, checkVerbatim, checkComplete,
  checkHouseStyle, checkCitationPlaceholders,
} from '../gates/tier0';

export type EvalResult = {
  flags: Flag[];
  blocking: number;
  score: number;        // mean Tier 1 score, 0 if the judge did not run
  costUsd: number;
  tier1Ran: boolean;
};

type AssetRow = {
  id: string; kind: AssetKind; revision: number; body: string;
  subject_line: string | null; sections: any;
};

/**
 * Tier 0 then Tier 1, in that order and never the other way round.
 *
 * Tier 0 is free and it settles most of the rubric. It runs first partly for
 * cost — but mainly because output_config.format cannot express a length or a
 * numeric range, so these rules have nowhere else to live. A schema will
 * cheerfully return a 312-character X post.
 *
 * Tier 1 only ever sees what the free pass could not decide.
 */
export async function evaluate(opts: {
  requestId: string; correlationId: string; checkLinksOnline?: boolean;
  /** Skip the paid Tier 1 judge call. Used after a human edit, where only
   *  the deterministic Tier 0 rules need re-checking against the new text —
   *  running the judge again on an unrelated channel's typo fix would spend
   *  money to re-score prose that did not change. */
  skipJudge?: boolean;
}): Promise<EvalResult> {
  const req = await one<any>(`select * from public.content_requests where id=$1`, [opts.requestId]);
  if (!req) throw new Error('Request not found.');

  const assets = await latestAssets(opts.requestId);
  const excerpts = await selectedExcerpts(opts.requestId);
  const sourceUrls = [...new Set(excerpts.map((e) => e.url).filter(Boolean))];
  const angle = await one<any>(
    `select * from public.angles where request_id=$1 and selected_at is not null limit 1`,
    [opts.requestId]);

  const band: [number, number] = [
    req.section_target_min ?? 700, req.section_target_max ?? 800,
  ];

  // ---------------- TIER 0: deterministic, zero tokens ----------------
  //
  // Supersede the previous run's flags FIRST.
  //
  // Every evaluate() recomputes the complete set of findings, so a flag left
  // over from the last pass is a statement about a draft that no longer
  // exists. Leaving them open was a real defect rather than untidiness:
  // `approve` counts open blocking flags IN THE DATABASE, so a revision that
  // genuinely fixed the X post still left the pass-1 "312 characters" row
  // sitting there, and the request could then never be approved by anyone.
  // The loop reported "clean" from its in-memory result while the database
  // said the opposite, which is the worst version of the bug: the screen says
  // ready, the button says refused, and nothing explains the difference.
  //
  // Waived flags are left alone. A waiver is a human decision with a written
  // reason, and re-running a checker does not overturn it.
  await supersedeOpenFlags(opts.requestId);

  const flags: Flag[] = [];
  const article = assets.find((a) => a.kind === 'article');

  if (article) {
    const sections = Array.isArray(article.sections) ? article.sections : [];
    flags.push(...checkSeo(
      { title: titleOf(article.body), sections },
      angle?.primary_keyword ?? req.keyword_hint ?? '', band,
    ));
    flags.push(...checkReadability(article.body, 'article'));
  }

  for (const a of assets) {
    if (a.kind === 'x') flags.push(...checkX(a.body));
    if (a.kind === 'linkedin') flags.push(...checkLinkedIn(a.body));
    if (a.kind === 'newsletter') flags.push(...checkNewsletter(a.body, a.subject_line));

    const g = checkGrounding(a.body, excerpts, a.kind);
    flags.push(...g.flags);
    await recordClaims(a.id, g.claims, excerpts);

    flags.push(...checkLinksInSourceSet(a.body, sourceUrls, a.kind));
    flags.push(...checkVerbatim(a.body, excerpts, a.kind));
    flags.push(...checkHouseStyle(a.body, a.kind));
    // A draft that still says [NEEDS SOURCE: …] is knowingly incomplete, and
    // without this nothing stopped it being approved and queued with the
    // placeholder intact.
    flags.push(...checkCitationPlaceholders(a.body, a.kind));

    // Network check is opt-in: it is the only slow part of Tier 0, and it must
    // not make a local evaluation loop wait on someone else's server.
    if (opts.checkLinksOnline) {
      flags.push(...await checkLinksResolve(a.body, a.kind));
    }
  }

  flags.push(...checkComplete(
    (req.channels ?? []).concat('article') as AssetKind[],
    assets.map((a) => ({
      kind: a.kind, body: a.body, subjectLine: a.subject_line,
    })),
  ));

  await persistFlags(opts.requestId, flags);
  await persistTier0(assets, flags);

  await event({
    correlationId: opts.correlationId, requestId: opts.requestId,
    stage: 'evaluate.tier0', outcome: 'ok', costUsd: 0,
    detail: { flags: flags.length, blocking: flags.filter((f) => f.severity === 'blocking').length },
  });

  // ---------------- TIER 1: model judge, on what Tier 0 could not decide ----
  // Skipped entirely, not attempted-and-ignored, when the caller only wants
  // Tier 0 re-checked — `judge_unavailable` exists to flag an evaluation that
  // was tried and failed, not one that was never asked for.
  let costUsd = 0, score = 0, tier1Ran = false;
  if (!opts.skipJudge) try {
    const judged = await runJudge(opts, assets, excerpts, req);
    costUsd = judged.costUsd; score = judged.score; tier1Ran = true;
    flags.push(...judged.flags);
    await persistFlags(opts.requestId, judged.flags);
  } catch (e) {
    // An unparseable or failed evaluation is NEVER a pass. It is recorded as a
    // blocking flag so a human has to look, rather than quietly waved through.
    const f: Flag = {
      code: 'judge_unavailable', severity: 'blocking', assetKind: 'article',
      message: `The quality judge did not complete: ${e instanceof Error ? e.message : String(e)}`,
      action: 'Re-run evaluation. If it keeps failing, review the draft by hand before approving.',
    };
    flags.push(f);
    await persistFlags(opts.requestId, [f]);
    await event({
      correlationId: opts.correlationId, requestId: opts.requestId,
      stage: 'evaluate.tier1', outcome: 'failed',
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
  }

  await query(`update public.content_requests set cost_usd = cost_usd + $2 where id=$1`,
    [opts.requestId, costUsd]);

  return {
    flags, blocking: flags.filter((f) => f.severity === 'blocking').length,
    score, costUsd, tier1Ran,
  };
}

async function runJudge(
  opts: { requestId: string; correlationId: string },
  assets: AssetRow[], excerpts: { label: string; text: string; url: string }[], req: any,
): Promise<{ flags: Flag[]; score: number; costUsd: number }> {
  const article = assets.find((a) => a.kind === 'article');
  if (!article) return { flags: [], score: 0, costUsd: 0 };

  const res = await call<{
    overall: 'pass' | 'revise' | 'reject';
    criteria: { criterion: string; score: number; verdict: string; evidence: string; required_action: string }[];
  }>({
    // Haiku 4.5 — and the reason is NOT cost. It is a DIFFERENT MODEL from the
    // writer (Sonnet 5), which is the documented mitigation for self-preference
    // bias: judges measurably favour their own generations.
    model: MODELS.judge,
    // Haiku 4.5 still takes an explicit thinking budget, and those 2000
    // tokens come OUT of max_tokens. At 4000 the judge had ~2000 left for
    // nine criteria with evidence strings, and running out is not scored as
    // a failure of the draft - it raises `judge_unavailable`, which blocks.
    maxTokens: 8000,
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    system: [{ type: 'text', text: JUDGE_SYSTEM, cache: true }],
    user: [
      { type: 'text', text:
        `${SOURCE_RULE}\n\n` +
        excerpts.map((e) => wrapSource(e.label, e.url, e.text)).join('\n\n'), cache: true },
      // Deliberately NOT told the revision number, and never shown its own
      // prior scores, so it cannot anchor on its previous judgment.
      { type: 'text', text:
        `Request\n  Idea: ${req.idea}\n  Audience: ${req.audience}\n  Goal: ${req.goal}\n\n` +
        `--- DRAFT ---\n\n${article.body}\n\nEvaluate it.` },
    ],
  });

  const flags: Flag[] = [];
  let total = 0;
  for (const c of res.value.criteria ?? []) {
    await query(
      `insert into public.evaluations
         (asset_id, tier, criterion, score, verdict, evidence, required_action, model, schema_version, cost_usd)
       values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [article.id, c.criterion, c.score, c.verdict, c.evidence, c.required_action,
       res.model, config.evalSchemaVersion, res.costUsd / Math.max(1, res.value.criteria.length)],
    );
    total += c.score;
    if (c.verdict === 'fail' || c.score <= 2) {
      flags.push({
        code: `judge_${c.criterion}`, severity: 'blocking', assetKind: 'article',
        message: `${c.criterion.replace(/_/g, ' ')} scored ${c.score}/5. ${c.evidence}`,
        action: c.required_action,
      });
    } else if (c.verdict === 'revise' || c.score === 3) {
      flags.push({
        code: `judge_${c.criterion}`, severity: 'advisory', assetKind: 'article',
        message: `${c.criterion.replace(/_/g, ' ')} scored ${c.score}/5. ${c.evidence}`,
        action: c.required_action,
      });
    }
  }

  const n = res.value.criteria?.length || 1;
  await event({
    correlationId: opts.correlationId, requestId: opts.requestId,
    stage: 'evaluate.tier1', outcome: 'ok', costUsd: res.costUsd,
    detail: { overall: res.value.overall, mean: (total / n).toFixed(2) },
  });
  return { flags, score: total / n, costUsd: res.costUsd };
}

async function latestAssets(requestId: string): Promise<AssetRow[]> {
  return query<AssetRow>(
    `select distinct on (kind) id, kind, revision, body, subject_line, sections
       from public.assets where request_id=$1 order by kind, revision desc`,
    [requestId]);
}

/**
 * Close out the previous run's open findings.
 *
 * `resolved` rather than deleted: the history of what was wrong, and when it
 * stopped being wrong, is exactly what the review trail is for.
 */
async function supersedeOpenFlags(requestId: string) {
  await query(
    `update public.flags set status='resolved'
      where request_id=$1 and status='open'`, [requestId]);
}

async function persistFlags(requestId: string, flags: Flag[]) {
  for (const f of flags) {
    await query(
      `insert into public.flags
         (request_id, asset_kind, code, severity, message, span_start, span_end)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [requestId, f.assetKind, f.code, f.severity, `${f.message} ${f.action}`,
       f.spanStart ?? null, f.spanEnd ?? null]);
  }
}

async function persistTier0(assets: AssetRow[], flags: Flag[]) {
  for (const a of assets) {
    const mine = flags.filter((f) => f.assetKind === a.kind);
    await query(
      `insert into public.evaluations (asset_id, tier, criterion, score, verdict, evidence, required_action)
       values ($1,0,'deterministic_gates',$2,$3,$4,$5)`,
      [a.id, mine.some((f) => f.severity === 'blocking') ? 2 : 5,
       mine.some((f) => f.severity === 'blocking') ? 'fail' : 'pass',
       mine.length ? mine.map((f) => f.code).join(', ') : 'all deterministic checks passed',
       mine.map((f) => f.action).join(' ') || 'none']);
  }
}

async function recordClaims(
  assetId: string,
  claims: { text: string; status: 'supported' | 'unsupported'; label?: string }[],
  excerpts: { id: string; label: string }[],
) {
  for (const c of claims) {
    await query(
      `insert into public.claims (asset_id, text, status, excerpt_id, checker)
       values ($1,$2,$3,$4,'deterministic')`,
      [assetId, c.text, c.status,
       c.label ? excerpts.find((e) => e.label === c.label)?.id ?? null : null]);
  }
}

const titleOf = (body: string) => body.match(/^#\s+(.+)$/m)?.[1] ?? '';
