import { query, one } from '../db';
import { event } from '../audit';
import { call, wrapSource, SOURCE_RULE } from '../claude/client';
import { MODELS } from '../claude/models';
import { PLAN_SCHEMA, ARTICLE_SCHEMA, CHANNEL_SCHEMA } from '../claude/schemas';
import { PLAN_SYSTEM, DRAFT_SYSTEM, CHANNEL_SYSTEM } from '../claude/prompts';
import { config } from '../config';

export type Excerpt = { id: string; label: string; text: string; url: string };

export async function selectedExcerpts(requestId: string): Promise<Excerpt[]> {
  return query<Excerpt>(
    `select e.id, e.label, e.text, coalesce(s.final_url, s.submitted_url) as url
       from public.excerpts e
       join public.sources s on s.id = e.source_id
      where s.request_id = $1 and e.selected and not s.quarantined
      order by s.relevance_score desc nulls last, e.label`,
    [requestId],
  );
}

const excerptBlock = (ex: Excerpt[]) =>
  ex.map((e) => wrapSource(e.label, e.url, e.text)).join('\n\n');

/**
 * Stage 2: three angle BRIEFS, not three articles.
 *
 * Opus 5, and this is the only place it runs. Choosing the angle is the one
 * genuinely open-ended judgment in the pipeline and it determines everything
 * downstream, so paying the top rate for ~2k output tokens here is correct
 * allocation rather than indulgence.
 *
 * Writing three full articles to discard two would be 3x the drafting cost for
 * a decision the outline already settles.
 */
export async function planAngles(opts: {
  requestId: string; idea: string; audience: string; goal: string;
  keywordHint?: string | null; band: [number, number]; correlationId?: string;
}): Promise<{ costUsd: number; count: number }> {
  const started = Date.now();
  const ex = await selectedExcerpts(opts.requestId);
  if (!ex.length) {
    throw new Error('No usable excerpts. Research produced nothing to plan from.');
  }

  const res = await call<{ angles: any[] }>({
    model: MODELS.plan,
    // Opus 5 thinks adaptively and thinking tokens are drawn from the SAME
    // max_tokens budget as the answer. 8k left too little room for three
    // outlines once the model had reasoned about them.
    maxTokens: 16000,
    effort: 'high',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    system: [{ type: 'text', text: PLAN_SYSTEM(opts.band), cache: true }],
    user: [
      { type: 'text', text: `${SOURCE_RULE}\n\n${excerptBlock(ex)}`, cache: true },
      { type: 'text', text:
        `Content request\n  Idea: ${opts.idea}\n  Audience: ${opts.audience}\n` +
        `  Goal: ${opts.goal}\n  Keyword hint: ${opts.keywordHint || '(none)'}\n\n` +
        `Propose three angles.` },
    ],
  });

  // Randomised order. Position bias is documented in model judges, and it is
  // not unique to models — a fixed order nudges the human toward option A too.
  const angles = shuffle(res.value.angles ?? []).slice(0, 3);

  // Upsert on (request_id, ord), so re-planning REPLACES the three proposals
  // in place. Idempotent: running it twice leaves three angles, not six, and
  // it never destroys a row the selection screen might be pointing at.
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    await query(
      `insert into public.angles
         (request_id, ord, title, thesis, outline, primary_keyword, keyword_class,
          secondary_keywords, supporting_excerpt_ids)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (request_id, ord) do update set
         title = excluded.title,
         thesis = excluded.thesis,
         outline = excluded.outline,
         primary_keyword = excluded.primary_keyword,
         keyword_class = excluded.keyword_class,
         secondary_keywords = excluded.secondary_keywords,
         supporting_excerpt_ids = excluded.supporting_excerpt_ids,
         selected_by = null,
         selected_at = null`,
      [
        opts.requestId, i, a.title, a.thesis, JSON.stringify(a.outline ?? []),
        a.primary_keyword ?? null, a.keyword_class ?? null,
        a.secondary_keywords ?? [],
        (a.supporting_excerpts ?? [])
          .map((l: string) => ex.find((e) => e.label === l)?.id).filter(Boolean),
      ],
    );
  }

  await query(`update public.content_requests set cost_usd = cost_usd + $2 where id = $1`,
    [opts.requestId, res.costUsd]);

  // Recorded so the live progress view can say this stage finished and what it
  // cost. Without an event the screen can only infer from the status, and a
  // status that has already moved on says nothing about how long this took.
  await event({
    correlationId: opts.correlationId ?? 'unknown', requestId: opts.requestId,
    stage: 'plan.angles', outcome: 'ok', latencyMs: Date.now() - started,
    costUsd: res.costUsd, detail: { angles: angles.length, model: res.model },
  });
  return { costUsd: res.costUsd, count: angles.length };
}

