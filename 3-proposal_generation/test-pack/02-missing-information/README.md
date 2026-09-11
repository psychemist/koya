# 02 · Missing information

**Claimed:** gaps are detected, marked, and block approval rather than being invented around.

## Files

- [`intake.md`](intake.md) — a realistic post-call state: the problem is clear, the
  commercials are not there at all.

## Steps

1. Sign in as the **salesperson**. **New proposal**, paste `intake.md`, submit.
2. **Generate**.
3. Read the gap panel.
4. Try to move it forward: **Send for review**, then sign in as the **approver** and
   try to **Approve**.
5. Try to waive a blocking gap with the reason box empty.
6. Now waive one *with* a written reason, and re-run detection.
7. Go back and fill in `project_scope` and `estimated_pricing` properly.

## Expected

| Step | What should happen |
|---|---|
| 3 | Blocking gaps against the empty fields. Advisory gaps for the softer omissions. The draft carries `[NEEDS INPUT]` where a figure is missing rather than a plausible invented one. |
| 4 | Approval is **refused server-side**, not just greyed out in the UI. |
| 5 | **Refused.** A waiver without a written reason is rejected by the route *and* by a `CHECK` constraint on the table. |
| 6 | The waiver **survives** re-detection. Re-running does not duplicate the gaps it already found. |
| 7 | The gaps clear **automatically**. Nobody has to go and close them by hand. |

## The thing worth watching for

That the model does not fill the hole. A missing price should come through as
`[NEEDS INPUT]`, not as "£45,000" — a figure that reads as researched and is not.

The `[NEEDS INPUT]` marker appears in the internal view and is **never** present in a
client document. Check that in row 06.

## How it works

Two stages. A deterministic validator runs first and costs nothing, then a Haiku pass
looks for semantic gaps a field check cannot see — a scope with no exclusions, a
timeline with no start condition. Blocking gaps refuse approval on the server.

## Where the assertion lives

- `build/tests/unit/intake.test.ts` — validator gaps
- `build/tests/unit/state.test.ts` — a blocking gap refuses the transition
- `build/scripts/e2e.ts` — waiver survives re-detection, no duplicates, empty reason refused
- `build/db/migrations/001_init.sql` — the `CHECK` behind the waiver reason
