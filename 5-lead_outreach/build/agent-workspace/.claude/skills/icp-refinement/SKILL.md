---
name: icp-refinement
description: Turn a vague lead qualification objective into concrete ICP criteria with hard filters and soft preferences, before any paid discovery call is made.
---

Refine the objective into an ICP **before** any search. Discovery and scraping cost money; a bad ICP spends it on the wrong companies.

## Clarify all of these
Target company type · industry or niche · geography · headcount range · buyer or
operator persona · the business problem they may have · hard disqualifiers · soft preferences.

## Hard filters vs soft preferences
A **hard filter** must be true or the lead does not qualify: country is United States,
company is B2B, headcount 10 to 100.
A **soft preference** improves fit and never disqualifies on its own: recently hiring
operations roles, uses tools that connect to automation, publishes about scaling ops.

**Never promote a soft preference to a hard filter.** If the user said "may need
automation support", that is a soft preference. Treating it as hard will empty your pool.

## Preserve what the user specified
Every explicit constraint in the objective becomes a hard filter, worded as given.
Do not widen "US" to "North America". Do not narrow "B2B SaaS" to "vertical SaaS".

## Call `save_icp` with exactly this shape
```json
{
  "target_company_type": "",
  "industries": [],
  "geography": [],
  "headcount_range": "",
  "buyer_persona": "",
  "business_problem": "",
  "hard_filters": [],
  "soft_preferences": [],
  "disqualifiers": []
}
```
`hard_filters` must be non-empty or the tool rejects it.

## If it is still too vague to search
Do not guess and spend. Call `save_icp` with `needs_clarification` set to one specific
question, and stop. A parked run costs nothing. A run against a guessed ICP costs the
whole candidate budget.

Germany is excluded from default geography suggestions: its UWG effectively requires
consent for commercial email. Include it only if the user asked for it.