/**
 * Stage 3: the article.
 *
 * Sonnet 5. Writing from selected excerpts against a fixed outline is
 * CONSTRAINED generation — the planner already did the thinking — so the
 * 2.5x price of Opus buys little here. Which of the two is actually better on
 * the nine rubric criteria is a measurement (scripts/calibrate.ts), not an
 * assertion.
 *
 * Persisted as SECTIONS, not one blob. That is what makes "regenerate one
 * section and leave the others byte-identical" a guarantee instead of a hope.
 */
export async function draftArticle(opts: {
  requestId: string; angleId: string; band: [number, number]; actorId: string;
  correlationId?: string;
}): Promise<{ costUsd: number; revision: number }> {
  const started = Date.now();
  const ex = await selectedExcerpts(opts.requestId);
  const angle = await one<any>(`select * from public.angles where id = $1`, [opts.angleId]);
  if (!angle) throw new Error('Angle not found.');

  const urls = [...new Set(ex.map((e) => e.url).filter(Boolean))];

  const res = await call<{
    title: string;
    sections: { heading: string; body: string; cites: string[] }[];
  }>({
    model: MODELS.draft,
    // Six sections at the top of an 800-word band is ~5k words of prose, and
    // JSON escaping plus adaptive thinking are charged to the same ceiling.
    // 16k was not enough: the first real run stopped at `max_tokens`. The
    // request is streamed, so a large ceiling costs nothing unless it is used.
    maxTokens: 32000,
    schema: ARTICLE_SCHEMA as unknown as Record<string, unknown>,
    system: [{ type: 'text', text: DRAFT_SYSTEM(opts.band, angle.primary_keyword ?? ''), cache: true }],
    user: [
      { type: 'text', text: `${SOURCE_RULE}\n\n${excerptBlock(ex)}`, cache: true },
      { type: 'text', text:
        `Selected angle\n  Title: ${angle.title}\n  Thesis: ${angle.thesis}\n` +
        `  Primary keyword: ${angle.primary_keyword}\n` +
        `  Secondary keywords: ${(angle.secondary_keywords ?? []).join(', ')}\n` +
        `  Outline:\n${(angle.outline ?? []).map((s: any) => `    - ${s.heading}: ${s.covers}`).join('\n')}\n\n` +
        `Links may ONLY use these URLs:\n${urls.map((u) => `  ${u}`).join('\n')}\n\n` +
        `Write the article.` },
    ],
  });

  const v = res.value;
  const body = `# ${v.title}\n\n` +
    v.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');

  const rev = await nextRevision(opts.requestId, 'article');
  await query(
    `insert into public.assets
       (request_id, kind, revision, body, sections, origin, model,
        prompt_version, tokens_in, tokens_out, cache_read_tokens, cost_usd, created_by)
     values ($1,'article',$2,$3,$4,'generate',$5,$6,$7,$8,$9,$10,$11)`,
    [opts.requestId, rev, body, JSON.stringify(v.sections),
     res.model, config.promptVersion, res.usage.input, res.usage.output,
     res.usage.cacheRead, res.costUsd, opts.actorId],
  );
  await query(`update public.content_requests set cost_usd = cost_usd + $2 where id = $1`,
    [opts.requestId, res.costUsd]);
  await event({
    correlationId: opts.correlationId ?? 'unknown', requestId: opts.requestId,
    actorId: opts.actorId, stage: 'generate.draft', outcome: 'ok',
    latencyMs: Date.now() - started, costUsd: res.costUsd,
    detail: { revision: rev, sections: v.sections.length, model: res.model },
  });
  return { costUsd: res.costUsd, revision: rev };
}

