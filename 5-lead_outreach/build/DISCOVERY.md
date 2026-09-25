# Discovery: the pinned actor, its cost, and what it is allowed to return

Everything here was verified against the live Apify API and live smoke runs on
2026-09-24, not against listing pages. Where a number appears, the command that
produces it appears next to it.

## The pinned actor

`harvestapi/linkedin-company-search`, set in `APIFY_ACTOR_ID`.

### It is not a rental actor

A rental actor reports `pricingModel: FLAT_PRICE_PER_MONTH` and bills a flat
monthly fee on enable, whether or not it is ever run. This one reports
`PAY_PER_EVENT` and defines only per-event charges.

```
curl -H "Authorization: Bearer $APIFY_TOKEN" \
  https://api.apify.com/v2/acts/harvestapi~linkedin-company-search \
  | jq '.data.pricingInfos[-1].pricingModel'
```

### What it charges

From `.data.pricingInfos[-1].pricingPerEvent.actorChargeEvents`:

| Charge event | FREE / BRONZE / SILVER | GOLD and above |
|---|---|---|
| `apify-actor-start` | $0.001 per run | $0.0005 |
| `short-company` | $0.002 per result | $0.001 |
| `full-company` | $0.004 per result | $0.003 |

This account (`AA_Training_Program_Pod1`) is plan `STARTER`, tier `BRONZE`, so
the left column applies. Check with:

```
curl -H "Authorization: Bearer $APIFY_TOKEN" \
  https://api.apify.com/v2/users/me | jq '.data.plan | {id, tier}'
```

`APIFY_ACTOR_PRICE_PER_RESULT_USD` must be the **full-company** row, because
`buildActorCall` pins `scraperMode: 'full'`. Short mode returns no `website`,
so every row it produces is dropped as an aggregator and the run pays for
nothing. Setting the short-company price under-reserves by half.

### Why not `harvestapi/linkedin-company`

It is a details scraper: you feed it company URLs and it returns their details.
It has no `searchQuery`, no `locations`, no `companySize` and no `industryIds`,
so it cannot discover anything. Its per-item price at Bronze is $0.004, the
same as `full-company` here, so running it as a second enrichment pass would
pay twice for data the search actor already returns.

## Reported usage reads low, so the ledger takes a floor

`usageTotalUsd` on a finished run is not the bill. A pay-per-event actor's
charges are aggregated after the run ends. Observed:

| Run | Returned | Reported | Actually owed |
|---|---|---|---|
| `zrgzexa8ismfUbVRC` | 2 full rows | `$0` | $0.009 |
| `43wJK24Qbk638SVm6` | 2 full rows | `$0.001` | $0.009 |

Settling at the reported figure records a run as very nearly free. The ledger
is what `RUN_APIFY_CAP_USD` and the shared `DAILY_APIFY_CAP_USD` are measured
against, so believing it leaves both caps enforcing nothing.

`settlementUsd(reported, items)` therefore treats the reported figure as a
floor to rise to, never a ceiling to fall to. Over-recording trips a cap early.
Under-recording lets a run exceed a cap it believed it was under, on an account
shared across the cohort.

A full 40-candidate run prices at $0.161 against the $0.30 run cap. The smoke
script prints this projection on every run.

## The query is keywords. Everything else is a filter.

LinkedIn reads `searchQuery` as free text. A query naming a country, a
headcount and an industry returns companies matching none of them. The first
smoke run asked for `"US B2B SaaS companies 10-100 employees"` and its top
result was a one-person consultancy in Business Consulting and Services.

| ICP field | Actor input | Notes |
|---|---|---|
| `geography` | `locations` | LinkedIn place names. "UK" resolves to Ukraine; use "United Kingdom". |
| `headcount_range` | `companySize` | LinkedIn's eight fixed buckets. |
| `industries` | `industryIds` | Numeric LinkedIn ids, resolved from names. |

`searchQuery` is clamped to 300 characters, its schema maximum. The agent
writes that string and nothing else bounded it, and an input the schema rejects
is a run that fails after the start fee is already owed.

### Industry ids are the filter that matters

