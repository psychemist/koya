# Koya Talent — AI Operations Reporting System

**Week 2 submission.** n8n pulls Sales (Google Sheets), Project Delivery (Airtable) and People
Ops (HTTP API), calculates 28 metrics for a selected reporting period and a comparison window,
has Claude interpret them department by department, verifies what Claude wrote against the
figures it was given, stores everything in Supabase, and publishes a dashboard with trend
charts and a per-team view.

> **New here? Read [`starter-guide.md`](starter-guide.md) first.** It covers what the system is
> meant to achieve, then how it works, then why it is built this way — design decisions,
> trade-offs, and the edge cases it handles.

---

## Deliverables

| # | Deliverable | File |
|---|---|---|
| 1 | **Workflow artifact** | [`koya-ops-reporting.json`](koya-ops-reporting.json) — 30-node n8n export |
| 2 | **Dashboard** | [`dashboard/index.html`](dashboard/index.html) — Supabase-connected · [`dashboard/preview.html`](dashboard/preview.html) — offline preview, real numbers |
| 3 | **Testing evidence** | [`test-evidence.md`](test-evidence.md) — the required table, filled in, + 4 appendices |
| 4 | **Video walkthrough** | Loom link: _paste here before submitting_ · script: [`demo-script.md`](demo-script.md) |
| 5 | **Reflection sheet** (incl. model-selection note) | [`reflections.md`](reflections.md) — the 5 questions answered; Q5 is the model note |
| 6 | **One-page documentation** | [`one-pager.md`](one-pager.md) — purpose, architecture, setup, troubleshooting, limits |
| — | Starter guide | [`starter-guide.md`](starter-guide.md) |
| — | Database schema + RLS | [`supabase/schema.sql`](supabase/schema.sql) |

---

## Try it in two minutes — no accounts needed

```bash
cd 2/build

node harness/run.js            # every period, calculated from the real source files
node harness/run.js --assert   # 239 assertions against the real pipeline code
open dashboard/preview.html    # the real dashboard, real numbers, offline
```

---

## Repository layout

```
2/build/
├── koya-ops-reporting.json        the n8n workflow (generated — do not hand-edit)
├── code/                          the ten Code node bodies, as testable .js files
│   ├── 01-resolve-reporting-period.js    one place decides the window
│   ├── 02-normalize-sales.js             type · keep bad rows · attach reasons
│   ├── 03-normalize-delivery.js
│   ├── 04-normalize-people-ops.js
│   ├── 05-compute-metrics.js             all 28 metrics × 2 windows, no model
│   ├── 06-build-claude-brief.js          prompt + schema + allowed-figures list
│   ├── 07-parse-validate-insights.js     the gate: schema · groundedness · fallback
│   ├── 08-build-supabase-payloads.js     seven arrays, every row naturally keyed
│   ├── 09-verify-publish.js              counts returned vs counts sent
│   └── 10-build-discord-report.js        the full report, chunked to Discord's cap
├── dashboard/
│   ├── index.html                 live dashboard — reads config.js, host it anywhere
│   ├── build-config.js            writes config.js from .env or the host's environment
│   ├── vercel.json                build command, output dir, headers
│   ├── package.json               `npm run build` → build-config.js (what Vercel runs)
│   ├── config.example.js          shape of the generated config; no real key
│   └── preview.html               generated offline preview
├── supabase/schema.sql            8 tables · 3 views · RLS · retention
├── harness/
│   ├── run.js                     runs the real Code nodes outside n8n
│   ├── assertions.js              239 assertions
│   ├── build-workflow.py          generates the workflow JSON from code/
│   ├── build-preview.js           builds preview.html + dashboard contract check
│   ├── sync-remote.py             applies code/ onto the live workflow export
│   └── build-dashboard-config.js  wrapper — runs dashboard/build-config.js
├── evidence/                      captured output from the last run
└── *.md                           the documents in the table above
```

**The workflow JSON is generated, never hand-edited.** `harness/build-workflow.py` reads the
`.js` files in `code/` and assembles the export, so the JavaScript that runs in n8n is the same
text the harness tests and a reviewer reads. Change a Code node, then re-run:

```bash
python3 harness/build-workflow.py    # regenerate + validate the graph
node harness/run.js --assert         # re-verify
node harness/build-preview.js        # rebuild the preview + contract check
```

---

## The nine ideas worth knowing

1. **n8n owns the arithmetic; Claude owns the judgement.** Every figure is computed in
   deterministic JavaScript. A model that miscounts produces a wrong number that looks exactly
   like a right one, so the model is not allowed near the arithmetic.

2. **Marketing spend is not a column sum.** The source repeats one monthly budget on every row of
   that month; summing it overstates spend 8.7× and cost per lead with it. Collapsed to one
   figure per month, then pro-rated by days covered.

3. **Missing is never zero — and neither is a dead source.** Every metric returns `null` plus a
   written reason, and the dashboard prints the reason instead of a misleading `0%`. When a whole
   source fails to answer, its figures are nulled the same way and the section says which system
   did not respond: "0 active projects" is a measurement, and what actually happened is that
   nobody measured.

4. **The AI output is verified, not trusted.** Every number in the commentary is matched against
   the figures Claude was given. Unmatched figures are named on the page and the confidence badge
   is forced down — regardless of what confidence the model claimed for itself.

