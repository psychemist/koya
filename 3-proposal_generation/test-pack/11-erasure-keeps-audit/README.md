# 11 · Erasure keeps the audit trail

**Claimed:** deleting a proposal removes the client's data but not the record that it
was approved.

**Failure mode F7.** `events.proposal_id` was `ON DELETE CASCADE`, so erasing a
proposal destroyed the evidence that a human had approved it. The control and the
proof of the control went out together.

## Note on the browser

There is deliberately **no delete button** in the application. Erasure is a data-subject
request handled by whoever administers the database, not a button next to Send. So
this row is run in your database provider's own web console — for Neon, the **SQL
Editor** in the browser at [console.neon.tech](https://console.neon.tech). No terminal
needed.

## Steps

1. In the app, take a proposal all the way through: create, generate, submit, approve.
   Note its **reference** (`KOY-2026-…`).
2. Open **Activity** and confirm the approval event is there, naming the approver.
3. In the Neon SQL Editor, find it:

```sql
SELECT id, ref, status FROM proposals WHERE ref = 'KOY-2026-XXXX';

SELECT e.action, e.outcome, e.detail, u.name AS actor
  FROM events e LEFT JOIN users u ON u.id = e.actor_id
 WHERE e.proposal_id = (SELECT id FROM proposals WHERE ref = 'KOY-2026-XXXX')
 ORDER BY e.at;
```

4. Erase it:

```sql
DELETE FROM proposals WHERE ref = 'KOY-2026-XXXX';
```

5. Look for the events again — this time by correlation id, since the link is gone:

```sql
SELECT action, outcome, detail, at, proposal_id
  FROM events
 WHERE correlation_id IN ('<the ids you saw in step 3>')
 ORDER BY at;
```

6. Back in the app, reload **Activity**.

## Expected

| Step | What you should see |
|---|---|
| 4 | The proposal, its sections, its gaps and its client data are gone. |
| 5 | **The events are still there.** `proposal_id` is now `NULL`, not a dangling reference. `detail` has been **emptied** — no client name, no company, no address, nothing personal. `action` and `outcome` still say that a proposal was approved, and when. |
| 6 | The rows appear with `system` in the Person column and no proposal reference. The trail keeps its shape; the client has left it. |

## Why a trigger and not application code

Erasure has to hold on a **manual delete run during an incident**, which is exactly
when nobody remembers to null a JSON column first. So the scrubbing is a database
trigger: it fires for the `DELETE` you just typed into a web SQL console, the same as
it would for one issued by the app.

## Where the assertion lives

- `build/db/migrations/007_audit_survives_erasure.sql` — `SET NULL` plus the scrubbing trigger
- `build/scripts/e2e.ts` — 5 assertions: the event survives, no longer points at the proposal, has been scrubbed, retains no personal data, and still records what happened
