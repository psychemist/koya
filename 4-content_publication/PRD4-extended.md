# Week 4 Extended PRD: AI Content Research and Publishing Agent

**Extends:** [PRD.md](PRD.md) · **Owner:** Ikechukwu · **Version:** 1.0 · **Date:** 2026-09-15
**Status:** for review before implementation
**Companions:** [design-notes.md](design-notes.md) (decision log and trade-offs) · [IMPLEMENTATION.md](IMPLEMENTATION.md) (build order)

---

## 0. Why this document exists

[PRD.md](PRD.md) states the objective and eight test scenarios, then deliberately leaves the *how* open: "You may use n8n, custom code, Claude API, Claude through n8n, a backend application, a simple front-end, search or scraping tools, a retrieval system, a database, a publishing queue, or any other tools that fit your implementation."

That freedom is fine for a week's build and dangerous for a system an agency would actually run. Four questions the brief does not answer decide whether the thing is usable:

1. **What is the system optimising for?** "More content, faster" is the obvious reading and the wrong one — the 2026 evidence is that volume without editorial control destroys trust and search position.
2. **What makes a claim trustworthy?** "The model was told to stay grounded" is not a control. Marketing copy that invents a statistic is a published, indexed, screenshotted mistake.
3. **What does "a human approves" actually mean?** A click is not review, and under EU AI Act Article 50 a *cursory* approval does not even discharge the labelling obligation it appears to discharge.
4. **What happens when the publish step half-works?** A timeout is not a failure to post, and the cost of getting that wrong is a duplicate post on a client's channel.

This document answers those four, specifies the flow precisely, and restates the testing bar accordingly. It follows the structure of [PRD1](../1/PRD.md), [PRD2](../2/PRD.md) and [PRD3-extended](../3/PRD3-extended.md): context, objective, flow, testing, deliverables.

The reasoning behind each choice — the options rejected and why — lives in [design-notes.md](design-notes.md). This document states what will be built.

---

## 1. Business context

A Koya Talent marketing agency content team runs one pipeline by hand: brainstorm, research, write an SEO article, adapt it for LinkedIn, X and the newsletter, review internally, schedule. It works, and it does not scale without losing tone, accuracy or both.

