# 05 · Human approval before sending

**Claimed:** nothing reaches a client before internal approval.

This is the control the whole product rests on, so it gets the most probes.

## Steps

1. As the **salesperson**, generate a proposal and try to **approve your own**.
2. Sign in as the **approver**. Open the same proposal. Try to **edit** a section.
3. Give the approver role to the *author's* account (Team → role), then have the
   author try to approve their own proposal again.
4. Restore the roles. Leave a **blocking gap** open and try to approve.
5. Approve properly. Then approve **a second time** from a stale tab.
6. Put a proposal in `review` and try to **send** it.
7. Approve a proposal, then **reopen a gap** on it, then try to send.
8. Before approving anything, grab the client link and open it in a private window.
9. As the approver, leave a **comment without deciding**.

## Expected

| Step | What should happen |
|---|---|
| 1 | Refused. A salesperson cannot approve. |
| 2 | Refused. An approver may view and send, **never edit** — an approver who rewrites the document is no longer an independent reviewer of it. |
| 3 | **Still refused.** The author cannot approve their own proposal *even holding the approver role*. Separation of duties is about the person, not the badge. |
| 4 | Refused while a blocking gap is open. |
| 5 | The second approval is refused by the **version guard**, with a message saying nothing was lost. |
| 6 | A proposal in `review` cannot be sent. |
| 7 | The send is blocked. Approval is not a permanent stamp — reopening a gap invalidates it. |
| 8 | **The link resolves to nothing.** A link can exist before approval; a pre-approval token must not resolve. |
| 9 | The comment is recorded and the proposal stays where it is. |

## Steps 8 and 9 are the ones that were broken

**Step 8** is failure mode **F4**. Two holes made the whole guarantee bypassable
without ever touching the send endpoint: read-only endpoints minted live client links,
and the public page never checked `status`. Either one alone was enough to put an
unapproved proposal in front of a client. Both are closed — there is now a status gate
in `resolveShareToken`, preview mints nothing, and the `.eml` fallback is gated too.

**Step 9** is a different kind of defect. The only feedback field used to hang off an
approval *decision*, so asking a question meant rejecting the proposal. When the only
way to give feedback is a rejection, people stop giving feedback, and approval decays
into a rubber stamp. Reviewers can now comment without deciding.

## Where the assertion lives

- `build/tests/unit/access.test.ts` — the role and ownership matrix
- `build/tests/unit/state.test.ts` — every permitted and refused transition
- `build/lib/proposal/access.ts` — `assertCanApprove`, and why approvers cannot edit
- `build/lib/proposal/share.ts` — `resolveShareToken`'s status gate
- `build/scripts/e2e.ts` — *a link can exist before approval* / *a pre-approval token resolves to nothing*

## Then check the trail

**Activity**, filtered to **Approval**. Every approval names the person who gave it,
with a timestamp and a correlation id. That record is the only thing that makes the
control auditable after the fact, and row 11 is about it surviving an erasure.
