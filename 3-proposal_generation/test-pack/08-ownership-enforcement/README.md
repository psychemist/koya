# 08 · Ownership enforcement

**Claimed:** one salesperson cannot act on another's proposal.

**This was the biggest hole in the build** — failure mode **F1**. Every route checked
*role* and none checked *ownership*, so any signed-in salesperson could edit,
regenerate, submit, send or download any colleague's proposal by addressing its id
directly. The interface never offered it, which is exactly why nobody noticed: hiding
a control is a courtesy to the person who should not use it, never a boundary against
the person who means to.

So this row is tested by **typing a URL you were not given a link to**. That is the
whole attack, and a browser does it perfectly well.

## Setup — two salespeople, two browser windows

1. Sign in as the **administrator** (Ngozi Eze). Go to **Team**.
2. **Authorise an address** as `salesperson` — use something like
   `second.sales@example.invalid`.
3. Open a **private / incognito window**. Go to `/register` and create that account
   with the address you just authorised.

You now have salesperson **A** in your normal window and salesperson **B** in the
private one. Keep both open side by side.

## Steps

1. **As A:** create a proposal and generate it. Copy the URL from the address bar —
   it looks like `http://localhost:3000/proposals/8f3c…`.
2. **As B:** paste that exact URL into the private window's address bar. Press enter.
3. **As B:** try the download link directly. Paste
   `http://localhost:3000/api/proposals/<the same id>/document` into the address bar.
4. **As B:** create a proposal of B's own, and confirm B can open, edit and generate
   that one normally.
5. **As A:** paste **B's** proposal URL into A's window.
6. Sign in as the **approver** (Tunde Bakare) in a third window. Paste A's proposal
   URL.
7. **As the approver:** on A's proposal, try to edit a section — click into the
   section body and change a word.

## Expected

| Step | What you should see |
|---|---|
| 2 | **Not found.** Not "you are not allowed" — *not found*. |
| 3 | A 404 JSON body, not the document. |
| 4 | Everything works. B is not broken; B is just not A. |
| 5 | Not found, symmetrically. |
| 6 | **The proposal opens.** An approver has to read a proposal to judge it. |
| 7 | **Refused, with an honest 403 message** telling you to ask the author to make the edit. |

## Why 404 for a colleague and 403 for the approver

Answering "you are not allowed to touch proposal X" confirms that X exists and that
somebody in the firm is working on it. That is more than a stranger to that deal
should learn from an id they guessed. The approver already knows it exists — they can
see it — so refusing their *edit* with an honest 403 leaks nothing.

Read the refusal messages while you are there. **None of them names the other
salesperson.** A refusal that leaks an identity is a smaller version of the same leak.

## Then check the trail

Sign in as the **administrator** and open **Activity**. Filter to **Refused**. Every
one of B's attempts is there, marked `refused` rather than `failed` — a control doing
its job is not a bug, and the two must not sit in the same list looking identical.

## Where the assertion lives

- `build/lib/proposal/access.ts` — `canAccess`, `assertAccess`, and the reasoning in full
- `build/tests/unit/access.test.ts` — 9 assertions covering this exact matrix
- `assertAccess` is called on all 5 mutating service functions, every direct-repo route, and 3 pages
