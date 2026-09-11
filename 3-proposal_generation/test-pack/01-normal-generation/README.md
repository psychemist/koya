# 01 · Normal proposal generation

**Claimed:** a complete intake produces seven structured sections of client-ready prose.

## Files

- [`intake.md`](intake.md) — a complete intake, field by field, ready to paste.

## Steps

1. Sign in as the **salesperson** (Ada Okonkwo).
2. **New proposal**. Paste each field from `intake.md` into the matching box.
3. Submit. The workspace opens with the proposal in `draft`.
4. **Generate**. Watch the sections stream in.

## Expected

- **Seven sections**, each its own block in the workspace: Introduction, Understanding
  of Requirements, Proposed Solution, Scope of Work, Timeline, Investment, Next Steps.
- The prose reuses the client's own words from `client_needs_summary`. It does not
  invent a number, a date or a deliverable that is not in the intake.
- The cost of the run appears in the workspace toolbar. Expect **$0.06–$0.09**.
- No `[NEEDS INPUT]` marker anywhere, because this intake is complete.
- The gap panel shows **advisory** findings at most, and no blocking ones.

## Then check the trail

Go to **Activity**. The most recent rows read `Created the proposal` and
`Drafted the proposal with Claude`, both `done`, both against this reference, both
attributed to Ada. That is the audit trail this row's "and the record is logged"
half depends on.

## Where the assertion lives

- Structure and field mapping: `build/tests/unit/parse.test.ts`, `build/tests/unit/intake.test.ts`
- The seven-section contract: `build/lib/proposal/sections.ts`
- The headless equivalent: `cd build && npm run sample`

## Note

This is the row that was open across every earlier revision, marked ⚠️ because
`ANTHROPIC_API_KEY` was empty and no live draft had ever been produced. It is closed
by running it, not by reasoning about it — and running it is what surfaced the two
template defects in row 13.