The numbers put the bottleneck in a specific place. Time per long-form post is now close to **four hours** ([Orbit Media](https://www.orbitmedia.com/blog/blogging-statistics/)), but the drag is not the writing: content teams report spending **40% of their time in review cycles**, and **60% name manual process** as their biggest 2026 bottleneck ([Timecraft](https://www.timecraftadvisory.com/blog/the-marketing-agency-content-production-bottleneck), [Team of 8](https://blog.teamof8.ai/overcoming-the-content-production-bottleneck-4-trends-agencies-must-leverage-in-2026)).

So the leverage is not in generating faster. It is in making review *cheap and reliable* — which, conveniently, is also the thing that stops the system producing content that damages the client.

That second half is not hypothetical:

- **"AI slop" mentions rose ninefold in a year to 2.4 million, 82% negative** ([Rewarx](https://www.rewarx.com/blogs/trust-slop-backlash-ecommerce-2026)).
- **39% of consumers trust a brand less** when its marketing leans heavily on AI — up from 20% in 2025 ([Nurdd](https://www.nurdd.club/blogs/made-by-humans-authentic-content-ai-slop)).
- Google penalises **scaled content abuse** — mass generation without editorial review — not AI authorship as such ([Json House](https://www.jsonhouse.com/posts/google-ai-content-penalties-2026/)).
- CNET corrected a run of machine-written finance articles; Sports Illustrated published under AI-generated fake bylines and lost its CEO and its publishing licence within weeks ([Fortune](https://fortune.com/2023/11/28/sports-illustrated-ai-written-articles-reporters-who-dont-exist)).

**Objective.** Take a content manager from a raw idea or a source URL to a reviewed, grounded, channel-ready content pack — article, LinkedIn post, X post, newsletter, and a source list — where every factual claim is traceable to stored source text, and nothing reaches a channel without a named human approving it with the evidence in front of them.

**Success is measured by:** time from request to approved pack; proportion of packs approved with zero blocking flags waived; measured Claude + retrieval cost per pack; and the count of assets published without approval — which must be zero, and is *enforced* rather than monitored.

---

## 2. Scope

| # | Use case | In scope? |
|---|---|---|
| **UC-1** | Raw idea → researched article + channel pack | ✅ **Primary** (brief test 1) |
| **UC-2** | Source URL(s) → grounded article + channel pack | ✅ **Primary** (brief test 2) |
| **UC-3** | Repurpose an article we already published into the three channels | ✅ **Secondary** — same adapter, near-zero extra cost |
| **UC-4** | Newsjacking / same-day reactive commentary | ❌ Out — cannot honestly promise the review turnaround |
| **UC-5** | First-person ghostwriting under a named executive's byline | ❌ Out — this is the Sports Illustrated failure mode |

**Out of scope, as decisions rather than omissions:** image generation (Article 50's labelling duty covers images, and ~90% of consumers want to know); autonomous publishing with no human; vector retrieval over the request's own sources (§4.2); LinkedIn *company page* publishing (blocked by LinkedIn — §7); multi-language; short-form video; analytics write-back; a CMS.

---

## 3. Users, roles and the two non-negotiable rules

| Role | Can | Cannot |
|---|---|---|
| **Content manager** (requester) | Submit a request, add sources, select the angle, edit drafts, request revision, submit for approval | Approve their own request for external publication. Publish directly |
| **Editor** (approver) | All of the above, plus per-asset approve / request changes / reject, and release to the queue | Edit after approving without voiding the approval |
| **Admin** | Everything, plus connector credentials and workspace settings | — |

**R-1 — Separation of duties, defaulted on.** The requester is not the approver for anything that leaves the building. The justification is Article 50: "editorial responsibility" means a person other than the drafter signed it off. A per-workspace solo-operator override exists and is **stamped on every approval it enables**, so the audit shows a decision rather than an accident.

**R-2 — Any edit after approval voids the approval.** Without this, "a human approved it" is defeated by approving a clean draft and editing it before the queue fires. Enforced server-side on the row, not in the UI.

---

## 4. The system

### 4.1 States

```
draft ─► researching ─► sources_ready ─► planning ─► angles_ready
                │                                        │
                └─► research_failed (retryable)          │ (human selects an angle)
                                                         ▼
                                  ┌──────────────► drafting ─► evaluating ─┐
                                  │                    ▲                   │
                                  │                    └── revising ◄──────┤ (max 2, monotonic)
                                  │                                        ▼
                    changes_requested ◄──────────── needs_review ─────► needs_human
                                  ▲                    │                (loop exhausted)
                                  └────────────────────┤
                                                       ├─► rejected
                                                       └─► approved ─► scheduled ─► published
                                                                           │
                                                                           └─► publish_failed
                                                                               (retryable)
```

Every transition is `UPDATE … WHERE id = ? AND status = ? AND version = ?`, so a double-click or a replayed request cannot advance the same content twice.

### 4.2 Step by step

**1. Intake.** The manager submits: the **idea** (free text), the **target audience**, the **goal** (awareness / demand / thought leadership), the **channels** wanted, optional **source URLs**, optional primary-keyword hint, tone, and a deadline or scheduled slot.

- The submit carries a client-generated **idempotency key**. A replay returns the *same* request, not a second one.
- **Cannibalisation check runs here, before anything costs money.** The idea is embedded and matched against the published-content index (§4.3). A near-duplicate above threshold surfaces *"we published this 6 weeks ago — update it instead?"* with the link. This is the automation deciding **not to run**, which is the cheapest cost control in the system.

**2. Research.** For each supplied URL, and for discovered candidates when the request is idea-only:

- `POST https://api.firecrawl.dev/v2/scrape` with `onlyMainContent: true`, `formats: ["markdown","links"]`, `maxAge` set so a page fetched in the last 48 h is served from Firecrawl's index rather than re-fetched, `parsers: ["pdf"]` for PDF sources, and `redactPII` enabled.
- Discovery uses `/v2/search`, then scrapes only the shortlist.
- Per source we store: submitted URL, `metadata.url` (the **final** URL after redirects), `metadata.statusCode`, fetch time, content hash, language, robots status, and the markdown body.
- **Fallback chain, in cost order:** Firecrawl → Claude `web_fetch_20260209` (no charge beyond tokens) → manual paste. Each source records **which provider served it**.
- A robots-disallowed or paywalled URL is **refused with a stated reason**, visible in the UI. Other sources continue.
- Identical bytes dedupe to one source by content hash.
- **Boilerplate detection.** `onlyMainContent` removes most nav and footer, but a page that still returns mostly chrome is marked unusable by content-to-chrome ratio rather than passed on as a "source". *(This is the Week 1 TP-07b lesson — a PDF with no text layer is not a document — in a new costume.)*

**3. Injection screening — before any source text enters a prompt.** Extracted text is scanned for injection markers, hidden instructions, zero-width and invisible Unicode. A flagged source is **quarantined**: excluded from the excerpt pool, and shown to the reviewer as excluded and why. §6.

**4. Source selection and excerpt extraction (Haiku 4.5).** Each surviving source is scored for relevance, recency, authority and substance. Selected sources yield **labelled excerpts with character offsets** (`S3¶7`). The writer never sees a whole page — it sees excerpts.

> This is not only a cost decision. Anthropic's own guidance is that **"more context isn't automatically better. As token count grows, accuracy and recall degrade"** — *context rot* — and that curating context matters as much as having room for it ([Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)). The 1M-token window means everything *fits*; that is not a reason to send it.

**5. Planning — three angle briefs (Opus 5).** Each brief carries a title, thesis, H2-level outline, primary keyword, secondary keywords, intended reader, and the **excerpt IDs it rests on**. Briefs are presented in **randomised order** so neither the human nor any downstream ranker is nudged toward the first option.

Three *outlines*, not three articles: the outline determines the article, and writing two to throw away is 3× cost for a decision already made.

**6. Human decision point 1 — angle selection.** The manager picks one, or rejects all and re-briefs. Nothing is written until this happens.

**7. Article generation (Sonnet 5).** One article against the selected outline and [`seo-best-practices.md`](seo-best-practices.md) — 700–800 words per main section, Grade 7 readability, and one required image slot with alt text — built **only** from selected excerpts, with a citation contract: every factual claim carries the excerpt ID it rests on, and where no excerpt supports a needed fact the model emits `[NEEDS SOURCE: …]` rather than inventing one.

> **Blank beats invented.** A marked gap is the correct output when the sources do not carry the fact. A system that fills the hole with something plausible is *worse* than one that leaves it empty, because nothing downstream can tell a real figure from a manufactured one. *(Carried verbatim from [PRD1](../1/PRD.md) and [PRD3-extended](../3/PRD3-extended.md).)*

The article is persisted as **sections, not one blob**, so step 10 can be a guarantee rather than a hope.

**8. Channel adaptation — three parallel calls (Sonnet 5).** LinkedIn, X and newsletter, each carrying **only its own rules and its own worked example** from [`formatting_checklist.md`](formatting_checklist.md). Separate calls because rule bleed is real (one prompt holding three rule sets produces X posts with newsletter sign-offs), because one malformed response must not destroy all three, and because "regenerate just the LinkedIn post" is the normal case.

The article + excerpts + brand voice form a **cached prefix** shared by all three, with the `cache_control` breakpoint after them and the channel rules last.

**9. Evaluation — three tiers, cheapest first.** §5.

**10. Revision — bounded, targeted, monotonic.** §5.4.

**11. Human decision point 2 — publication approval.** Per-asset. Refused while any blocking flag is open. The approval screen and what it must show: §6.

**12. Scheduling and publishing.** §7.

**13. Logging.** Every step writes an `events` row with a correlation ID, actor, stage, outcome, latency and **measured cost**.

### 4.3 The published-content index

A pgvector table over the agency's **own** published articles. It exists for exactly two jobs:

1. **Internal link suggestions.** [seo-best-practices.md](assets/seo-best-practices.md) requires 2–3 internal or external links. Without an index of what the site carries, every "internal link" a model produces is invented — a hallucinated URL, caught by the deterministic gate, and therefore a link the article does not get.
2. **The cannibalisation check** at intake (step 1).

Per the [Supabase vector guide](https://supabase.com/docs/guides/ai/vector-columns): `create extension vector`, a sized `vector(N)` column, cosine distance `<=>`, the query wrapped in a Postgres function, HNSW index, and — the detail that is easy to get wrong — **order by the distance operator itself, not by the computed similarity expression**, or the index is not used.

**There is deliberately no vector index over the request's own sources.** Five to eight documents fit in context; chunk-and-retrieve would discard the structure the planner needs and add a recall failure mode for no gain. Curation is done by model-driven excerpt selection (step 4), not by embedding material fetched ten seconds earlier.

### 4.4 Rules that hold across the whole flow

| Rule | Why |
|---|---|
| Every request carries a correlation ID, returned in a header and shown in any error | "It went red" must lead to the exact row explaining why |
| The audit writer degrades to stdout if the database write fails | The log that explains a database outage must survive it |
| No internal detail reaches the browser — user message, error code and developer detail are separate fields | A stack trace in a toast is useless and a disclosure |
| Every state change is version-checked | Two people acting at once must lose safely |
| The model has **no tools** | Its output is text. It cannot publish, schedule, approve, or reach the database |

---

## 5. Accuracy: how we stop the system publishing something false

Marketing copy is published, indexed and screenshotted. An invented statistic is not a bug report; it is a correction notice. Current published rates put open-ended generation at **15–25% hallucination** versus 3–8% for extractive tasks ([Future AGI](https://futureagi.com/blog/taming-hallucination-beast-strategies-reliable-llms/)), and layered guardrails are reported to cut hallucination rates by **71–89%** versus unguarded deployments. A single control is not enough.

### 5.0 The rules we are actually testing against

The brief ships summarised assets that cite Google Docs. Those Docs need a sign-in, so they were exported by hand to [`seo-best-practices.md`](seo-best-practices.md) and [`formatting_checklist.md`](formatting_checklist.md). **The exported originals are the authority; `assets/*.md` are lossy summaries of them.** The summarisation removed every numeric target, and those targets are exactly what a deterministic gate can enforce:

| Rule | Summary says | Original says | Effect on this build |
|---|---|---|---|
| Section depth | "reflect the strength and complexity of the source material" | **700–800 words per main section (informed by top articles)** | Checkable — and the parenthetical is load-bearing. **Signed decision B-5: derive the target from the competing articles we scrape** (`median` words per H2 across comparables, tolerance band), falling back to 700–800 with fewer than 3 comparables. A ~4-section article lands near 3,000 words, so **drafting output cost rises ~80%** (§8) |
| Readability | "readable for a broad audience" | **Grade 7** | Flesch–Kincaid is a function of the text, so the rubric's **Clarity** criterion moves from Tier 1 (paid) to Tier 0 (free) |
| Image | "if the content needs one" | **Include 1 contextually relevant image** | Mandatory. We do not generate images (§2), so the article emits a **required image slot** — placement, alt text, sourcing brief — and Completeness fails without it |
| Competitor analysis | present, softened | explicit long-tail / short-tail extraction from top articles | Discovery search runs **even for URL-only requests**, because keyword extraction needs competing articles |
| LinkedIn | "keep paragraphs short", "a small number of emojis" | **max 2–3 lines**, **3–5 emojis max** | Both checkable. Note the Doc's own example uses *one* emoji — enforce the ceiling, let the exemplar set the norm |
| Worked examples | none | **one per channel** | These become the **few-shot exemplars** in each channel-adaptation prompt. Tone calibration that rule-writing cannot achieve |

**The SEO Doc's own embedded links add two requirements and expose one discrepancy:**

- **[Ahrefs](https://ahrefs.com/blog/long-tail-vs-short-tail-keywords/)** — long-tail is a position on the search demand curve, not a word count. Target **topical** long-tails (worth their own article), not **supporting** long-tails (belong inside a broader piece). The keyword step therefore **classifies**, and feeds that classification to the cannibalisation check.
- **[Yoast](https://yoast.com/internal-linking-for-seo-why-and-how/)** — a page with no *inbound* internal links is **orphaned** and invisible to crawlers. Internal linking is **bidirectional**: the index supplies outbound links *and* nominates existing cornerstone pages that should link back. A weak-similarity link is worse than none, so the match threshold is a correctness parameter.
- **[Klipfolio](https://www.klipfolio.com/resources/kpi-examples/digital-marketing/external-links)** — defines external links as *inbound backlinks* (a KPI with "no universal benchmark"), not outbound citations. The Doc's "2–3 internal or external links" can only mean outbound links to authoritative sources; that is what is built, and the mis-citation is recorded.

Two consequences worth stating before they surprise someone:

- **Grade 7 and 700–800-word sections are in tension.** Long sections invite subordinate clauses; Grade 7 forbids them. The drafting prompt states both and Tier 0 checks both, or the model quietly trades one for the other.
- **Neither document caps X at 280 characters.** That is our constraint, and it is labelled as ours in the code so a future reader does not hunt for it in the brief.

### 5.1 The API forces the architecture

`output_config.format` constrains **shape, not values**. The [structured outputs guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) is explicit about what a schema may not contain:

> Not supported: recursive schemas · **numerical constraints (`minimum`, `maximum`)** · **string constraints (`minLength`, `maxLength`)** · `additionalProperties` other than `false` · external `$ref` URLs.

So a schema **cannot** express "the X post is ≤280 characters" or "this score is 1–5". It will happily return a 312-character X post and a score of 9. Two consequences:

- every length, count and range rule in [channel-formatting-rules.md](assets/channel-formatting-rules.md) and [seo-best-practices.md](assets/seo-best-practices.md) is checked **in code**;
- rubric scores are declared `enum: [1,2,3,4,5]`, which *is* supported.

Compiled grammars are cached for 24 h and invalidated when the schema changes, so **evaluation schemas are versioned and frozen**, not edited per request.

### 5.2 Tier 0 — deterministic gates, zero tokens, run first

| Rubric criterion | Check |
|---|---|
| **SEO Fit** | exactly one H1; H2s present; primary keyword in the title and within the first 100 words; **each main section within the derived depth band** (median words-per-H2 across scraped comparables; 700–800 fallback); paragraphs 2–3 sentences; 2–3 links; keyword density within a band — **over-optimisation fails too** |
| **Clarity** | **Flesch–Kincaid grade level ≤ 7** (§5.0). A pure function of the text — there is no reason to pay a model to estimate it |
| **Channel Fit** | X ≤280 chars *(our constraint)* and ≤2 hashtags; LinkedIn CTA present, paragraphs ≤3 lines, **≤5 emojis**; newsletter 250–600 words with a subject line |
| **Completeness** | every requested asset present and non-empty, **including the required image slot with alt text** |
| **Source Grounding** (mechanical half) | every numeral, percentage, currency figure, date, proper noun and quoted string in the draft must appear in a **selected excerpt** |
| **Factual Consistency** (links) | every URL in the draft was in the source set **and** resolves on a HEAD request. Invented URLs are a classic hallucination and a free catch |
| **Verbatim overlap** *(added)* | longest common substring against each source; more than *N* consecutive words lifted is flagged. Grounded must not become copied — that is a copyright exposure, not a quality nit |

### 5.3 Tier 1 — model judge (Haiku 4.5), only on what Tier 0 cannot decide

Topic relevance, audience fit, tone, and the semantic half of grounding and factual consistency. *Clarity is not here* — §5.0 turned it into a Flesch–Kincaid computation.

**Self-evaluation with the same model is measurably unreliable.** Judges favour their own generations, with a demonstrated correlation between self-recognition and self-preference ([arXiv 2410.21819](https://arxiv.org/pdf/2410.21819), [arXiv 2604.22891](https://arxiv.org/html/2604.22891v4)); they also carry verbosity and position bias ([Openlayer](https://www.openlayer.com/blog/llm-as-judge-evaluation-guide)). Mitigations, all required:

- **A different model from the writer.** Haiku judges Sonnet.
- The rubric supplied verbatim; structured output with `additionalProperties: false`; per criterion a verdict, an **evidence span**, and a **required action** — not a bare number.
- Every "supported" verdict must cite an excerpt ID.
- The judge is **not told which revision it is** and never sees its own prior scores, so it cannot anchor on itself.

**The judge is itself evaluated.** A held-out calibration set of drafts with planted defects — an unsupported statistic, a 312-character X post, an off-tone LinkedIn post, a lifted paragraph — asserts detection above a threshold before the judge is trusted. Latency-insensitive, so it runs through the **Batch API at 50%** (Haiku 4.5 batch: $0.50 / $2.50 per MTok). *An evaluator nobody evaluated is decoration.*

### 5.4 The revision loop and its stopping rule

Evaluator-optimizer ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)), fenced on four sides:

- **Two passes, hard cap.** Then `needs_human` — never silently accepted at a failing score.
- **Only failing sections are rewritten.** Passing sections stay **byte-identical**, asserted by a test.
- **Monotonicity guard.** If pass *N+1* scores lower than pass *N*, keep *N* and stop.
- **Deterministic failures get targeted instructions.** "The X post is 312 characters; cut to ≤280 without losing the hook" — not "improve it".

**Full history is preserved** (brief test 4): every revision stores origin (`generate` / `auto_revise` / `human_edit` / `revert`), the evaluation that triggered it, the diff, the actor, and its measured cost. Any version can be restored.

### 5.5 Defence against hostile source material

Scraped pages are untrusted content that reaches a prompt and ends up **published to the open internet** — indirect prompt injection, OWASP's #1 LLM risk in every edition, with retrieved documents the highest-risk vector ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)).

- Scan for injection markers, hidden instructions and invisible Unicode **before** the text enters a prompt.
- Wrap source text in explicit delimiters with a standing instruction that content inside is reference material, never a directive.
- **Quarantine flagged sources** from the excerpt pool, and tell the reviewer. Grounding alone does not close this: an injected claim *does* have a supporting excerpt, because the injected page is a source.
- **Least privilege is the real control.** The writer has no tools. The worst a successful injection achieves is bad prose — which Tier 0, Tier 1 and a human then have to let through.

### 5.6 What accuracy is *not*

Not "we told it to stay grounded in the prompt." Not "the manager will notice." Both are hope. The controls above fail closed.

---

## 6. The human gate, and what "approved" has to mean

Under **EU AI Act Article 50** — in force since **2 August 2026**, with fines up to **€15 million or 3% of worldwide turnover** — deployers must label AI-generated text published to inform the public on matters of public interest. The exception is the design specification:

> The obligation does not apply where the content "has undergone a process of human review or editorial control and a natural or legal person holds editorial responsibility for the publication, provided such checks are **substantive and not limited to superficial matters or cursory approval**." ([Orrick](https://www.orrick.com/en/Insights/2026/08/EU-AI-Act-Transparency-Obligations-for-AI-Generated-Content-Article-50), [artificialintelligenceact.eu](https://artificialintelligenceact.eu/transparency-rules-article-50/))

A one-click **Approve** is therefore not merely weak governance — it cannot be *shown* to be substantive, so it does not discharge the obligation it appears to discharge.

**Requirement A-1 — the approval screen shows the evidence.** On one view: the draft with unsupported claims highlighted **in place**; the claim→excerpt map; the evaluator's per-criterion scores with evidence spans; the revision diff; any quarantined sources and why; and the exact text that will go to each channel.

**Requirement A-2 — the approval record captures what was shown.** Actor, timestamp, decision, per-asset scope, note, and a **hash of the evidence bundle rendered**. That hash is what turns "someone clicked approve" into "a named person reviewed this material", and it is what makes the six-month-later audit answerable.

**Requirement A-3 — per-asset approval.** "The article is fine, the X post is off" must be expressible without discarding the article.

**Requirement A-4 — blocking flags refuse approval, server-side.** They clear only by fixing the underlying problem or by a **written waiver recorded against a named person**. An unexplained waiver is indistinguishable from clicking through a warning, which is what the gate exists to prevent.

**Requirement A-5 — approval is void on edit** (R-2), and re-checked at release: the queue re-verifies status, open flags and approval validity immediately before dispatch. A flag that reopened after approval blocks the send.

---

## 7. Publishing and scheduling

### 7.1 Two findings that shape the design

- **X:** since **6 February 2026** there is no free tier and no new Basic/Pro. Pay-per-use is **$0.015 per post, $0.20 if the post contains a link** ([Postproxy](https://postproxy.dev/blog/x-api-pricing-2026/)). Our posts contain links — so **one X post costs roughly half of what producing the entire content pack costs** (§8). X publication is therefore an explicit per-request choice, not a default-on checkbox.
- **LinkedIn:** posting to a **member profile** is self-serve via `w_member_social`. **Company pages** and posting on behalf of others require partner approval, and **SNAP is not accepting new partners — no form, no waitlist, no timeline** ([Phyllo](https://www.getphyllo.com/post/linkedin-api-access-in-2026-partner-program-approval-timeline-alternatives)). An agency publishing for clients needs exactly the thing that is closed.

### 7.2 Therefore: the queue is the product

Approved assets become `publish_queue` rows — channel, payload, `due_at`, state, attempt count, idempotency key. Connectors sit behind one interface:

| Channel | Shipped behaviour |
|---|---|
| **Newsletter** | Real send via Resend |
| **LinkedIn** | Real post to a member profile via `w_member_social`; company-page publishing documented as **blocked by LinkedIn, not by us** |
| **X** | Real post via pay-per-use when credentials are present; otherwise `queued_manual` with copy-ready text and the scheduled slot, in a clearly-labelled state |

### 7.3 Rules

| Rule | Mechanism |
|---|---|
| **Never fake a success** | A channel with no credentials records `blocked`, never `sent`. An honest failure beats a false success |
| **Idempotency is a constraint, not an intention** | `UNIQUE (content_id, channel, scheduled_slot)`. A retry after a provider timeout cannot double-post — *timing out is not the same as not having posted* |
| **Partial failure is partial** | X blocked must not stop the newsletter |
| **Status follows reality** | `published` is written **after** the provider confirms, never before |
| **One claim wins** | The worker claims due rows with `SELECT … FOR UPDATE SKIP LOCKED`, so two concurrent ticks cannot both take the same row |
| **Late is a decision** | A slot already passed either fires once with a late marker or holds for the next slot — configured, not accidental |

### 7.4 n8n's role — and what it is not

An n8n **Schedule Trigger** fires `/api/queue/tick`, satisfying the programme's standing workflow artefact.

But n8n prunes its own execution history by default: `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=336` hours (14 days), `EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000`, applied together — a record is deleted if it exceeds *either* — and `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS` is **off by default** ([Manage execution data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data)).

So: **the n8n execution list is a debugging convenience with a two-week memory; the Postgres `events` table is the audit log.** Two operational consequences: annotated executions are never pruned, so the demo run is tagged; and the HTTP Request node's **"Never Error"** option is deliberately *not* used on the publish path, because a node reporting success on a 500 is precisely the silent failure the Participant Guide grades against.

---

## 7A. Notifications

Three sinks, two audiences, one rule: **a notification failure must never fail the work it is reporting on.**

### 7A.1 Email — Resend, to the people who must act

| Trigger | To | Why it is worth an email |
|---|---|---|
| `angles_ready` | requester | **Action required** — nothing is written until an angle is picked |
| `needs_review` | requester | Draft + channel pack are evaluated and ready to read |
| `needs_human` | requester | The revision loop exhausted; open flags listed |
| submitted for approval | **editor** | **Action required** — this is the gate |
| `approved` / `changes_requested` / `rejected` | requester | The decision, with the note |
| `published` | requester + editor | With per-channel outcome, including anything `blocked` |
| `research_failed` / `publish_failed` | requester + editor | Failure is visible to a person, not only to a log |

### 7A.2 Discord — two webhooks, deliberately separated

- **#content-success** — request created, research complete, angles ready, article drafted, approved, published. The channel a team watches.
- **#content-errors** — research failures, provider `402`/`429`, model truncation, malformed judge output, blocked publishes, queue failures. The channel an operator watches.

They are **separate webhooks** because mixing them is how an error stops being noticed. A success feed is skimmed; an error feed is read.

### 7A.3 Rules

| Rule | Mechanism |
|---|---|
| A notification never breaks the flow | Every send is wrapped; a failure writes an `events` row and is swallowed |
| No duplicate notifications on retry | `notifications` table, `UNIQUE (request_id, kind, channel)` — the same idempotency discipline as publishing |
| Discord rate limits respected | 5 req/s, 30/min per webhook; sends are queued and coalesced |
| No secrets, no PII in a payload | Same redaction boundary as the audit log. Links point at the app; they do not embed content |
| Silence is not success | If a notification could not be sent, the UI says so on the request |

## 7B. Image generation

Decision **B-6 is overridden by the requester**: the article's required image slot gets a **Generate** button.

The concern is recorded once, in [decisions-to-sign-off.md](decisions-to-sign-off.md): Article 50's labelling duty covers images even though it exempts text, and the editorial-review exception that protects our copy does not obviously extend to a synthetic image. It is implemented anyway, with the controls that make it defensible:

- **on demand only** — a button, never automatic, so no pack silently acquires a synthetic image;
- **provenance stored** — provider, model, prompt, timestamp, actor — on the asset row;
- **visible `AI-generated` marker** in the UI and carried in the published payload;
- **alt text and sourcing brief still required**, generated or not, because Completeness checks the slot not the origin;
- **pluggable `ImageProvider`** — no key configured means an honest "not configured" state, not a broken button.

## 8. Cost and resource discipline

Rates as published ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

| Stage | Model | Base in / out | Cache read | Rationale |
|---|---|---|---|---|
| Source scoring + excerpt extraction | **Haiku 4.5** `claude-haiku-4-5` | $1 / $5 | $0.10 | Extractive work, once per source — the 3–8% hallucination end of the scale. Never run an expensive model in a per-source loop |
| Angle briefs | **Opus 5** `claude-opus-5` | $5 / $25 | $0.50 | The one open-ended judgment. Runs once, ~2k output. Adaptive thinking, `effort: "high"` |
| Article drafting | **Sonnet 5** `claude-sonnet-5` | $2 / $10 | $0.20 | Constrained generation against a fixed outline from supplied excerpts — the planner already did the thinking |
| Channel adaptation ×3 | **Sonnet 5** | $2 / $10 | $0.20 | Article as cached prefix at 1/10th the input rate |
| Evaluation judge | **Haiku 4.5** | $1 / $5 | $0.10 | Cheap — and, the real reason, a **different model from the writer** |

**The model answer, honestly stated.** Opus 5 for drafting is the alternative and the one most people would pick. Drafting routes to Sonnet 5 and Opus is held for planning because the calibration set decides it: if Sonnet scores within noise of Opus across the nine rubric criteria at 2.5× less cost, Sonnet is correct; if it does not, the routing changes. The claim is *"we measured it"*, not *"Sonnet is good enough"*.

### Modelled cost per content pack

| Line | Cost |
|---|---|
| Score + extract (6 sources, Haiku) | $0.054 |
| Angle briefs (Opus 5) | $0.120 |
| Article draft (Sonnet 5, ~3,000 words) | $0.077 |
| 3 channel adaptations (Sonnet 5, cached prefix) | $0.070 |
| Evaluation, 2 passes (Haiku) | $0.059 |
| One targeted revision (Sonnet 5) | $0.055 |
| Firecrawl (~10 credits) | $0.010 |
| **Produce the pack** | **≈ $0.45** |
| Publish one X post containing a link | **+$0.20** |
| **All-in** | **≈ $0.65** |

Measured cost per stage is stored on the record and shown in the UI — an estimate in a design document is not cost awareness.

### Discipline rules

| Requirement | Mechanism |
|---|---|
| Don't pay for what code can do | Tier 0 before Tier 1 — and the API cannot enforce those rules in a schema anyway (§5.1) |
| Don't fetch the same page twice | Firecrawl `maxAge` (48 h index hit) plus our own content-hash cache |
| Don't recompute an identical result | Generation keyed on `sha256(inputs + prompt_version + model)`; "regenerate anyway" is an explicit override |
| Don't resend a frozen prefix | `cache_control` across the three channel calls — $0.20 vs $2.00 per MTok on Sonnet 5 — with a test asserting `cache_read_input_tokens > 0` |
| Don't write the article five times | Three outlines, one article |
| Bound the loop | Two revision passes, hard cap, then escalate |
| Use the batch discount where latency is irrelevant | Judge calibration and index embedding backfill via the Batch API (50%) |
| Know when not to run | Cannibalisation check at intake turns "write" into "update" |
| Cheap monitoring | `/api/health` free by default; provider probes opt-in |

### API details that shape the code

- Haiku 4.5 uses `thinking: {type: "enabled", budget_tokens: N}`; Opus 5 and Sonnet 5 use `{type: "adaptive"}` and **reject `budget_tokens` with a 400**. Opus 5 thinks by default; Sonnet 5 must be told to.
- The 1M window is the **default at standard pricing, no beta header**.
- Since Claude 4.5, input + `max_tokens` over the window is **accepted**, and generation stops with `stop_reason: "model_context_window_exceeded"` rather than erroring up front — a silent-truncation trap. Code branches on `stop_reason` before trusting any draft.
- `output_config.format`, not the deprecated `output_format`.

---

## 9. Failure modes and required behaviour

| Failure | Required behaviour |
|---|---|
| Search returns nothing usable | Say so; offer manual source entry; never draft from an empty corpus |
| Firecrawl 402 (credits) / 429 (rate limit) | Distinct error codes; fall back to Claude `web_fetch`; record which provider served each source |
| Paywalled / 403 / JS-only / robots-disallowed URL | Per-source status with a reason, visible in the UI; other sources continue |
| Scrape returns boilerplate only | Content-to-chrome ratio marks the source unusable rather than passing an empty shell to the model |
| Source is a 90-page PDF | `parsers: ["pdf"]` costs **1 credit per page** — cap pages at intake, or the cheap step becomes the expensive one |
| Model output truncated or empty | Change nothing; report it; the existing draft survives. Never treat a truncated draft as a draft |
| Judge returns malformed JSON | Structured output plus one retry, then fail loudly — an unparseable evaluation is never a pass |
| Revision makes it worse | Monotonicity guard keeps the better pass |
| Revision loop exhausts | `needs_human`, with the open flags listed — never silent acceptance |
| Publish provider 5xx / timeout | Bounded retries with jittered backoff; the UNIQUE key makes a retry safe |
| Scheduled slot already passed | Fire once with a late marker or hold — configured |
| Two workers tick at once | `FOR UPDATE SKIP LOCKED` |
| Two reviewers approve at once | Optimistic concurrency; the loser is told nothing was lost |
| Draft edited after approval | Approval voids; re-approval required before release |
| Duplicate submission | Idempotency key returns the same request |
| Database unreachable | Audit degrades to stdout; the user is told their work is not lost |

---

## 10. Testing

The eight scenarios in [PRD.md](PRD.md) stand. This document adds the ones the extensions above make necessary.

| # | Test case | Expected result |
|---|---|---|
| 1–8 | *As per [PRD.md](PRD.md)* | *unchanged* |
| 9 | **Unsupported statistic blocks approval** | A planted figure absent from every selected excerpt raises a blocking flag; the approve endpoint refuses server-side |
| 10 | **Invented URL caught** | A link not present in the source set is flagged and does not survive to the published asset |
| 11 | **Verbatim lift caught** | A draft reproducing more than *N* consecutive words from a source is flagged |
| 12 | **Prompt injection neutralised** | A scraped page containing "ignore previous instructions…" does not change model behaviour; the source is quarantined and the reviewer is told |
| 13 | **Edit after approval voids it** | Editing an approved asset returns it to `needs_review`; the queue refuses to release it |
| 14 | **Idempotent intake** | The same idempotency key returns the same request, not a second one |
| 15 | **No double publish** | A retry after a provider timeout does not produce a second post |
| 16 | **Concurrent tick safety** | Two workers ticking simultaneously dispatch each due row exactly once |
| 17 | **Loop terminates and escalates** | After two revision passes below threshold, status is `needs_human` — never auto-approved |
| 18 | **Monotonic revision** | A revision scoring lower than its parent is discarded and the parent retained |
| 19 | **Partial channel failure isolated** | X blocked for missing credentials records `blocked`; the newsletter still sends |
| 20 | **Judge calibration** | The planted-defect set is detected above the agreed threshold before the judge is trusted |
| 21 | **Prompt cache is live** | `cache_read_input_tokens > 0` across the three channel calls |
| 22 | **Cannibalisation check fires** | A near-duplicate idea surfaces the existing article and offers "update" before any paid call is made |
| 23 | **Robots-disallowed source refused visibly** | The URL is refused with a stated reason rather than silently skipped |
| 24 | **Truncation is not a draft** | A response with `stop_reason: "max_tokens"` or `"model_context_window_exceeded"` is reported, not persisted as content |
| 25 | **Readability gate** | A draft above Grade 7 Flesch–Kincaid raises a flag and triggers a targeted revision — at zero token cost to detect |
| 26 | **Section depth gate** | A main section outside the derived band is flagged. With ≥3 comparables the band comes from measured competitor depth; with fewer it falls back to 700–800 — and the evidence bundle records **which** applied |
| 27 | **Image slot required** | An article with no image slot and alt text fails Completeness and cannot be approved |
| 28 | **Supporting long-tail rejected as an article target** | An angle whose primary keyword classifies as a *supporting* long-tail is flagged at planning, not after drafting |
| 29 | **Orphan check** | An approved article with no nominated inbound internal link raises an advisory flag naming the cornerstone page that should link to it |
| 30 | **Weak internal link refused** | A candidate internal link below the similarity threshold is not suggested — a random internal link is worse than none |

Evidence table format as in [PRD1](../1/PRD.md), [PRD2](../2/PRD.md) and [PRD3](../3/PRD3-extended.md) — expected, actual, passed, and **what you changed if it failed first**, which is the column that carries the marks.

---

## 11. Deliverables

As [PRD.md](PRD.md), plus:

| # | Deliverable | File |
|---|---|---|
| 1 | Application link | Recorded in the one-pager; must load from another machine at grading time |
| 2 | Content sample pack | `sample-pack.md` — input, article, LinkedIn, X, newsletter, **source list with excerpt-level citations**, evaluation scores, revision history, cost |
| 3 | Testing evidence | `test-evidence.md` — the 30 rows above |
| 4 | Demo video (5:00) | `demo-script.md` — full script |
| 5 | Reflections | `reflections.md` |
| 6 | One-page documentation | `one-pager.txt` |
| 7 | **Design notes** | [design-notes.md](design-notes.md) — decisions and trade-offs |
| 8 | **Implementation guide** | [IMPLEMENTATION.md](IMPLEMENTATION.md) |
| 9 | **Accuracy note** | `accuracy-note.md` — the layered gates, what each catches, what gets through |
| 10 | **Workflow artefact** | `n8n/koya-content-queue.json` — the scheduler tick |
| 11 | **Exported rule sources** | [`seo-best-practices.md`](seo-best-practices.md), [`formatting_checklist.md`](formatting_checklist.md) — the Google Docs the assets summarise, exported so the gates can be audited against the real rules |

---

## 12. Open questions for the business

Stated because a PRD that pretends to have no open questions is a PRD nobody read.

1. **Whose LinkedIn?** Member-profile posting works today; company pages do not. Does the agency accept publishing from a named employee account, or does X and LinkedIn become export-only until partner access changes?
2. **Is X worth $0.20 a post?** At roughly half the cost of producing the whole pack, that is a business decision, not an engineering one.
3. **What is the brand voice corpus?** The channel adapter is only as good as the approved exemplars it is given. Ten good past posts per channel would materially raise output quality at zero marginal cost.
4. **Disclosure policy.** Article 50's exception depends on substantive human review, which we enforce. Separately: does the agency *want* to disclose AI assistance anyway? 84% of consumers want labelling and only 20% of organisations do it ([Klaviyo](https://www.klaviyo.com/solutions/ai/consumer-trust-in-ai)) — that gap is a positioning opportunity, not just a risk.

---

## Sources

The full source list — primary API documentation, market evidence, evaluation research, publishing APIs and legal analysis — is maintained in [design-notes.md § Sources](design-notes.md#sources). Every link in [PRD.md §Resources](PRD.md) was read for this document and all twelve resolve; the Google Doc URLs cited *inside* the local assets require a sign-in, so they were exported by hand to [`seo-best-practices.md`](seo-best-practices.md) and [`formatting_checklist.md`](formatting_checklist.md). **Those exports are the authority for every SEO and channel rule in this build** — `assets/*.md` are summaries, and §5.0 records what the summarising dropped.
