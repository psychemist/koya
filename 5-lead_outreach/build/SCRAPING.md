# Scraping: what a page costs, and what it is allowed to prove

Audited 2026-09-25 against the live Firecrawl API, in the same pass that
audited Apify. `DISCOVERY.md` covers the discovery side.

## Account state

```
curl -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  https://api.firecrawl.dev/v2/team/credit-usage
```

At the time of the audit: **365 credits remaining of 1000**, billing period
ending 2026-10-16. At `RUN_SCRAPE_BUDGET=30` that is roughly twelve more full
runs before the shared allowance is gone.

## The two lanes

`firecrawlFetcher` is primary. `directFetcher` is the fallback, used only for
`FIRECRAWL_402`, `429` and `5xx`, which mean "this provider cannot serve this
page now" rather than "this page does not exist". A dead domain is dead on both
lanes, so it does not fall back.

The direct lane gets less and fails on anything needing JavaScript. Which
provider served each page is written to `scraped_pages.provider`, so a reviewer
can see that a lead was judged from the weaker source.

## What a page actually costs

| Path | Firecrawl credits | Model cost |
|---|---|---|
| First fetch | 1 | injection screen |
| Cache hit | 0 | injection screen |
| Direct fallback | 0 | injection screen |

The injection screen runs on **every** call, including cache hits, because the
quarantine is what stands between page text and the tool-holding model. So a
cache hit is free of Firecrawl cost, not free. This is why
`scrape_company_site` decrements the scrape budget on a cache hit too: the
budget is bounding the screening calls, not only the fetches. That is correct,
and the comment claiming a cached page "should cost nothing" was not.

## Fixed in this pass

### The cache had no upper age

`scrape_cache.fetched_at` was written on every insert and read by nobody, so a
page fetched months ago was served as current evidence. Qualification judges a
company on this text, and a company's website is exactly the thing that
changes. The read is now bounded by `SCRAPE_CACHE_MAX_AGE_DAYS`, default 30.

### The evidence envelope dated itself falsely

`scrape_company_site` stamped `retrieved: new Date()` into the fenced envelope
the qualification model reads, whatever the page's real age. A cached page was
therefore presented as read this second. `ScrapeResult` now carries
`retrievedAt`, which is the row's `fetched_at` on a cache hit, and the envelope
stamps that. This is the one place the build promises sourced evidence, so a
false timestamp there is worse than a stale page.

## Open, and why they are still open

### Firecrawl consumption never reaches the ledger, and credits are the unit

The account is on the **free plan: 1000 credits per month**, so there is no
dollars-per-credit rate to find and $0.00 of Firecrawl dollar spend is the
correct figure. An earlier draft of this document recommended adding
`FIRECRAWL_USD_PER_CREDIT`. That was wrong: there is no price.

What is real is the credit balance. It is finite, shared, and resets on
2026-10-16, and nothing in this build counts against it. `spend_ledger.provider`
accepts `'firecrawl'` and nothing ever writes it, so a run cannot say how many
credits it consumed and no run can see what earlier runs left behind.

The unit to track is therefore credits, not dollars: one per non-cached
Firecrawl fetch, zero for a cache hit and zero for a direct-lane fallback.

### There is no dollar cap on scraping, and no cross-run cap at all

Apify has `RUN_APIFY_CAP_USD` and a shared `DAILY_APIFY_CAP_USD`. Scraping has
only `RUN_SCRAPE_BUDGET`, a count, enforced per run. Nothing stops ten runs in
one day consuming the whole remaining credit balance. The credit balance is
readable from the API above, so a preflight check against it is the cheap fix,
and it needs no price.

### Credit exhaustion tells nobody

A `402` degrades every subsequent page to the direct lane for the rest of the
run. Apify's daily cap exhaustion sends `budget_exhausted_daily` to the
operator recipients; Firecrawl exhaustion sends nothing. The per-page
`provider` column records the degradation after the fact, but nobody is told
while it is happening, and the difference shows up as thinner evidence on every
lead from that point on.
