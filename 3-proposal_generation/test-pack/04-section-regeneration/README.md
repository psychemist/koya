# 04 · Section regeneration

**Claimed:** one section can be revised without disturbing the rest.

All of this is done in the workspace, in the browser.

## Files

- [`instructions.md`](instructions.md) — the revision instruction to paste, the hand
  edit to make, and how to compare in the browser.

## Steps

1. Open a generated proposal (row 01's is ideal).
2. Before touching anything, select the **Timeline** section on the page, copy it, and
   paste it into a scratch file. You are going to compare against it.
3. On the **Investment** section, open the revise box, paste the first instruction
   from `instructions.md`, and regenerate.
4. Copy Timeline again and compare against your scratch file.
5. Open the **history** on Investment.
6. Make the **hand edit** from `instructions.md` to Introduction, and save.
7. Open Investment's history and **revert** to its first version.

## Expected

| Step | What you should see |
|---|---|
| 3 | Only Investment changes. Nothing else on the page moves. |
| 4 | **Identical.** Not "looks the same" — no differences at all. |
| 5 | Both versions, each stored **with the instruction that produced it**. |
| 6 | The edit is marked **human-authored**, visibly distinct from a model version. |
| 7 | The earlier version comes back, and the revert is itself a third entry rather than a deletion. |

## Why this is the row that justifies the schema

The proposal is stored as **seven rows, not one blob**. With a blob, "regenerating one
section leaves the others byte-identical" is not a claim you can state, let alone
check — there is nothing to compare. The storage decision and this test are the same
decision.

## Then check the trail

**Activity**, filtered to **Drafting**. You should see `Regenerated a section`,
`Edited a section by hand` and `Reverted a section` as three separate events, in order,
each with its own latency. The hand edit and the regeneration are different actions in
the log for the same reason they look different in the history.

## Where the assertion lives

- `build/scripts/e2e.ts` — the byte-identical assertion, made directly
- `build/lib/proposal/sections.ts` — per-section rows and version history
- `build/tests/unit/state.test.ts` — which statuses permit a regeneration
