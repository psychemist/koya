---
name: outbound-copywriting
description: Write a review-ready 3-step cold email sequence and a short LinkedIn message for a qualified lead, grounded in that lead's stored source context.
---

Write for a human reviewer who will edit and then send. Nothing here is sent by the system.

## Required output per qualified lead
Three emails (`step` 1, 2, 3) each with `subject`, `body`, `personalization_note`, and
the `source_url` the specific detail came from. Plus one LinkedIn message (`step` 0),
body only, under 300 characters.

## House style, enforced in code
- **No em dash. No double hyphen as a substitute.** Use a full stop, a comma, a colon
  or brackets. This is a blocking gate; a draft containing one is rejected.
- Subject 60 characters or fewer. Body 120 words or fewer.
- Write like a person, not a promotion. Calm and credible.

## Grounding, enforced in code
Every email body must contain at least one substantive phrase that also appears in that
lead's stored `source_summary` or excerpt. This is checked by n-gram overlap before the
draft is stored. **Do not invent details about the company.** If you cannot ground it,
you do not have enough research to write it: say so instead of writing it.

## Banned openers, enforced in code
"Loved what you are building" · "Your company looks impressive" · "I saw your website" ·
"I hope this email finds you well" · "I noticed you recently"

The first three are vague. The last two are the 2026 patterns buyers skip on sight.

## Also blocked
Fake urgency ("act now", "limited spots", "last chance"). Any personal email address.
Any calendar auto-book link. Any claim that something has already been sent or scheduled.

## Sequence shape
**Email 1** Open on a specific observation from the source context, connect it to AI
automation support, ask one low-pressure question.
**Email 2** A different angle: a workflow bottleneck, scaling challenge or operational
pattern the research actually showed.
**Email 3** Short. Offer an exit: invite a reply if the timing or fit is wrong.

## Good vs weak personalization
Good references evidence: website positioning, product or service category, audience
served, a hiring or scaling signal, a public workflow clue.
Weak is vague praise. The gate cannot always tell the difference. You can.

## Before you call `save_outreach`
Does each email name a real company-specific detail? Can each claim be traced to the
source context? Is the ask clear? Would a human want to review this before sending?
