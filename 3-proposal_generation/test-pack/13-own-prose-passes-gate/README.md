# 13 · The system's own prose passes its own gate

**Claimed:** a rule applied to Claude applies to the text this codebase writes itself.

Two pieces of prose are **never generated**. Next Steps is a template, and the client
covering email is another. Both were written before the house rules existed, and when
the gate was finally pointed at them, **both failed** — two em dashes, a rule of
three, and "Looking forward to working together".

## Steps

1. Generate any proposal.
2. Read the **Next Steps** section. Check it for em dashes, for a rule of three, and
   for a closing pleasantry.
3. Confirm Next Steps carries **no style findings** in the panel, the same as a
   generated section.
4. Approve the proposal and go to **Deliver**.
5. Read the **covering email** in the preview.
6. Download the `.eml` and read it in a mail client.
7. Compare the email against
   [`../../assets/client-email-template.md`](../../assets/client-email-template.md).

## Expected

| Step | What you should see |
|---|---|
| 2–3 | Clean. No em dashes, no triads, no "Looking forward to working together". |
| 5–6 | The same. It still carries **the link, the contact and the commitment** — the rewrite removed the tells, not the content. |
| 7 | It **deviates** from the supplied template, on purpose. |

## Why the deviation in step 7 is correct

The brief offers `assets/client-email-template.md` as **reference material**, not as a
requirement. The supplied template fails the house rules this build enforces on
everything else. Shipping it unchanged would mean applying a standard to the model
and exempting ourselves from it.

## Why this row is worth more than it looks

**It was found by the live run, not by reading.** The style audit of
`sample-proposal.md` attributed two findings to a section the model never touches,
which is how anyone noticed at all.

That is a worse defect than a model tell. A template is **identical on every
proposal**, so one bad line here ships in everything the firm ever sends — and unlike
generated prose, nobody re-reads it, because it was signed off once.

## Where the assertion lives

- `build/tests/unit/house-text.test.ts` — 4 assertions running the gate over the template and the email
- `build/lib/delivery/message.ts` — the covering email
- `build/lib/proposal/sections.ts` — the Next Steps template
