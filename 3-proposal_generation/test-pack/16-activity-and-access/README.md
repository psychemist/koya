# 16 · Audit trail visibility and the administrator lock

**Claimed:** every action is recorded against the person who took it, and each reader
sees exactly the events they were already entitled to see.

Not in `test-evidence.md` yet. This row covers two changes made after that document
was last written:

- **System is now administrator-only.** It reports what is configured on this
  deployment, what every Claude call cost, and every failed send with the client
  address attached. None of that is a salesperson's to read.
- **Activity is new**, and it is where the audit trail became readable inside the
  product for everyone else.

## Where the audit trail actually is

Three places, and it is worth knowing which is which:

| | What it is |
|---|---|
| **`events` table** | The record itself. One row per action, with the actor, the proposal, the outcome, the latency, the error code, and a redacted detail payload. Defined in `build/db/migrations/001_init.sql`. |
| **stdout** | The same event, as one line of JSON, written *before* the database insert is attempted. This is the copy that survives the database being the thing that broke. |
| **`/activity` and `/system`** | The two readings of it. Activity reads it **by person**; System reads it **by failure**. |

Everything is written by `recordEvent()` and `withAudit()` in `build/lib/audit.ts`.
`withAudit` wraps an operation so it is logged exactly once whatever happens, with a
measured latency, and rethrows whatever it caught — the logging is a side effect,
never a behaviour change.

## Setup

You need all three seeded roles, plus the second salesperson from
[row 08](../08-ownership-enforcement/). Have each in its own browser window.

## Steps

1. **As the administrator:** the header shows **Pipeline · Activity · System · Team**.
2. **As the salesperson:** the header shows **Pipeline · Activity** only.
3. **As the salesperson:** type `/system` into the address bar.
4. **As the salesperson:** open **Activity**. Note what is there.
5. **As salesperson B:** create and generate a proposal of B's own.
6. **As salesperson A:** reload Activity. Look for anything of B's.
7. **As the approver:** open Activity.
8. **As the administrator:** open Activity. Use the **People** table.
9. Click a person's row. Then use the **Everything / Drafting / Review / Approval /
   Delivery / Accounts** chips, and the **Any outcome / Succeeded / Refused / Failed**
   chips.
10. Copy the URL with filters applied and paste it into another window.
11. Click a **proposal reference** in the trail.

## Expected

| Step | What you should see |
|---|---|
| 1–2 | System and Team are **hidden** for non-admins, not shown and then refused. A link that always bounces you is worse than no link. |
| 3 | Redirected to **`/activity`** — not a 403. Typing a URL that is not yours is not an error worth an error page. |
| 4 | Their own actions, plus everything that happened to proposals **they wrote** — including an approver's approval of their work. |
| 6 | **Nothing of B's.** Not a redacted row, not a count. Nothing. |
| 7 | Every event against **any** proposal, because an approver may already open any proposal. Not other people's sign-ins. |
| 8 | Everyone, with events, proposals, drafted, approvals, sends, refused, failed and last-active per person. |
| 9 | The filters narrow. **Refused** and **Failed** are separate — a permission check doing its job must not sit in the same list as a crash. |
| 10 | **The same view.** Every filter is in the query string, so a filtered trail can be pasted into a message. |
| 11 | It opens that proposal — if you are allowed to open it. |

## Step 6 is the assertion that matters

The scope is one clause in `build/lib/activity.ts`, and what goes wrong with a scope
clause is that it **silently matches too much**. A check that counted rows would pass
against a clause returning everything, so the automated version is comparative: two
salespeople each act on their own proposal, and each must see their own and not the
other's.

```bash
cd ../../build && npm run verify:activity
```

**13 assertions against real Postgres.** Fixtures use the reserved `.invalid` TLD and
are removed afterwards.

## The person filter is not a way around the scope

Filtering by a colleague's id returns **nothing**, rather than being refused. Refusing
would confirm the id belongs to someone. The filter is ANDed with the visibility scope
in the query itself, so there is no separate check to forget and no membership oracle.

## Then break something and watch both pages

Follow [row 07](../07-failure-handling/) to cause a failure. The same event, with the
same correlation id, appears:

- on **System** under *Recent failures and refusals* — with the configuration and
  spend context an administrator needs
- on **Activity** under **Failed** — next to who was doing it and what they were
  working on

Same row, read two ways. That is the whole design.

## Where the assertion lives

- `build/lib/audit.ts` — `recordEvent`, `withAudit`, `redact`, the stdout fallback
- `build/lib/activity.ts` — `scopeClause`, and why the rule is written once
- `build/scripts/verify-activity.ts` — 13 assertions against real Postgres
- `build/app/activity/page.tsx`, `build/app/system/page.tsx` — the two readings
- `build/db/migrations/001_init.sql` — the `events` table and the `recent_failures` view
