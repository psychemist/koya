# 00 · The harnesses

The counts in the evidence table's first block come from here. Run these before any
of the manual rows, because a manual walk-through of a build that does not compile
proves nothing.

```bash
cd ../../build

npm test                  # unit — pure logic, no network, no database
npm run test:e2e          # end-to-end — the real service layer against real Neon Postgres
npm run verify:team       # the admin rules, against real Postgres
npm run verify:activity   # the audit-trail visibility scope, against real Postgres
npx tsc --noEmit && npx next build
```

## What each one is for

| Harness | Proves | Does not prove |
|---|---|---|
| `npm test` | The state machine, access rules, host resolution, parsing, docgen, number grounding, voice gate, theme contrast. | Anything that depends on the database's own behaviour. |
| `npm run test:e2e` | Unique constraints, guarded `UPDATE`s, the gates, the audit trail — the safety properties that *are* Postgres behaving. Tags everything it creates with a run id and removes it. | The model. Section text is injected rather than generated, deliberately: that keeps CI free, deterministic and repeatable. |
| `npm run verify:team` | No self-promotion, the last administrator cannot be removed, an authorised address is unique case-insensitively, a registration takes its role from the invite. | — |
| `npm run verify:activity` | Two salespeople cannot read each other's action logs; approvers and admins see more; the person filter is not a way around the scope. | — |
| `npx next build` | Nothing ships that does not compile. 23 routes. | — |

## Expected

All four suites report **0 failed**. The build reports 23 routes and no type errors.

If `test:e2e`, `verify:team` or `verify:activity` cannot connect, `DATABASE_URL` is
not set in `../../build/.env.local`. They are safe to run against a database with
real data in it and safe to run twice concurrently — every fixture uses the reserved
`.invalid` TLD or a unique run id, and every one of them is deleted at the end.

## The live path

```bash
npm run sample        # one real Opus 5 draft through the real pipeline. Costs ~$0.07.
npm run smoke:claude  # model connectivity only. Costs a fraction of a cent.
```

`npm run sample` is what closed the "Normal proposal generation" row. It writes
`../../sample-proposal.md` and `../../sample-proposal.pdf`, and neither is touched by
hand afterwards.