Three smoke runs asking for "B2B SaaS" returned a fractional CS consultancy, a
sales training consultancy, an SEO agency and a video production service. All
were tagged `Business Consulting and Services` (id 11). The words "B2B SaaS"
match a consultancy that sells **to** B2B SaaS exactly as well as they match a
B2B SaaS company. Only `industryIds` separates them. With `industryIds: ["4"]`
the same query returned `saasmaker.com`.

`lib/linkedin-industries.ts` is the generated taxonomy, 434 entries, from the
table the actor's own input schema links to. `lib/industries.ts` holds the
matching policy:

- an exact label match wins, case and punctuation insensitive;
- otherwise a curated alias, because LinkedIn has no "SaaS", no "fintech" and
  no "AI" but every ICP uses them;
- otherwise **nothing**. An id LinkedIn does not expect returns no results
  rather than erroring, so a guess is a silent empty run that still pays to
  start.

An unresolved name is returned to the agent as `icp_industries_not_filtered`,
because sending only the matched ids narrows the search to those industries and
the model has to know which part of its ICP is not being enforced.

### Headcount buckets are wider than the ICP

"10 to 100" spans three LinkedIn buckets, so discovery asks for `1-10`,
`11-50` and `51-200`, which is really 1 to 200. Against exactly that ICP the
actor returned companies with `employeeCountRange: { start: 0, end: 1 }`.

`withinHeadcount` re-checks the stated size on the way back. Only positive
evidence disqualifies: a row with no size at all is kept, because dropping on
missing data loses real companies and the row is paid for either way.
`employeeCountRange` is preferred over `employeeCount`, which counts LinkedIn
members who list the company rather than staff and reads 0 for most small ones.

## What never becomes a candidate

Each rule below is counted and returned as `charged_but_dropped`. Dropping a
row does not refund it, so a run that returns ten rows and keeps one is a fact
the agent needs to widen its next query and the operator needs to explain where
a budget went.

| Reason | Rule |
|---|---|
| `showcase` | `showcase: true`, a `SHOWCASE` page type, or a `/showcase/` URL. A showcase page is a sub-brand carrying its parent's website. |
| `noDomain` | No field yields a registrable domain, or the domain is an aggregator. |
| `headcount` | Stated size cannot overlap the ICP range. |
| `duplicate` | Same registrable domain as a row already kept. |

### The aggregator list is the deduplication key

`normaliseDomain` is the dedup key for the whole system, so a shared host does
not merely waste a scrape: it merges unrelated companies into one lead and
drops the second without telling anyone. Two cases found live:

- `NorthHarbor Growth Solutions` published a Calendly link as its website, so
  it parsed to `calendly.com`. Any second company doing the same would have
  collided with it.
- `SaaS Growth Strategies` published its beehiiv newsletter, parsing to
  `beehiiv.com`.

So the list now covers booking pages, forms, link-in-bio hosts, publishing
hosts and deploy targets alongside the social and directory sites it already
had. Rejecting a registrable domain also rejects the company that owns it,
which costs us Typeform, Eventbrite and Google as leads. None is a plausible
lead for this ICP and every one is a plausible link in a LinkedIn profile.

Expect to keep adding to this list. Both entries above were found by reading
smoke output, not by reasoning in advance.

## Running the smoke test

```
npm run discover:smoke -- "B2B SaaS" \
  --location "United States" --headcount "10 to 100" --industry "B2B SaaS"
```

It runs the pinned actor once with `maxItems: 2` and prints the exact input
sent, reported against settled cost, the full-run projection against both caps,
the raw shape of the first row, and each row with the reason it was kept or
dropped. A field name guessed wrong does not raise an error, it silently drops
every row, so the raw shape is printed before anything tries to interpret it.

## Open

- `lib/industries.ts` aliases are hand-curated. A name outside them is reported
  rather than guessed, which is safe but means the ICP goes unfiltered on that
  axis until an alias is added.
- The Apify Console remains the authority on what was actually billed. The
  settlement floor is a conservative estimate, not a reconciliation. Reading
  `chargedEventCounts` back after aggregation completes would be exact.
