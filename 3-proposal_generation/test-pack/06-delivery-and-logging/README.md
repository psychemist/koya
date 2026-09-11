# 06 · Final delivery and logging

**Claimed:** the approved proposal is exported or sent, and the record is logged.

**Status: ✅ for the gate and the logging.** Actual SMTP dispatch is unverified here,
because neither delivery lane is configured on this machine. That is not a hole — it
is the degradation path, and step 5 is how you see it work.

## Steps

1. Approve a proposal (row 05).
2. Download the client document as **Markdown**, **PDF** and **DOCX**.
3. Search each one for `[NEEDS INPUT]`.
4. Download the **internal** variant and search it for the same marker.
5. With no delivery lane configured, press **Send**.
6. Press **Send** again with the note unchanged.
7. Change the covering note and send again.
8. Issue a share link, open it, then **revoke** it and open it again.
9. Try to edit a **section** of the sent proposal.

## Expected

| Step | What should happen |
|---|---|
| 2 | All three render. |
| 3 | **No `[NEEDS INPUT]` in any client document.** A client must never receive the app's own placeholder. |
| 4 | The internal variant **keeps** the marker. That is who it is for. |
| 5 | The delivery is recorded as **`blocked`**. The app does **not** claim to have sent it, and hands back a **`.eml`** you can drop into a mail client. |
| 6 | **Not an error.** Same idempotency key → the **database** refuses the duplicate and you are told it was suppressed. Not the app remembering; the constraint. |
| 7 | **Allowed.** An edited note is a genuinely different send, and gets a new key. The same holds for an edited subject or a changed recipient. |
| 8 | Resolves, then stops resolving. A revoked link is dead. |
| 9 | **Refused.** A sent proposal is frozen. That is what makes step 7 safe: a second send can change the covering note, never the document the approver signed off. |

## Configuring a lane, if you want to see a real send

Lane A is the n8n workflow, lane B is Resend. In `../../build/.env.local`:

```bash
N8N_PROPOSAL_WEBHOOK_URL=https://<your-n8n>/webhook/koya-proposal-delivery
N8N_WEBHOOK_SECRET=<the same value as IKE_KOYA_WEBHOOK_SECRET in n8n>
# or
RESEND_API_KEY=re_...
RESEND_FROM="Koya Talent <you@yourdomain>"
```

Lane A needs **both** the URL and the secret before it counts as configured. Firing an
unsigned webhook at a configured endpoint is worse than not firing one: the workflow
rejects it anyway, and the failure reads as an outage rather than as the
misconfiguration it is.

On the n8n side the secret is named **`IKE_KOYA_WEBHOOK_SECRET`** and must be set as
an n8n **Variable** (Settings → Variables). A Code node cannot read the process
environment on n8n Cloud, and self-hosted blocks it unless the instance runs with
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. Only the value has to match; the names differ
on purpose, because each side owns its own naming.

Confirm what the deployment thinks is configured on the **System** page (administrator
only) — it reports each lane as present or absent and never shows a secret's value.

## Where the assertion lives

- `build/tests/unit/docgen.test.ts` — `[NEEDS INPUT]` present internally, absent for clients
- `build/tests/unit/delivery.test.ts` — idempotency key derivation
- `build/scripts/e2e.ts` — the database refusing the second delivery
- `build/db/migrations/002_idempotency_index.sql` — the constraint that does the refusing
- `build/lib/delivery/send.ts` — lane A, lane B, and the `.eml` fallback
