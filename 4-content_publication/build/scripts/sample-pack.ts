/**
 * Writes the content sample pack for one request, straight out of the
 * database. Read-only: it selects and prints, and changes nothing.
 *
 * Hand-assembling this deliverable would defeat its purpose. The pack is
 * meant to show what the system actually produced and what it actually
 * rejected, so it is generated from the same rows the review screen reads:
 * the stored assets at their final revisions, every source with its real
 * outcome, the claim-to-excerpt map, the judge's per-criterion scores, and
 * the findings that blocked approval along the way.
 *
 * Usage: npm run --silent sample -- <requestId> > ../content-sample-pack.md
 *
 * --silent matters: without it npm prints its own two-line banner to stdout
 * and it lands at the top of the deliverable.
 */
import { query, one, pool } from '../lib/db';

const requestId = process.argv[2];
if (!requestId) {
  console.error('Usage: npm run sample -- <requestId>');
  process.exit(1);
}

const out: string[] = [];
const say = (s = '') => out.push(s);

const r = await one<any>(`select * from public.content_requests where id=$1`, [requestId]);
if (!r) {
  console.error(`No request ${requestId}`);
  process.exit(1);
}

const requester = await one<any>(
  `select name, email, role from public.users where id=$1`, [r.requester_id]);

const sources = await query<any>(
  `select submitted_url, final_url, title, provider, fetch_status, failure_reason,
          quarantined, is_comparable,
          (select count(*)::int from public.excerpts e
            where e.source_id = s.id and e.selected) as selected_excerpts
     from public.sources s where request_id=$1
    order by (fetch_status='ok' and not quarantined) desc, submitted_url`, [requestId]);

const angles = await query<any>(
  `select ord, title, thesis, primary_keyword, keyword_class, selected_at
     from public.angles where request_id=$1 order by ord`, [requestId]);

const assets = await query<any>(
  `select distinct on (kind) kind, revision, body, subject_line, image_slot, origin, id
     from public.assets where request_id=$1 order by kind, revision desc`, [requestId]);

const history = await query<any>(
  `select kind, revision, origin, length(body) as len
     from public.assets where request_id=$1 order by kind, revision`, [requestId]);

const flagRows = await query<any>(
  `select code, severity, status, message, asset_kind
     from public.flags where request_id=$1 order by status, severity, code`, [requestId]);

const events = await query<any>(
  `select stage, outcome, detail, created_at from public.events
    where request_id=$1 and stage like 'evaluate%' order by created_at`, [requestId]);

const KIND: Record<string, string> = {
  article: 'Article', linkedin: 'LinkedIn post', x: 'X post', newsletter: 'Email newsletter',
};
const FETCH: Record<string, string> = {
  ok: 'Read', robots_denied: 'Not allowed by robots.txt', paywalled: 'Paywalled',
  boilerplate: 'Too thin to use', too_large: 'Too large', failed: 'Failed',
};
const words = (s: string) => String(s).split(/\s+/).filter(Boolean).length;

/* ------------------------------------------------------------------ input */

say('# Content sample pack');
say();
say('Generated from the database by `npm run sample`, not written by hand. Every figure below');
say('is a stored row: the assets are at their final revisions, the sources carry the outcome');
say('they actually got, and the findings are the ones that actually blocked approval.');
say();
say('---');
say();
say('## What went in');
say();
say('| Field | Value |');
say('| --- | --- |');
say(`| Idea | ${r.idea} |`);
say(`| Audience | ${r.audience} |`);
say(`| Goal | ${String(r.goal).replace(/_/g, ' ')} |`);
say(`| Channels | ${(r.channels ?? []).join(', ')} |`);
say(`| Keyword hint | ${r.keyword_hint ?? 'none given'} |`);
say(`| Raised by | ${requester?.name} (${requester?.role}) |`);
say(`| Sources discovered | ${sources.length} |`);
say(`| Post to X automatically | ${r.publish_to_x ? 'yes' : 'no, the $0.20 per post was not opted into'} |`);
say();
say(`**Total cost of this pack: $${Number(r.cost_usd ?? 0).toFixed(4)}.** Final state: \`${r.status}\`.`);
say();
if (r.section_target_min) {
  say(`**Section depth band: ${r.section_target_min} to ${r.section_target_max} words**, ` +
      (r.section_target_source === 'measured'
        ? 'measured from the competing articles that were scraped.'
        : 'the fallback band, because fewer than three comparable articles were found.'));
  say();
}

/* ---------------------------------------------------------------- sources */

say('---');
say();
say('## The source list');
say();
say('Every outcome is shown, because "we chose not to use it" has to be distinguishable from');
say('"we could not fetch it". A thin article with no explanation is how a reviewer approves');
say('something built on two sources believing it was built on seven.');
say();
say('| Source | Outcome | Excerpts used | Notes |');
say('| --- | --- | --- | --- |');
for (const s of sources) {
  const url = s.final_url ?? s.submitted_url;
  const outcome = s.quarantined ? 'Quarantined' : FETCH[s.fetch_status] ?? s.fetch_status;
  const notes = [
    s.failure_reason,
    s.is_comparable ? 'counted as a comparable article for the depth band' : null,
  ].filter(Boolean).join('; ');
  say(`| ${s.title ? `${s.title}<br>` : ''}\`${url}\` | ${outcome} | ${s.selected_excerpts} | ${notes || '-'} |`);
}
say();
const usable = sources.filter((s) => s.fetch_status === 'ok' && !s.quarantined).length;
const totalExcerpts = sources.reduce((n, s) => n + Number(s.selected_excerpts ?? 0), 0);
say(`**${usable} of ${sources.length} sources were usable, contributing ${totalExcerpts} selected excerpts.**`);
say();

