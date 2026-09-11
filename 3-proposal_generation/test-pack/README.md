# Test Pack

One folder per row of [`../test-evidence.md`](../test-evidence.md), each holding the
text and the files you need to run that row by hand.

The automated suites already assert most of this — `npm test`, `npm run test:e2e`,
`npm run verify:team`, `npm run verify:activity`. This pack exists for the part a
suite cannot do: watching the claim happen in the actual interface, with real input,
in front of someone who is deciding whether to believe it.

So every folder answers the same three questions in the same order:

1. **What is being claimed** — the row's expected result, unchanged.
2. **How to see it happen** — steps against a running application.
3. **Where the automated assertion lives** — the file and the test name, so a
   reader can check that the manual walk-through and the suite agree.

## How these are meant to be run

**In the browser, against a running application.** Every row below is clicks, pasted
text and uploaded files. Nothing needs a script.

Three exceptions, and each says so where it comes up:

- [`00-harnesses/`](00-harnesses/) is the four test commands themselves. That is what
  the row is.
- [`11-erasure-keeps-audit/`](11-erasure-keeps-audit/) needs a SQL console, because
  there is deliberately no delete button in the product. Your database provider's web
  console does it — for Neon, the SQL Editor at console.neon.tech. Still a browser.
- Two assertions genuinely cannot be produced by clicking: the byte-identical section
  comparison in row 04 and the concurrency race in row 10. Both are noted in place,
  with the suite that covers them.

## Before you start

```bash
cd ../build
npm ci
cp .env.example .env.local      # DATABASE_URL, ANTHROPIC_API_KEY, APP_SESSION_SECRET, APP_BASE_URL
npm run migrate
npm run seed                    # reads SEED_*_EMAIL / SEED_*_PASSWORD from .env.local
npm run dev
```

`npm run seed` creates three accounts and you need all three, because half the rows
below are about one person not being able to do what another person can:

| Role | Name | Why the pack needs it |
|---|---|---|
| `salesperson` | Ada Okonkwo | Writes proposals. Cannot approve. |
| `approver` | Tunde Bakare | Approves. Cannot edit. |
| `admin` | Ngozi Eze | Manages the team. The only role that sees System. |

Rows 08 and 16 need a **second** salesperson. Sign in as the administrator, go to
**Team**, authorise a second address as `salesperson`, then register it.

## Cost

Rows 01, 02, 03 and 04 call Claude and spend real money — roughly **$0.07 per draft**
on `claude-opus-5`, and a few tenths of a cent for each gap and grounding pass. The
rest cost nothing. `npm run sample` in `../build` produces the same draft headlessly
if you only need the artefact.

## The rows

| Folder | Evidence row | Files provided |
|---|---|---|
| [`00-harnesses/`](00-harnesses/) | The three harnesses and their counts | — |
| [`01-normal-generation/`](01-normal-generation/) | Normal proposal generation | Complete intake |
| [`02-missing-information/`](02-missing-information/) | Missing information | Sparse intake |
| [`03-supporting-material/`](03-supporting-material/) | Supporting material used | 4 PDFs, text-layer and scanned |
| [`04-section-regeneration/`](04-section-regeneration/) | Section regeneration | Revision text to paste |
| [`05-human-approval/`](05-human-approval/) | Human approval before sending | — |
| [`06-delivery-and-logging/`](06-delivery-and-logging/) | Final delivery and logging | — |
| [`07-failure-handling/`](07-failure-handling/) | Failure handling | — |
| [`08-ownership-enforcement/`](08-ownership-enforcement/) | Ownership enforcement | — |
| [`09-prompt-injection/`](09-prompt-injection/) | Prompt injection in an upload | 6 hostile documents, 3 also as PDF |
| [`10-rate-limiting/`](10-rate-limiting/) | Rate limiting | — |
| [`11-erasure-keeps-audit/`](11-erasure-keeps-audit/) | Erasure keeps the audit trail | SQL to paste |
| [`12-voice-style-gate/`](12-voice-style-gate/) | Voice / style gate | Good and bad prose |
| [`13-own-prose-passes-gate/`](13-own-prose-passes-gate/) | The system's own prose passes its own gate | — |
| [`14-team-and-approvers/`](14-team-and-approvers/) | Team management and the approver list | — |
| [`15-dead-style-references/`](15-dead-style-references/) | Dead style references | Defect to reintroduce |
| [`16-activity-and-access/`](16-activity-and-access/) | Audit trail visibility and the admin lock | — |

Row 16 is not in `test-evidence.md` yet. It covers the System page moving behind the
administrator role and the Activity page that replaced it for everybody else.
