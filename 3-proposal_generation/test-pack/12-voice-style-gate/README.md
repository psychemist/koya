# 12 · Voice / style gate

**Claimed:** the prose reads like a person, not like anybody.

## Files

- [`files/bad-voice.md`](files/bad-voice.md) — prose carrying every tell the gate
  looks for. Paste it into a section.
- [`files/good-voice.md`](files/good-voice.md) — the same content, rewritten. Should
  produce **zero** findings.

## Steps

1. Open a generated proposal.
2. Click into the **Proposed Solution** section and replace its whole body with
   `files/bad-voice.md`. Save.
3. Read the style findings panel on that section.
4. Press **Fix the voice**.
5. Compare what comes back against `files/good-voice.md`.
6. Now replace the section with `files/good-voice.md` directly and save.
7. Try to approve the proposal while the findings are showing.

## Expected

| Step | What you should see |
|---|---|
| 3 | **11 findings**, each naming the tell and quoting the phrase. Measured, not estimated: 4 × `banned_phrase`, 2 × `intensifier`, 2 × `relative_time`, and one each of `nominalisation`, `parataxis` and `em_dash`. |
| 4 | The findings are handed to the model **as a rewrite instruction**. What comes back should read like step 5's file, not identically to it. |
| 6 | **Zero findings.** Same content, same claims, same price — only the prose changed. |
| 7 | **Approval is not blocked.** Style findings are advisory. |

## Why advisory

Blocking a proposal over a word choice teaches people to waive without reading, and a
waiver nobody reads is worse than no gate. So the gate reports and offers a one-click
fix; it does not stand in the way.

## What the second pass added

The first version caught only **vocabulary and rhythm** — the words. That misses the
tells that actually make a fluent proposal read as machine-written, which are
**syntactic**:

- stacked verbless fragments (`Twelve weeks. Three phases.`)
- corrective negation, both forms (`not X, but Y` / `this isn't X — it's Y`)
- anaphora and parallel sentence structure
- mirrored clauses inside one sentence
- filler intensifiers, nominalisation, performed enthusiasm
- throat-clearing openers and landing beats
- relative time references
- **em dashes, at zero tolerance**

31 assertions, up from 16.

**Bullet lists are exempt from the fragment check.** A verbless noun phrase is the
correct form for a deliverable, and flagging it would make the gate wrong about the
one place the shape belongs.

## The cross-check worth knowing about

The GOOD exemplars shipped inside the prompt produce **0** findings, and the BAD ones
produce several. A gate that passed its own teaching material would prove nothing.

## Where the assertion lives

- `build/lib/gates/style.ts` — every rule, with its reasoning
- `build/tests/unit/style.test.ts` — 31 assertions
- `build/tests/unit/no-em-dashes.test.ts` — the zero-tolerance rule
- `build/lib/claude/exemplars.ts` — the GOOD/BAD pairs that get cross-checked