/* ----------------------------------------------------------------- angles */

say('---');
say();
say('## The three angles, and the one chosen');
say();
say('Three outlines, not three articles. They are shown to the person in randomised order,');
say('because a fixed order nudges a reader towards the first option just as it does a model.');
say();
for (const a of angles) {
  say(`### ${a.title}${a.selected_at ? ' (chosen)' : ''}`);
  say();
  say(a.thesis);
  say();
  say(`Targets \`${a.primary_keyword}\`` +
      (a.keyword_class ? `, classed as a **${a.keyword_class}** long-tail keyword.` : '.'));
  if (a.keyword_class === 'supporting') {
    say();
    say('This one cannot be written. A supporting long-tail keyword belongs inside a broader');
    say('article rather than carrying one, and building a full piece on it is thin content.');
  }
  say();
}

/* ----------------------------------------------------------------- output */

say('---');
say();
say('## What came out');
say();
for (const kind of ['article', 'linkedin', 'x', 'newsletter']) {
  const a = assets.find((x) => x.kind === kind);
  if (!a) continue;
  say(`### ${KIND[kind] ?? kind}`);
  say();
  const facts = [`revision ${a.revision}`, String(a.origin).replace(/_/g, ' ')];
  if (kind === 'x') facts.push(`${[...String(a.body)].length} characters`);
  if (kind === 'newsletter' || kind === 'article') facts.push(`${words(a.body)} words`);
  say(`*${facts.join(', ')}*`);
  say();
  if (a.subject_line) {
    say(`**Subject line:** ${a.subject_line}`);
    say();
  }
  say('```text');
  say(String(a.body).trimEnd());
  say('```');
  say();
  if (kind === 'article' && a.image_slot) {
    const slot = a.image_slot;
    const filled = [slot.placement, slot.alt, slot.brief].some((v) => String(v ?? '').trim());
    say(filled
      ? `**Image slot.** ${slot.placement}. Alt text: "${slot.alt}". Brief: ${slot.brief}`
      : '**Image slot: declared but empty.** The model returned a slot whose fields were all ' +
        'empty strings, which satisfies the JSON schema while carrying nothing. Tier 0 blocks it.');
    say();
  }
}

/* ----------------------------------------------------------- traceability */

say('---');
say();
say('## Claims traced to sources');
say();
say('This is the table that makes the pack auditable. "Where did this number come from?" is one');
say('query, six months later.');
say();
for (const a of assets) {
  const claims = await query<any>(
    `select c.text, c.status, e.label, c.checker
       from public.claims c
       left join public.excerpts e on e.id = c.excerpt_id
      where c.asset_id=$1 order by c.status, c.text`, [a.id]);
  if (!claims.length) continue;

  const supported = claims.filter((c) => c.status === 'supported');
  const unsupported = claims.filter((c) => c.status === 'unsupported');
  say(`**${KIND[a.kind] ?? a.kind}:** ${supported.length} supported, ` +
      `${unsupported.length} with no source found.`);
  say();
  if (supported.length) {
    say('| Claim | Traced to |');
    say('| --- | --- |');
    for (const c of supported.slice(0, 20)) say(`| ${c.text} | \`${c.label ?? 'an excerpt'}\` |`);
    say();
  }
  if (unsupported.length) {
    say('Marked in the draft where they appear, and blocking unless advisory:');
    say();
    for (const c of unsupported.slice(0, 12)) say(`- ${c.text}`);
    say();
  }
}

/* ---------------------------------------------------------------- the work */

say('---');
say();
say('## What the checks did');
say();
say('The drafts that did not survive are the part that shows the system working.');
say();
say('| Pass | Tier 0 findings | Blocking | Judge mean |');
say('| --- | --- | --- | --- |');
let pass = 0;
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (e.stage !== 'evaluate.tier0') continue;
  pass++;
  const judged = events.find((j, k) => k > i && j.stage === 'evaluate.tier1');
  say(`| ${pass} | ${e.detail?.flags ?? '?'} | ${e.detail?.blocking ?? '?'} | ` +
      `${judged?.detail?.mean ?? (judged?.outcome === 'failed' ? 'the judge failed' : '-')} |`);
}
say();

say('### Revision history');
say();
say('Every revision is kept. "We tried this and it was worse" is exactly what a review history');
say('is for.');
say();
say('| Asset | Revision | Origin | Length |');
say('| --- | --- | --- | --- |');
for (const h of history) {
  say(`| ${KIND[h.kind] ?? h.kind} | ${h.revision} | ${String(h.origin).replace(/_/g, ' ')} | ${h.len} chars |`);
}
say();

const open = flagRows.filter((f) => f.status === 'open');
const resolved = flagRows.filter((f) => f.status === 'resolved');
say(`### Findings: ${open.length} still open, ${resolved.length} resolved by revision`);
say();
if (open.length) {
  say('| Severity | Asset | Finding |');
  say('| --- | --- | --- |');
  for (const f of open) {
    say(`| ${f.severity} | ${f.asset_kind ?? 'request'} | ${String(f.message).split('. ')[0]}. |`);
  }
  say();
}
say('Resolved findings are kept rather than deleted, so the record shows what was wrong and');
say('when it stopped being wrong.');
say();

console.log(out.join('\n'));
await pool().end();
