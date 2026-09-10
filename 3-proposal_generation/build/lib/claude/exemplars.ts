/**
 * Worked examples of the house voice.
 *
 * The house rules described the register in seven bullet points and never once
 * showed it. That is the wrong way round: a model matches a demonstrated
 * register far more reliably than a described one, and every bullet in a style
 * guide is a sentence the model has to interpret rather than imitate.
 *
 * WHY THESE ARE WRITTEN RATHER THAN COLLECTED. The obvious move is to seed
 * this with real winning proposals. Real client proposals are not public —
 * they are commercially confidential, which is the whole reason they are worth
 * having — and what *is* published under headings like "winning proposal
 * template" is vendor marketing, written to be broadly applicable, which is
 * the exact bloated register these examples exist to argue against. Pasting
 * someone's copyrighted template into a system prompt would also put
 * third-party text into every request this application makes, forever.
 *
 * So these are original, and calibrated against what the research on winning
 * consulting proposals consistently identifies:
 *
 *   - the client's own words for their own problem, reused verbatim
 *   - "you" and "your" carrying more weight than "we" and "our"
 *   - deliverables that are checkable objects, not activities
 *     ("three 60-minute sessions plus a written action plan" beats
 *      "strategic consulting support")
 *   - no jargon, and no claim the intake does not support
 *
 * And against what makes prose read as machine-written: uniform sentence
 * length, the rule of three in every paragraph, and a stock vocabulary. The
 * BAD examples below are deliberately competent — the failure mode this is
 * defending against is not incoherence, it is generic fluency. A proposal that
 * loses does not read badly. It reads like anybody.
 *
 * COST. This sits inside the cached stable prefix, after HOUSE_RULES, so it is
 * written to cache once and read at roughly a tenth of input price on every
 * request after that. Adding it is close to free per proposal, and it is the
 * highest quality-per-token change available to this build.
 */

/**
 * A synthetic intake, so the examples read as a transformation rather than as
 * free-standing prose. Nothing here refers to a real client.
 */
const EXAMPLE_INTAKE = `Client: Priya Raman, Operations Director
Company: Northgate Clinics (9 sites, ~140 staff)
What they said on the call: "Referrals come in by fax, email and phone and we lose them. Nobody can tell me how many are sitting unactioned right now."
Goals: one place to see every referral; know the backlog daily
Recommended services: process audit across 3 pilot sites, then a single intake workflow
Timeline: 10 weeks
Pricing: GBP 38,000 fixed fee`;

const INTRODUCTION_GOOD = `Referrals arrive at Northgate through several channels and get lost between them. You said on the call that nobody can tell you how many are sitting unactioned at any given moment, which is what makes staffing the backlog guesswork rather than planning.

The count comes first. We would put every referral into one place so that number exists across all nine sites, and then work out with your site leads what the backlog looks like once somebody can see it.`;

const INTRODUCTION_BAD = `Thank you for taking the time to speak with us today regarding your organisation's requirements. In today's fast-paced healthcare landscape, efficient referral management is more critical than ever.

Northgate Clinics faces significant challenges in its referral processes. Our comprehensive solution will empower your team to streamline operations, foster collaboration, and unlock new levels of efficiency. This is not simply a process fix. It is a transformation. Nine sites. One workflow. Total visibility.`;

const DELIVERABLES_GOOD = `- A written audit of how referrals move through Ashford, Beckton and Croft, with the points where they stall marked on it
- One intake workflow, built and running at those three sites
- A daily backlog count that you can look at without asking anyone for it
- A half-day handover for the site leads, and the runbook they keep afterwards`;

const DELIVERABLES_BAD = `- Comprehensive process analysis and strategic recommendations
- Implementation of a robust, scalable referral management solution
- Ongoing support and optimisation throughout the engagement
- Knowledge transfer and capability building for key stakeholders`;

/**
 * The examples, framed for the model.
 *
 * Each pair is GOOD then BAD, because the contrast teaches more than either
 * alone, and the annotation says why, so the lesson generalises past these two
 * sections rather than being copied as a template.
 */
export const VOICE_EXAMPLES = `# What the voice actually looks like

Two worked examples. Learn the register from them. Do not reuse their words, their client, or their facts.

## The intake these came from

${EXAMPLE_INTAKE}

## Introduction, written well

${INTRODUCTION_GOOD}

Why this works. It opens on the client's situation rather than on the meeting, so there is no throat-clearing and no thanks. It reuses Priya's own words, "unactioned" and "nobody can tell me", instead of translating them into process language. It carries no relative time reference, because the writer has no way to know what today is. Sentence lengths are genuinely uneven: a four-word sentence sits between a twenty-four word one and a thirty-word one, which is how someone talks. Nothing in it is arranged for rhythm.

## Introduction, written badly

${INTRODUCTION_BAD}

Why this fails, and note that it is not incompetent. It is fluent, grammatical, and says nothing. It opens by thanking the reader and referring to "today", which the writer cannot know. It replaces Priya's words with abstractions. It groups things in threes for rhythm ("streamline, foster, unlock"). It uses corrective negation, "This is not simply a process fix. It is a transformation." It ends on stacked verbless fragments, "Nine sites. One workflow. Total visibility.", which reads as a slogan rather than a sentence. Every claim it makes is unfalsifiable, so no reader believes any of them.

## Deliverables, written well

${DELIVERABLES_GOOD}

Why this works. Every bullet is an object that can be handed over and ticked off. Named sites. A named session with a named artefact that the client keeps. The third bullet answers the exact thing Priya raised on the call, in the terms she raised it.

## Deliverables, written badly

${DELIVERABLES_BAD}

Why this fails: not one of these is a thing. "Ongoing support" and "capability building" are activities, and an activity cannot be delivered, disputed, or signed off. A client reading this cannot tell what arrives, when, or how they would know it had.

## The test

Before you write a sentence, ask whether a competitor bidding for the same work could paste it into their proposal unchanged. If they could, it is describing nobody, and it should be rewritten around something this client actually said.`;
