import { query, one } from '../db';
import { event } from '../audit';
import { call } from '../claude/client';
import { MODELS } from '../claude/models';
import { EXTRACT_SCHEMA } from '../claude/schemas';
import { EXTRACT_SYSTEM } from '../claude/prompts';
import { wrapSource, SOURCE_RULE } from '../claude/client';
import { fetchAndScreen, discover, deriveSectionBand } from '../research';
import type { SectionProfile } from '../research/types';

export type ResearchOutcome = {
  ok: number;
  failed: number;
  quarantined: number;
  band: [number, number];
  bandSource: 'measured' | 'fallback';
  comparables: number;
  costUsd: number;
};

/**
 * Stage 1: build the corpus.
 *
 * Discovery runs even when the manager supplied URLs. Two reasons, both from
 * the source documents rather than from us: the SEO doc's "analyze
 * top-performing articles" step needs COMPETING articles to pull long-tail
 * keywords from, and decision B-5 derives the per-section word band from what
 * those competitors actually do.
 */
export async function runResearch(opts: {
  requestId: string;
  correlationId: string;
  idea: string;
  audience: string;
  keywordHint?: string | null;
  urls: string[];
  /**
   * Write from the supplied material only: no search, no competitor discovery.
   *
   * It costs something real and the screen says so. Decision B-5 derives the
   * per-section word band from comparable articles, and with no discovery
   * there usually are none, so the band falls back to 700-800 and records
   * that it did. Preferring fidelity to the client's own material over a
   * measured depth target is a reasonable trade; making it silently is not.
   */
  sourcesOnly?: boolean;
}): Promise<ResearchOutcome> {
  const discovered = opts.sourcesOnly
    ? []
    : await discover(opts.idea, opts.keywordHint ?? undefined).catch(() => [] as string[]);

  // Supplied URLs first: they are what the manager actually asked us to use,
  // and the discovered ones are there to measure against and mine for keywords.
  const seen = new Set<string>();
  const urls = [...opts.urls, ...discovered]
    .filter((u) => { const k = u.replace(/[#?].*$/, ''); return seen.has(k) ? false : (seen.add(k), true); })
    .slice(0, 10);

  let ok = 0, failed = 0, quarantined = 0, costUsd = 0;
  const profiles: SectionProfile[] = [];

  /*
   * ALREADY-READ SOURCES COUNT.
   *
   * Uploads are read at upload time, so by the time this runs they are already
   * rows with excerpts attached. Counting only what THIS pass fetched meant a
   * request built entirely from three attachments reported `ok: 0`, and the
   * route treats `ok === 0` as "no corpus, refuse to draft". A request whose
   * whole point was the uploaded material was refused for having none.
   */
  const preexisting = await one<{ n: number; comparables: number }>(
    `select count(*)::int as n,
            count(*) filter (where is_comparable)::int as comparables
       from public.sources
      where request_id = $1 and fetch_status = 'ok' and not quarantined`,
    [opts.requestId]).catch(() => null);
  ok += preexisting?.n ?? 0;

  for (const url of urls) {
    const started = Date.now();
    const s = await fetchAndScreen(url);

    const row = await one<{ id: string }>(
      `insert into public.sources
         (request_id, submitted_url, final_url, provider, http_status, fetch_status,
          failure_reason, content_hash, body_markdown, body_expires_at, title,
          published_at, language, section_profile, injection_flags, quarantined)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '90 days',$10,$11,$12,$13,$14,$15)
       on conflict (request_id, content_hash) do nothing
       returning id`,
      [
        opts.requestId, s.submittedUrl, s.finalUrl ?? null, s.provider, s.httpStatus ?? null,
        s.status, s.failureReason ?? null, s.contentHash, s.markdown ?? null,
        s.title ?? null, s.publishedAt ?? null, s.language ?? null,
        JSON.stringify(s.sectionProfile), JSON.stringify(s.injectionFlags), s.quarantined,
      ],
    );

    /*
     * A SOURCE THAT COULD NOT BE READ IS NOT A FAILED RESEARCH PASS.
     *
     * This wrote `outcome: 'failed'` for every URL that did not come back,
     * and `lastFailure()` reads the newest failed event on a request. So one
     * site's robots.txt disallowing one path, out of ten URLs of which nine
     * were read perfectly well, raised the full-width red banner saying "the
     * last attempt failed at research fetch. Nothing was half-written. The
     * request was put back to a state you can act from" — over a request that
     * had not failed, had been put back nowhere, and was sitting on three
     * angles ready to choose between.
     *
     * Discovery deliberately over-fetches: it asks for ten URLs expecting to
     * lose some. A per-item outcome and a pipeline outcome are different
     * claims, and only the second belongs on that banner. Every one of these
     * is already rendered, individually and with its reason, in the Sources
     * list, which is where a partial loss should be read.
     *
     * `skipped` for the expected losses, `failed` only for a URL that broke in
     * a way nobody chose.
     */
    const expected = s.status === 'robots_denied' || s.status === 'paywalled'
      || s.status === 'boilerplate' || s.status === 'too_large';
    await event({
      correlationId: opts.correlationId, requestId: opts.requestId,
      stage: 'research.fetch',
      outcome: s.status === 'ok' ? 'ok' : expected ? 'skipped' : 'failed',
      latencyMs: Date.now() - started,
      detail: { url, provider: s.provider, status: s.status, reason: s.failureReason },
    });

    if (s.status !== 'ok') { failed++; continue; }
    if (s.quarantined) {
      quarantined++;
      await event({
        correlationId: opts.correlationId, requestId: opts.requestId,
        stage: 'research.quarantine', outcome: 'blocked',
        detail: { url, findings: s.injectionFlags },
      });
      continue; // excluded from the excerpt pool entirely
    }
    if (!row) continue; // deduped by content hash

    ok++;
    const scored = await scoreAndExtract(row.id, s.markdown ?? '', opts);
    costUsd += scored.costUsd;
    if (scored.isComparable) profiles.push(s.sectionProfile);
  }

  // Decision B-5. Below three comparables we have an anecdote, not a
  // measurement — so it falls back, and records that it did.
  const derived = deriveSectionBand(profiles);
  await query(
    `update public.content_requests
        set section_target_min=$2, section_target_max=$3, section_target_source=$4,
            cost_usd = cost_usd + $5, updated_at = now()
      where id=$1`,
    [opts.requestId, derived.band[0], derived.band[1], derived.source, costUsd],
  );

  return {
    ok, failed, quarantined,
    band: derived.band, bandSource: derived.source, comparables: derived.n, costUsd,
  };
}

export async function scoreAndExtract(
  sourceId: string, markdown: string,
  opts: { requestId: string; correlationId: string; idea: string; audience: string },
): Promise<{ costUsd: number; isComparable: boolean }> {
  // Haiku, and never anything more expensive: this runs once per source, and
  // an expensive model in a per-source loop is how the bill gets away from you.
  const body = markdown.slice(0, 40_000);

  try {
    const res = await call<{
      relevance: number; authority: number; is_comparable: boolean;
      excerpts: { text: string; char_start: number; char_end: number; reason: string }[];
    }>({
      model: MODELS.extract,
      maxTokens: 6000,
      schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
      system: [{ type: 'text', text: EXTRACT_SYSTEM(opts.idea, opts.audience), cache: true }],
      user: [{ type: 'text', text: `${SOURCE_RULE}\n\n${wrapSource(sourceId.slice(0, 8), '', body)}` }],
    });

    const v = res.value;
    await query(
      `update public.sources set relevance_score=$2, authority_score=$3, is_comparable=$4 where id=$1`,
      [sourceId, v.relevance, v.authority, v.is_comparable],
    );

    // Offsets come from a model and are advisory: we re-locate the excerpt in
    // the real text so a wrong offset cannot silently corrupt a citation span.
    let n = 0;
    for (const ex of v.excerpts.slice(0, 12)) {
      const found = body.indexOf(ex.text);
      const start = found >= 0 ? found : ex.char_start;
      await query(
        `insert into public.excerpts (source_id, label, text, char_start, char_end, selected, selection_reason)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [sourceId, `S${sourceId.slice(0, 4)}P${++n}`, ex.text, start, start + ex.text.length,
         v.relevance >= 3, ex.reason],
      );
    }
    return { costUsd: res.costUsd, isComparable: v.is_comparable };
  } catch (e) {
    await event({
      correlationId: opts.correlationId, requestId: opts.requestId,
      stage: 'research.extract', outcome: 'failed',
      detail: { sourceId, error: e instanceof Error ? e.message : String(e) },
    });
    return { costUsd: 0, isComparable: false };
  }
}