/**
 * Stage 4: three channel adaptations, in PARALLEL, each carrying only its own
 * rules and its own worked example.
 *
 * Not one call producing all three. Rule bleed is real — a prompt holding
 * three rule sets produces X posts with newsletter sign-offs — one malformed
 * response would destroy all three outputs at once, and "regenerate just the
 * LinkedIn post" is the normal case.
 *
 * The article + excerpts are a shared CACHED PREFIX across all three. On
 * Sonnet 5 a cache read is $0.20/MTok against a $2.00 base, so the 1.25x
 * write pays for itself on the first read.
 */
export async function adaptChannels(opts: {
  requestId: string; channels: ('linkedin' | 'x' | 'newsletter')[]; actorId: string;
  correlationId?: string;
}): Promise<{ costUsd: number; cacheReads: number; failures: string[] }> {
  const started = Date.now();
  const ex = await selectedExcerpts(opts.requestId);
  const article = await one<{ body: string }>(
    `select body from public.assets where request_id=$1 and kind='article'
      order by revision desc limit 1`, [opts.requestId]);
  if (!article) throw new Error('No article to adapt.');

  const shared =
    `${SOURCE_RULE}\n\n${excerptBlock(ex)}\n\n--- THE ARTICLE ---\n\n${article.body}`;

  const results = await Promise.allSettled(opts.channels.map(async (channel) => {
    const res = await call<{ body: string; subject_line?: string }>({
      model: MODELS.adapt,
      // A newsletter tops out at 600 words, but Sonnet 5 thinks adaptively and
      // that thinking is charged to the same ceiling. Headroom here is free.
      maxTokens: 8000,
      schema: CHANNEL_SCHEMA as unknown as Record<string, unknown>,
      system: [{ type: 'text', text: CHANNEL_SYSTEM[channel], cache: false }],
      // The breakpoint sits AFTER the shared block and BEFORE the channel
      // instruction, so all three calls read the same cached prefix.
      user: [
        { type: 'text', text: shared, cache: true },
        { type: 'text', text: `Now write the ${channel} version.` },
      ],
    });
    const rev = await nextRevision(opts.requestId, channel);
    await query(
      `insert into public.assets
         (request_id, kind, revision, body, subject_line, origin, model,
          prompt_version, tokens_in, tokens_out, cache_read_tokens, cost_usd, created_by)
       values ($1,$2,$3,$4,$5,'generate',$6,$7,$8,$9,$10,$11,$12)`,
      [opts.requestId, channel, rev, res.value.body, res.value.subject_line ?? null,
       res.model, config.promptVersion, res.usage.input, res.usage.output,
       res.usage.cacheRead, res.costUsd, opts.actorId],
    );
    return { channel, cost: res.costUsd, cacheRead: res.usage.cacheRead };
  }));

  // Partial failure is PARTIAL. One channel failing must not discard the others.
  let costUsd = 0, cacheReads = 0;
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { costUsd += r.value.cost; cacheReads += r.value.cacheRead; }
    else failures.push(`${opts.channels[i]}: ${r.reason?.message ?? 'failed'}`);
  });

  await query(`update public.content_requests set cost_usd = cost_usd + $2 where id = $1`,
    [opts.requestId, costUsd]);
  // `ok` even with a partial failure, and the failures are named in the
  // detail. One channel falling over is not the stage failing: the other two
  // were written and are on the screen.
  await event({
    correlationId: opts.correlationId ?? 'unknown', requestId: opts.requestId,
    actorId: opts.actorId, stage: 'generate.adapt',
    outcome: failures.length === opts.channels.length ? 'failed' : 'ok',
    latencyMs: Date.now() - started, costUsd,
    detail: { requested: opts.channels, failures },
  });
  return { costUsd, cacheReads, failures };
}

async function nextRevision(requestId: string, kind: string): Promise<number> {
  const row = await one<{ n: number }>(
    `select coalesce(max(revision),0)+1 as n from public.assets where request_id=$1 and kind=$2`,
    [requestId, kind]);
  return row?.n ?? 1;
}

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
