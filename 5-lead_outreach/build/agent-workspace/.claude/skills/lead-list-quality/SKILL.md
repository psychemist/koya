---
name: lead-list-quality
description: Check the final lead list against the quality scorecard before finishing a run, and decide whether to search again or return fewer leads with an explanation.
---

Run this before calling `finish_run`.

## Required checks
- The list contains the target number of **`qualified`** companies.
- Each has a company name and a domain.
- Each has qualification reasoning.
- Each has source context.
- Each has outreach drafts.
- No personal email finding or email validation was attempted.
- Duplicate companies removed.
- Companies marked `needs_review` are **not** counted as qualified leads.

## Scorecard
| Dimension | Check |
|---|---|
| ICP fit | Matches every hard filter in the refined ICP |
| Evidence quality | The decision uses real source context, not inference |
| Duplicate rate | No domain appears twice |
| Outreach relevance | Each sequence uses company-specific context |
| Data completeness | Required fields present |
| Safety compliance | No emails found, validated or sent |

## If you are short of the target
Check `get_run_state` first. If candidate and scrape budget remain, run **one** more
narrower search within budget. If budget is gone, call `finish_run` with fewer leads and
a clear `shortfall_reason` naming which budget ran out and how many candidates you
assessed. **Never pad the list to hit the number.** A padded list is the failure this
whole system exists to prevent.

`finish_run` recomputes this scorecard in code. If your account disagrees with the
recount, the run will not be marked complete, so report honestly.
