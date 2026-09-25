# Budgets: what each provider costs, what caps it, and what does not

Written after the first full end-to-end run, 2026-09-25, which failed on the
agent spend cap and exposed the same bug in three places.

## The three providers

| Provider | Unit | Per-run cap | Daily cap | Recorded in the ledger |
|---|---|---|---|---|
| Claude (agent loop) | dollars | `AGENT_MAX_BUDGET_USD` = $1.50 | **none** | yes, since this pass |
| Claude (injection screen) | dollars | none, bounded by `RUN_SCRAPE_BUDGET` | none | yes |
| Apify | dollars | `RUN_APIFY_CAP_USD` = $0.30 | `DAILY_APIFY_CAP_USD` = $1.50 | yes |
| Firecrawl | credits | `RUN_SCRAPE_BUDGET` = 30 pages | none | **no** |

Two gaps are visible in that table. Claude is the most expensive provider and
is the only one with no cross-run ceiling, so ten runs in a day is $15 with
nothing to stop it. Firecrawl consumption is not recorded at all, and on the
free plan credits are the only unit that means anything.

## Why the agent loop reaches $1.50

`AGENT_MAX_BUDGET_USD` is **per run**, not per day. The run of 2026-09-25 hit
it with 83 tool calls: 21 discoveries, 34 lead saves, 11 scrapes, 16 drafts.

The API is stateless, so every turn resends the whole conversation. Cost grows
with the square of the turn count, not linearly: turn 80 pays for everything
turns 1 to 79 produced. At Claude Sonnet 5 rates ($2.00 per 1M input, $10.00
per 1M output) a transcript averaging ~50K tokens across ~85 turns is roughly
4.2M input tokens. Uncached that is about $8.50, so the cached prefix is doing
most of the work at the ~$0.20 per 1M read rate, landing near $0.85, plus
perhaps $0.50 of output across 83 tool-call payloads. That reaches $1.50.

That is an estimate, not a measurement, and the reason it is an estimate is
itself the bug below: the run recorded no token breakdown. The next run will,
and `runs.model_usage` carries `cache_read_input_tokens`, which is the figure
that says whether the cached prefix is actually working.

## The bug, in three places

Cost was recorded only on the success path.

- **Apify:** `usageTotalUsd` reads low at finish time on a pay-per-event actor,
  so a run that cost $0.009 settled at $0.001. Fixed with a priced floor, and
  verified exact against Apify's own post-aggregation figures.
- **Claude:** the SDK reports a cap two ways. `runAgent` handled the result
  message and not the throw, so `Reached maximum budget ($1.5)` escaped the
  message loop and skipped every line after it. The run booked $0.073 against
  a real $1.50, wrote no `model_usage`, and was marked `failed` rather than
  `partial` despite holding 8 qualified leads and 16 drafts.
- **Firecrawl:** never recorded at all, on any path.

The first two are fixed. The third needs a credits column, since dollars are
the wrong unit on a free plan.

### What the Claude fix does

`lib/agent/caps.ts` recognises a cap from either the result subtype or the
thrown message, and prices a budget-capped run at the cap. `runAgent` now
holds the exception, records cost and usage, reclassifies a cap as `partial`
with a shortfall reason, and rethrows only a genuine failure. A run stopped
because it hit $1.50 spent at least $1.50, which is the same reasoning as the
Apify settlement floor.

## If $1.50 per run is the wrong number

It is the binding constraint. The run of 2026-09-25 exhausted it at 8 of 10
leads while still holding 19 unused scrapes and $0.12 of unused Apify budget,
so raising it is the single change that most affects whether a run reaches its
target. Before raising it, the cheaper lever is the turn count: 21 discovery
calls for 40 candidates is the largest avoidable contributor, because every one
of them also lengthens the transcript that all later turns pay to resend.
