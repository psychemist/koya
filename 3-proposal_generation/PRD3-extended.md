# Week 3 Extended PRD: AI Proposal / Document Application

**Extends:** [PRD.md](PRD.md) · **Owner:** Ikechukwu · **Version:** 1.0 · **Date:** 2026-09-09
**Status:** for review before implementation

---

## 0. Why this document exists

[PRD.md](PRD.md) states the objective and the seven test scenarios. It deliberately leaves the *how* open: "You are free to choose the frontend, backend, database, approval flow, document-generation method, and delivery tools that best fit your build."

That freedom is fine for a week's build and dangerous for a system a firm would actually run. Three questions it does not answer turn out to decide whether the thing is usable:

1. **What is this for, exactly?** "Proposal generation" covers at least four different products with different failure modes.
2. **What happens to the client's data?** A proposal contains commercial terms, contact details and pricing. Some of it is personal data under GDPR, and a third-party model provider is in the path.
3. **What stops the model inventing a price?** This is the failure that ends the project, and "we reviewed it" is not a control.

This document answers those three, specifies the application flow precisely, and restates the testing bar accordingly. It follows the structure of [PRD1](../1/PRD1.md) and [PRD2](../2/PRD2.md): context, objective, flow, testing, deliverables.

---

## 1. Business context

After a discovery call, a Koya salesperson writes the client proposal by hand — pulling from call notes, previous proposals, saved templates and whatever internal context they remember. It takes hours. The quality varies with who happens to be writing, so two clients with identical needs can receive noticeably different documents.