5. **Idempotency lives in the keys.** Every row's primary key comes only from the business data —
   no timestamps, no execution ids — and every write is an upsert. Guards can be bypassed; keys
   cannot.

6. **A run that changes nothing costs nothing.** Each run fingerprints its figures; if nothing
   moved, there is no model call and no write.

7. **Data quality is scoped to the window on screen.** The sources are read whole, so the
   normalizers see every issue in them. Each issue carries the dates of the record it came from,
   and only the ones that touch the selected period are counted against the report — the rest are
   folded into one counted line. A warning about a March lead under a heading that says "last 30
   days" contradicts the numbers above it.

8. **The period has a shape, not just a total.** Each domain emits a bucketed series across the
   window — daily, weekly or monthly by span, cut backwards from the end so the most recent
   bucket is always whole — which the dashboard draws as trend charts and Claude reads as
   measured movement rather than something to infer from two totals.

9. **A half-written report cannot exist.** The whole report — run, metrics, breakdowns,
   insights, data quality and the cleaned source records — is written by a single Postgres
   function, `publish_report()`, in one transaction. It commits everything or changes nothing.
   The run row is also published *inside* that transaction, and the dashboard view shows
   published runs only, so a write that fails part-way
   leaves the previous good report on screen instead of a run with no metrics behind it.

---

## Deploying the dashboard

`dashboard/index.html` is a static page with no build step of its own. The one thing it needs is
`config.js`, which is **generated, never committed** — so a key is rotated by changing a value
and rebuilding, not by editing and redeploying HTML.

```bash
# locally — values come from the repo-root .env
node harness/build-dashboard-config.js
open dashboard/index.html
```

On Vercel there is no `.env` (it is gitignored, which is the point), so the same generator reads
the project's Environment Variables during the build:

| Setting | Value |
|---|---|
| Root Directory | `2/build/dashboard` |
| Build Command | `node build-config.js` *(already in `vercel.json`)* |
| Output Directory | `.` *(already in `vercel.json`)* |
| Environment Variables | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and optionally `N8N_WEBHOOK_URL` |

The `IKE_`-prefixed spellings are accepted there too and take precedence, so one set of names
works locally and hosted. The generator prints where each value came from, and refuses outright
to write a secret key into a page every visitor can read.

---

## Security

- **No credentials in this repository, the workflow export, or the dashboard source.** The
  workflow's keys live in n8n's credential manager. The dashboard's key lives in a gitignored
  `.env` — or, on Vercel, in the project's environment; `dashboard/build-config.js` turns either
  into a gitignored `dashboard/config.js`.
- **No deployment values baked into the workflow either.** The Supabase project URL and the
  reporting anchor are read as `IKE_SUPABASE_URL` and `IKE_KOYA_REFERENCE_DATE` — from
  **Settings → Variables** on n8n Cloud (`$vars`), or the instance environment when self-hosted
  (`$env`, which Cloud blocks) — with no literal fallback in any Code node. The `IKE_` prefix
  stops them colliding with anything else on a shared instance — `$env` exposes the whole
  process environment. An unset variable is reported on the run rather than resolving to a
  hardcoded project ref that ships inside every export.
- **The Discord webhook URL is a bearer secret and is stored as one.** Anyone holding it can
  post to the channel with no further authentication, so it lives in n8n's credential store
  like an API key, never in the workflow file.
- **The n8n webhook URL is treated as a secret too.** The webhook has no authentication and
  CORS is open, so the URL *is* the access control. Setting `IKE_N8N_WEBHOOK_URL` publishes it
  to every dashboard visitor — only do that behind an authenticated host, or add Header Auth
  to the webhook first.
- **Row level security on every table, SELECT-only for `anon`.** There is no insert, update or
  delete policy for `anon` anywhere in the schema.
- **`people_records` is not readable with the browser key at all** — employee-level records with
  exit dates are not something a publishable key should reach. The dashboard never needs them:
  headcount by department reaches it as an already-aggregated breakdown on the run.
- **Secret keys (`sb_secret_…`) are held only by n8n.** They bypass RLS. The config generator
  refuses to write one into the dashboard, and the page refuses to send one.
- **The browser key is public and treated as such.** `config.js` ships to the browser, so the
  publishable key is readable by anyone who opens the dashboard — that is what publishable keys
  are for. `.env` keeps it out of the repo and makes rotation a one-line change; RLS is what
  protects the data.

  Supabase's key migration changes the keys, not the roles: `sb_publishable_…` replaces the
  legacy `anon` key and still resolves to the `anon` Postgres role, `sb_secret_…` replaces
  `service_role` and still resolves to `service_role`. Every policy in `schema.sql` is unaffected,
  and the dashboard accepts either generation of key while you migrate.
- Two things still to do before this faces anything untrusted, both flagged in
  [`one-pager.md` §7](one-pager.md): the webhook is unauthenticated as shipped, and there is no
  alerting on a failed run.

---

## Status

| | |
|---|---|
| Pipeline logic | **Verified** — 239 automated assertions; 21 metrics hand-checked against source rows |
| Dashboard | **Verified** — rendered end-to-end against real pipeline output, light and dark |
| Workflow graph | **Validated** — generated and structurally checked |
| Live deployment | **Not yet run** — 10 deployment checks are listed and open in [`test-evidence.md` §7](test-evidence.md) |

Nothing in the evidence is reported as passing that was not observed passing.
