# 07 · Failure handling

**Claimed:** a failure is visible and debuggable.

The point of this row is that you have to *cause* failures to check it, so each step
below is a way to break something on purpose.

## Steps

1. Open any page. In dev tools, read the **`X-Correlation-Id`** response header.
2. Break the model: set `ANTHROPIC_API_KEY=sk-ant-invalid` in `../../build/.env.local`,
   restart, and press **Generate**.
3. Read the error the browser shows. Copy the reference out of it.
4. Sign in as an **administrator** and open **System**. Find that reference.
5. Open **Activity** and filter to **Failed**. Find the same reference.
6. Break the database: point `DATABASE_URL` at a dead host, restart, and hit any page.
   Watch the **server's stdout**.
7. Restore both. Open `http://localhost:3000/api/health?deep=1`.
8. In two tabs, open the same section. Edit and save in one, then save in the other.

## Expected

| Step | What should happen |
|---|---|
| 1 | Every response carries a correlation id. |
| 3 | A sentence a person can act on, with the reference beside it. **No stack trace, no SQL fragment, no model error verbatim.** |
| 4 | The same id, in the failures table, with the action, the outcome and the redacted detail. |
| 5 | The same event again — this time next to who was doing it and what they were working on. |
| 6 | The audit line still appears **on stdout** as single-line JSON. The trail degrades to the destination that works when the other one is the thing that broke. |
| 7 | Each dependency probed **independently**, so one being down does not report the others as unknown. |
| 8 | The second save is refused with a message saying **nothing was lost**, and telling you to reload. Stale-version writes never silently overwrite. |

## The taxonomy

Errors carry three separate things, and the separation is the design:

- **`code`** — a closed set, for the log and for branching
- **`userMessage`** — what the person reads, written for them
- **`detail`** — the structured context, redacted, for the trail

Nothing from `detail` reaches the browser. Nothing from a stack trace reaches anything.

## The degradation that is not an outage

A PDF that fails to render during a send does not stop the send. The email goes with
the link, and a `proposal.send.pdf_failed` event is written. You can see that event on
the Activity page under **Delivery**. Treating it as a failure would mean a client
gets nothing because an attachment did not build.

## Where the assertion lives

- `build/lib/errors.ts` — the closed taxonomy
- `build/lib/audit.ts` — `recordEvent`, `withAudit`, `redact`, and the stdout fallback
- `build/lib/api.ts` — the correlation id, set once per request
- `build/app/api/health/route.ts` — independent probes
- `build/tests/unit/state.test.ts` — the version guard