This is not a niche complaint. Gartner reports that **77% of sellers struggle to complete their assigned tasks efficiently**, and proposal creation is consistently named among the most time-consuming ([Inventive.ai](https://www.inventive.ai/blog-posts/proposal-automation-tools-sales-enablement)). The market response has been a category of RFP and proposal automation tooling that claims to automate up to 90% of the response workflow ([AutoRFP.ai](https://autorfp.ai/blog/best-rfp-software)).

The useful lesson from that market is what the mature tools have converged on. They do not sell "AI writes your proposal". They sell **generative drafting plus a content library plus a workflow with approval gates** — because the drafting was never the hard part. The hard part is that a proposal is a *commercial commitment*, and a document that goes to a client with the wrong number in it costs more than the time it saved.

## 2. Use cases

Four distinct jobs sit under "proposal generation". They are not the same product, and this build should be explicit about which it is.

| # | Use case | Description | In scope? |
|---|---|---|---|
| **UC-1** | **Discovery-call proposal** | Salesperson has notes from a call; needs a structured, client-ready proposal. | ✅ **Primary** |
| **UC-2** | **Inbound RFP response** | Buyer sends a formal question set; team answers from a library of approved content. | ❌ Out of scope — needs a content library and answer reuse, a different architecture |
| **UC-3** | **Renewal / upsell** | Existing client, existing terms; the proposal is largely a diff on last year's. | ⬜ Future — the section/version model already supports it |
| **UC-4** | **Statement of work** | Post-sale, contractually binding scope and deliverables. | ❌ Out of scope — needs legal review, not sales approval |

**This build targets UC-1.** That choice has consequences worth stating: the input is unstructured and incomplete (call notes always are), there is no library of pre-approved answers to fall back on, and every number in the output has to be traceable to something the salesperson supplied. UC-2 tools solve the grounding problem by only ever reusing approved text. UC-1 cannot, which is why sections 5 and 6 exist.

### Secondary use cases the design should not preclude

- **Reviewer audit.** A manager asks "why did we quote £40k?" six months later. Requires the intake, the draft history and the approval record to be retrievable together.
- **Handover.** A salesperson leaves; someone else picks up the deal. Requires the proposal to be legible without its author.
- **Compliance evidence.** A client or auditor asks whether AI-generated commercial terms were reviewed by a human. Requires an approval record naming a person and a time.

## 3. Users and roles

| Role | Can | Cannot |
|---|---|---|
| **Salesperson** (author) | Create, generate, edit, regenerate, resolve/waive gaps, submit for approval, deliver once approved | Approve anything. Touch a proposal they did not author |
| **Approver** (sales manager) | View any proposal, approve or request changes, deliver | **Approve a proposal they authored.** Edit the body of someone else's proposal |
| **Admin** | Everything | — |
| **Client** (unauthenticated) | View the approved proposal via a tokenised link; download the PDF | See anything before approval. See internal markers |

Two rules are non-negotiable and must be enforced on the server, not in the UI:

- **Separation of duties.** The author cannot approve their own proposal, even if they hold the approver role. An approval step that the author can satisfy alone is theatre. This mirrors the practice legal commentary recommends for AI-generated sales material: a named owner and a **final sign-off by someone other than the drafter** ([Influencers Time](https://www.influencers-time.com/legal-risks-of-ai-in-sales-managing-llm-hallucinations/)).
- **Ownership, not just role.** Holding the salesperson role is not a claim over every salesperson's work. Authorisation must check the *relationship between the actor and the record*, not only the actor's job title.

> An approver may view and send but **not edit**. An approver who rewrites the document is no longer an independent reviewer of it, and the separation of duties above becomes meaningless.

## 4. The application flow

### 4.1 States

```
draft ──► generating ──► review ──► pending_approval ──► approved ──► sent
                            ▲              │                  │
                            └── changes_requested ◄───┘         └──► delivery_failed
                                                                        (retryable)
```

Every transition must be conditional on both the current status **and** a version number, so a double-click or a replayed request cannot advance the same proposal twice.

### 4.2 Step by step

**1. Intake.** The salesperson submits the discovery-call fields (client, company, call date, needs summary, scope, goals, recommended services, timeline, pricing) and optionally attaches supporting material — PDF, DOCX, TXT, MD or CSV.

- The submit carries a client-generated idempotency key. A replay returns the *same* proposal, not a second one.
- Attachments are extracted to text server-side. A PDF with no text layer is a **scan**, not a document: detect it by characters-per-page and report an extraction failure rather than passing an empty string to the model. *(This is the TP-07b lesson from [PRD1](../1/PRD1.md), and it applies unchanged.)*
- Identical bytes uploaded twice dedupe to one source by content hash.

**2. Pre-flight validation — before any model call.** A deterministic validator checks the intake for missing or malformed fields and raises **gaps**. This runs first because it is free, and because a proposal missing its pricing field does not need an Opus call to discover that.

**3. Generation.** Claude drafts seven sections — Introduction, Project Scope, Recommended Approach, Deliverables, Timeline, Pricing, Next Steps — streamed to the browser so the salesperson can see the tone early and stop it if it is wrong.

- The proposal is persisted as **seven rows, not one blob.** This is what makes step 5 a guarantee instead of a hope.
- Generation is keyed on `sha256(intake + sources + prompt_version + model)`. Identical inputs are a cache hit costing zero tokens. "Regenerate anyway" is an explicit override.

**4. Gates.** Both run before the salesperson sees the draft as finished. Specified in §6.

**5. Review and revision.** The salesperson edits any section by hand, or regenerates one with an instruction ("shorter, more emphasis on the timeline").

- Regenerating one section must leave **every other section byte-identical.** Not "visually unchanged" — byte-identical, asserted by a test.
- Every version is retained with its origin (`ai_generation` / `ai_regeneration` / `human_edit` / `revert`), the instruction that produced it, and the actor. Any version can be restored.

**6. Gap resolution.** Blocking gaps must be either **resolved** (the underlying fact is supplied — the gate re-checks and clears it) or **waived** (a human decides to proceed anyway, and must give a written reason that is recorded). An unexplained waiver is indistinguishable from clicking through a warning, which is precisely what the gate exists to prevent.

**7. Submit for approval.** Refused while any section is still empty. Blocking gaps deliberately do *not* block submission — they block *approval*, because the approver is often the right person to judge whether a gap should be waived.

**8. Approval.** A second person approves or requests changes with a note. Refused if the actor is the author, if the actor lacks the role, if the status is wrong, or if any blocking gap is open.

**9. Delivery.** Only from `approved` or `delivery_failed`. In order: re-validate the intake for delivery (`client_email` becomes blocking here), re-count blocking gaps (one may have reopened since approval), assert the status permits sending, *then* issue the share link and dispatch.

- Two lanes with failover, sharing **one** idempotency key that is UNIQUE in the database — so a timeout on lane A followed by a retry on lane B cannot put two copies in the client's inbox. Timing out is not the same as not having sent.
- With no provider configured, the system records the delivery as `blocked`, does **not** claim to have sent, and hands back a `.eml`. An honest failure beats a false success.
- The status becomes `sent` **after** delivery succeeds, never before. A proposal marked sent that never left the building is worse than one marked approved that did.

**10. Client view.** A tokenised URL — no sign-in — serving the proposal as a page and a PDF, with internal markers stripped.

**11. Logging.** Every step writes an event row carrying a correlation ID, the actor, the outcome and the latency.

### 4.3 Rules that hold across the whole flow

| Rule | Why |
|---|---|
| Every request carries a correlation ID, returned in a header and shown in any error | "The button went red" must lead to the exact row explaining why |
| The audit writer degrades to stdout if the database write fails | The log that explains a database outage must survive it |
| No internal detail reaches the browser — user message, error code and developer detail are separate fields | A stack trace in a toast is both useless and a disclosure |
| Every state change is `UPDATE ... WHERE id = ? AND status = ? AND version = ?` | Two people editing at once must lose safely |

## 5. Privacy and data protection

A proposal is not neutral content. It contains named individuals, contact details, commercial terms and pricing — and a third-party model provider sits in the processing path.

### 5.1 What data the system holds

| Category | Examples | Sensitivity |
|---|---|---|
| Client personal data | Contact name, email address | **Personal data (GDPR)** |
| Commercial data | Pricing, scope, timeline, discounts | Confidential |
| Internal user data | Staff names, emails, password hashes, session records | Personal data |
| Derived | Draft history, gaps, waiver reasons, audit events, AI call records | Mixed |

### 5.2 Requirements

**R-P1 — Lawful basis and role clarity.** Koya is the **controller**. The application is the processing system. The model provider is a **sub-processor**: if a vendor in the data path can technically read, store or replay a data subject's personal data, that is what they are, and it triggers a signed DPA, valid SCCs and a documented Transfer Impact Assessment for every hop ([Truto](https://truto.one/blog/how-to-handle-eu-data-residency-and-gdpr-compliance-for-mcp-servers/)). The sub-processor list must be written down before this is used on a real client.

**R-P2 — Zero data retention with the model provider.** Confirm the provider's retention policy and training opt-out in writing. Zero-retention is an *application*, decided by the provider, not a checkbox ([Janus Compliance](https://www.januscompliance.co.uk/blog/gdpr-compliant-chatgpt-api-setup-guide-2026)). Record what was agreed and when.

**R-P3 — Data minimisation into the prompt.** Send the model what the draft needs and no more. Uploaded supporting material is capped (8 MB, 60 pages, 60,000 extracted characters) so one document dump cannot drag an entire client file into a prompt. Do not send staff email addresses, session data or audit records to the model at all.

**R-P4 — Secrets never reach the browser.** No public-prefixed environment variables. Every model call, database query and delivery dispatch happens server-side. The Participant Guide is explicit that a front-end must not expose keys or credentials.

**R-P5 — Client links are capabilities, and must behave like it.** The share token is 32 bytes of CSPRNG output, stored only as a hash, so a database dump yields no live links. Links expire (60 days), can be revoked, and record their view count. **A token must resolve to nothing until the proposal is approved** — a valid token is not by itself permission to read a document that has not cleared review.

**R-P6 — Redaction at the logging boundary.** Anything whose key matches a password/secret/token/key pattern is redacted before it is written anywhere. Assemble a log line from a request body once and a password ends up in a screenshot in a demo video.

**R-P7 — Right to erasure.** Deleting a proposal must remove its sections, versions, gaps, sources and share links. Audit events may be retained (legitimate interest, accountability) but must not themselves carry the client's personal data.

**R-P8 — Retention.** Define and enforce: sessions expire at 12 hours and are swept; share links at 60 days; rate-limit records at their window. A table nothing ever deletes from is a privacy liability that grows.

**R-P9 — Demo hygiene.** No real client data in screenshots, videos or seeded demo accounts. Fixtures are synthetic.

**R-P10 — AI Act awareness.** The EU AI Act's **2 August 2026** obligations are now live. A sales-proposal drafting tool with mandatory human review before anything leaves the building is not Annex III high-risk, but the transparency posture matters: the firm should be able to say what the AI does, what a human decides, and where the record is ([Regolo](https://regolo.ai/ai-privacy-and-compliance-in-2026-what-changes-for-llm-providers/)).

## 6. Accuracy: how we stop Claude inventing things

This is the section the project lives or dies on. An invented price in a client-facing proposal is not a bug report — it is a commercial commitment the firm may be held to. Sales material is routinely pulled into contracts by incorporation by reference, and when AI misquotes a price, **it is the business that carries the liability, not the software vendor** ([Surebright](https://www.surebright.com/blog/ai-chatbots-wont-get-sued-but-you-will-what-merchants-need-to-know-about-chatbots-business-risks), [Butcher & Barlow](https://www.butcher-barlow.co.uk/news/commercial-dispute-resolution/ai-mistakes-could-your-business-be-liable/)).

Current published rates put open-ended generation at **15–25% hallucination** versus 3–8% for extractive tasks ([Future AGI](https://futureagi.com/blog/taming-hallucination-beast-strategies-reliable-llms/)). Proposal drafting is open-ended generation. A single control is not enough; layered guardrails are reported to cut hallucination rates by **71–89%** compared with unguarded deployments ([Future AGI](https://futureagi.com/blog/taming-hallucination-beast-strategies-reliable-llms/)).

### The six layers

**A-1 — Constrain the input (prompt design).** The system prompt states the firm's voice, the template and the rule that facts come only from the intake and the attached sources. Supporting material is provided as labelled, delimited blocks. The volatile intake goes last.

**A-2 — Require abstention, not invention.** The model is instructed that where a fact is absent it must emit `[NEEDS INPUT: <what is missing>]` rather than produce a plausible value. This is the **citation-contract / abstention** pattern the literature identifies as the single highest-value one-shot intervention: every factual claim references supplied material, and the model abstains when nothing supports it ([Future AGI](https://futureagi.com/blog/taming-hallucination-beast-strategies-reliable-llms/), [arXiv 2606.00898](https://arxiv.org/pdf/2606.00898)).

> **Blank beats invented.** Where the intake genuinely does not carry a figure, a marked gap is the correct answer. A system that fills the hole with something plausible is *worse* than one that leaves it empty, because nothing downstream can tell a real number from a manufactured one. *(Carried forward verbatim from [PRD1](../1/PRD1.md) — it was true of invoices and it is more true of prices we are offering.)*

**A-3 — Deterministic grounding gate (free, runs first).** Extract every currency figure, date, percentage and proper noun from the draft with a regex, and assert each appears in the intake or a source. This catches the expensive failure mode — invented pricing — at **zero API cost**. It is span-level verification of exactly the spans that matter ([arXiv 2509.20859](https://arxiv.org/pdf/2509.20859)).

**A-4 — Model judge, on the shortlist only.** A cheap model (Haiku) checks the *semantic* claims that survive A-3 — "we have worked with three firms in your sector" — which a regex cannot evaluate. This is chain-of-verification, applied second so it only ever sees what the free pass could not settle ([arXiv 2309.11495](https://arxiv.org/pdf/2309.11495)).

**A-5 — Gaps block approval, in the database.** Every unsupported claim and every missing field becomes a row. Blocking gaps make the approve endpoint **refuse**, server-side. They clear only by supplying the fact or by a written waiver that is recorded against a named person.

**A-6 — A human approves, and it is a different human.** The last layer, and the one the legal commentary treats as decisive. Every source consulted on AI sales-material risk says the same thing: a named owner, citations to approved sources, version control, and sign-off by someone other than the drafter before anything reaches a client.

### Defence against hostile input

Uploaded supporting material is untrusted content that reaches the prompt — the exact shape of **indirect prompt injection**, which has held the #1 position in the OWASP Top 10 for LLM Applications across every edition, and where retrieved documents are the highest-risk input precisely because they bypass input-layer defences ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html), [DEV](https://dev.to/kunal_d6a8fea2309e1571ee7/prompt-injection-in-2026-still-owasps-number-one-llm-vulnerability-5f31)).

**A-7 — Treat uploads as data, never as instructions.**
- Scan extracted text for injection markers, hidden instructions, invisible Unicode and zero-width characters before it enters a prompt ([OWASP RAG](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html)).
- Wrap source text in explicit delimiters with a standing instruction that content inside is reference material and never a directive.
- **Least privilege is the real control:** the model's output is text in a section, nothing more. It cannot send an email, change a status, approve anything, or reach the database. The worst a successful injection achieves is bad prose — which A-3 through A-6 then have to let through.

### What accuracy is *not*

Not "we told it to be accurate in the prompt." Not "the salesperson will notice." Both are hope. The controls above are the ones that fail closed.

## 7. Cost and resource discipline

The Participant Guide grades this explicitly, and model choice is part of it.

| Requirement | Mechanism |
|---|---|
| Route by task, not by default | Opus for client-facing prose; Haiku for classification and gate work |
| Do not pay for what a regex can do | A-3 runs before A-4 and eliminates most candidates at zero cost |
| Do not recompute an identical result | Content-hash cache on generation; an explicit override to bypass it |
| Do not pay to re-send the frozen part of a prompt | Prompt caching, with a test asserting cache reads are non-zero so a silent invalidator cannot quietly triple the bill |
| Bound the blast radius of a loop | Per-user rate limits on both paid endpoints |
| Cheap monitoring | The health endpoint must be free by default; probing the model provider is opt-in |
| Make cost visible | Measured cost per proposal stored on the record and shown in the UI |

## 8. Failure modes and required behaviour

| Failure | Required behaviour |
|---|---|
| Model unavailable / rate-limited | Bounded retries with jittered backoff; retry only what can succeed on a second attempt; distinct error codes |
| Model returns empty or truncated output | Change nothing; report it; the existing text survives |
| PDF has no text layer | Report an extraction failure; never pass an empty string to the model |
| Upload too large / wrong type | Refuse at the boundary with the limit stated; the browser pre-screens |
| Document generation fails during send | Degrade — the email goes with the link; log the failure separately |
| Delivery provider unreachable | Fail over; if all lanes fail, record `delivery_failed` and offer the `.eml`. Never claim success |
| Database unreachable | Audit degrades to stdout; the user is told their work is not lost |
| Two people edit at once | Optimistic concurrency refuses the stale write with a message saying nothing was lost |
| The same request arrives twice | Idempotent at intake, generation and delivery |
| A gap reopens after approval | The send refuses |

## 9. Testing

The seven scenarios in [PRD.md](PRD.md) stand. This document adds the ones the extensions above make necessary.

| # | Test case | Expected result |
|---|---|---|
| 1–7 | *As per [PRD.md](PRD.md)* | *unchanged* |
| 8 | **Ownership enforcement** | A second salesperson cannot view, edit, regenerate, submit, send or download another's proposal via the API. A non-viewer gets `404`, not `403` |
| 9 | **Self-approval refused** | The author cannot approve their own proposal, even holding the approver role |
| 10 | **Pre-approval client access** | A valid, unexpired, unrevoked share token resolves to **nothing** while the proposal is unapproved |
| 11 | **Invented figure caught** | A currency amount absent from intake and sources raises a blocking gap and prevents approval |
| 12 | **Waiver requires a reason** | A waiver with no written reason is refused by the route *and* by a database constraint |
| 13 | **Prompt injection in an upload** | A document containing "ignore previous instructions…" does not change the model's behaviour; the text is treated as reference material |
| 14 | **Rate limit** | Exceeding the per-user generation ceiling returns `429` with a retry-after, and no model call is made |
| 15 | **Idempotent delivery** | A retry after a lane-A timeout does not produce a second email |
| 16 | **Cost visibility** | Measured cost is recorded per proposal and rendered |

Evidence table format as in [PRD1](../1/PRD1.md) and [PRD2](../2/PRD2.md) — expected, actual, passed, and **what you changed if it failed first**, which is the column that carries the marks.

## 10. Deliverables

As [PRD.md](PRD.md), plus:

| # | Deliverable | Note |
|---|---|---|
| 1–6 | *As per PRD.md* | Application link, sample, evidence, video, reflections, one-pager |
| 7 | **Privacy note** | Data inventory, sub-processors, retention periods, erasure behaviour (§5) |
| 8 | **Accuracy note** | The six layers, what each catches, and what gets through (§6) |
| 9 | **Workflow artefact** | The n8n delivery workflow, carried forward from Weeks 1–2 |

## 11. Out of scope

Stated so it is a decision rather than an omission: RFP response and content-library reuse (UC-2); legally binding SOWs (UC-4); e-signature; CRM write-back; multi-tenancy beyond per-author ownership; OCR for scanned documents; multi-language proposals; offline editing.

---

## Sources

**Market and use cases**
- [Inventive.ai — Sales proposal automation tools](https://www.inventive.ai/blog-posts/proposal-automation-tools-sales-enablement)
- [Inventive.ai — Best AI proposal software 2026](https://www.inventive.ai/blog-posts/top-proposal-software-tools)
- [Loopio — Best AI software for RFP responses](https://loopio.com/blog/best-ai-software-rfp-responses/)
- [AutoRFP.ai — Best RFP software](https://autorfp.ai/blog/best-rfp-software)

**Accuracy and hallucination**
- [Future AGI — Reducing LLM hallucinations: 7 strategies](https://futureagi.com/blog/taming-hallucination-beast-strategies-reliable-llms/)
- [Lakera — Guide to hallucinations in LLMs](https://www.lakera.ai/blog/guide-to-hallucinations-in-large-language-models)
- [arXiv 2309.11495 — Chain-of-Verification](https://arxiv.org/pdf/2309.11495)
- [arXiv 2606.00898 — Citation grounding](https://arxiv.org/pdf/2606.00898)
- [arXiv 2509.20859 — Sub-sentence citations for RAG](https://arxiv.org/pdf/2509.20859)

**Security**
- [OWASP — LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [OWASP — RAG Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html)
- [Prompt injection in 2026: still OWASP's number one](https://dev.to/kunal_d6a8fea2309e1571ee7/prompt-injection-in-2026-still-owasps-number-one-llm-vulnerability-5f31)

**Privacy and liability**
- [Truto — EU data residency and GDPR for sub-processors](https://truto.one/blog/how-to-handle-eu-data-residency-and-gdpr-compliance-for-mcp-servers/)
- [Janus Compliance — LLM API DPA & GDPR checklist](https://www.januscompliance.co.uk/blog/gdpr-compliant-chatgpt-api-setup-guide-2026)
- [Regolo — AI privacy and compliance in 2026](https://regolo.ai/ai-privacy-and-compliance-in-2026-what-changes-for-llm-providers/)
- [Surebright — Merchant liability for AI errors](https://www.surebright.com/blog/ai-chatbots-wont-get-sued-but-you-will-what-merchants-need-to-know-about-chatbots-business-risks)
- [Butcher & Barlow — AI mistakes: could your business be liable?](https://www.butcher-barlow.co.uk/news/commercial-dispute-resolution/ai-mistakes-could-your-business-be-liable/)
- [Influencers Time — Managing LLM hallucinations in sales](https://www.influencers-time.com/legal-risks-of-ai-in-sales-managing-llm-hallucinations/)
