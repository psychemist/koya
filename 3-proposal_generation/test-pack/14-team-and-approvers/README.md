# 14 · Team management and the approver list

**Claimed:** an administrator can say who works here and who may approve.

There was previously **no way to add a colleague** — accounts came from a seed script.
That matters more here than it would in most systems, because the single control the
whole build rests on is that a *different person* approves. An approver list that
cannot be changed is an approval step that decays into whoever happened to be seeded.

## Steps — all in the browser

1. Sign in as the **administrator** (Ngozi Eze). Open **Team**.
2. Authorise `new.approver@example.invalid` as an **approver**.
3. Try to authorise **`NEW.APPROVER@example.invalid`** — the same address, different case.
4. Try to authorise the **salesperson's existing address**.
5. Open a private window, go to `/register`, and register with
   `new.approver@example.invalid`. On the form, deliberately try to pick
   **`admin`** as your role if the form offers it, or `salesperson` if it does not.
6. Sign in as that new account and check the role shown in the header.
7. Back as the administrator: try to change **your own** role to `salesperson`.
8. Try to **deactivate yourself**.
9. If you are the only administrator, try to demote yourself. Then make a second
   person an administrator and try again.
10. Withdraw an unused invitation, then try to register with it.
11. Try to register with an address **nobody authorised**.

## Expected

| Step | What you should see |
|---|---|
| 3 | **Refused.** An authorised address is unique **case-insensitively**. |
| 4 | Refused. An existing member cannot be re-invited. |
| 6 | The role is **`approver`** — taken from the invite, **not from the form**. Whatever step 5 selected is ignored. |
| 7 | Refused. Nobody changes their own role. |
| 8 | Refused. Nobody deactivates themselves. |
| 9 | The **last active administrator** can be neither demoted nor deactivated. Once a second administrator exists, the first can step down. |
| 10 | A withdrawn invitation cannot be used at all. |
| 11 | Refused — **with the same message** as an address that was authorised but already used. |

## Step 6 is the one to care about

The role comes from the **invitation**, never from the registration form. If the form
were trusted, self-registration would be self-promotion, and the whole approval
control would be one form field away from meaningless.

## Step 11 and the identical message

An unauthorised address and an already-used one produce the **same refusal**. Different
messages would turn the registration form into a way to enumerate who works at the
firm.

## No password ever travels

The administrator authorises **an address and a role**. The person sets their own
password. Nothing secret passes between them, so there is nothing to intercept and
nothing to forget to rotate.

## Where the assertion lives

- `build/lib/team.ts` — every guard
- `build/scripts/verify-team.ts` — **15 assertions against real Postgres** (`npm run verify:team`)
- `build/tests/unit/team.test.ts`
- `build/db/migrations/009_team_invites.sql`

Fixtures there use the reserved `.invalid` TLD and are deleted afterwards, so the
suite is safe against a database with real accounts in it.
