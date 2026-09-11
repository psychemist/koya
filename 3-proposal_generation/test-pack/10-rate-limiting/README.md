# 10 · Rate limiting

**Claimed:** paid endpoints and sign-in have a ceiling.

**Failure mode F2.** There was no rate limiting anywhere, which meant unbounded Opus
spend on one side and scrypt sign-in as a CPU amplifier on the other. Both are cheap
to abuse and expensive to absorb.

## Steps — all in the browser

1. Sign out. On the **sign-in** page, enter a real address with a **wrong password**.
   Submit. Repeat as fast as you can click, six or seven times.
2. Read the message on the attempt that gets refused.
3. Wait out the window, sign in properly, and confirm the account is not locked.
4. Open a generated proposal. Press **Generate** repeatedly — as fast as the button
   will let you.
5. Open **Activity** as an administrator and filter to **Refused**.

## Expected

| Step | What you should see |
|---|---|
| 1–2 | After a few attempts, a refusal that says you are going too fast and when to try again. It does **not** say whether the address exists. |
| 3 | You get in. The limiter throttles; it does not lock accounts. |
| 4 | The expensive path is capped too. Generation is the one action in this product that spends real money per press. |
| 5 | Each refusal is recorded as `refused`, not as an error. |

## The assertion that actually matters

The interesting property is not "three requests then a refusal" — it is **ten
concurrent requests against a ceiling of three yielding exactly three**. A read-then-
write limiter loses that race and lets all ten through, and it does so only under
concurrency, which is to say only in production.

You cannot produce that race by clicking. It is asserted against real Postgres in
`build/scripts/e2e.ts`, and it is the assertion that would catch anyone refactoring
the atomic upsert back into two statements.

If you want to see it, that is the one thing here worth running in a terminal:

```bash
cd ../../build && npm run test:e2e
```

Look for the concurrency assertion in the output.

## Fails open, and loudly

If the limiter's own storage is unavailable, requests are **allowed** and the failure
is logged. A limiter whose outage stops every sign-in in the firm is worse than the
abuse it was there to prevent.

## What is not stored

The limiter key is a **digest**. No email address and no IP is held in clear anywhere
in the rate-limit table. Subjects in different scopes never collide, and the same
subject in the same window always does.

## Where the assertion lives

- `build/lib/ratelimit.ts` — the atomic upsert
- `build/tests/unit/ratelimit.test.ts` — 8 assertions on bucketing and the digest
- `build/scripts/e2e.ts` — 3 of 5 serial allowed; 10 concurrent → exactly 3
- `build/db/migrations/003_rate_limits.sql`
