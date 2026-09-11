# Revision instructions

Text to paste, and the one hand edit to make. Everything here is done in the browser.

## For step 3 — regenerate Investment

Paste this into the instruction box on the Investment section:

```
Break the fee into the three milestones rather than giving one total, and say what has to be signed off before each one is invoiced.
```

It is deliberately specific. A vague instruction ("make it better") produces a
different draft for reasons you cannot attribute, which makes the comparison in step 4
harder to trust rather than easier.

## For step 6 — the hand edit

Click into **Introduction** and edit it directly in the browser. Change the first
sentence so it opens on the client's own phrase. For the Meridian intake:

```
Two people spend most of every morning rekeying delivery notes that have already been typed once.
```

Save. The section must now be marked **human-authored** in its history, not as a model
version. That distinction is what stops a reviewer from later asking the model to
"regenerate what I just wrote".

## For step 7 — revert

Open Investment's history and revert to **version 1** — the one produced before your
step 3 instruction.

Then look at the history again. There should be **three** entries, not one: the
original, your regeneration, and the revert. A revert that deleted the intervening
version would destroy the record of what the model was asked to do and what it
returned, which is the thing the history is for.

## Comparing Timeline in step 4, in the browser

1. Before step 3, select the whole **Timeline** section in the page and copy it.
2. Paste it into any text editor and save it as `timeline-before.txt`.
3. After the regeneration, select and copy Timeline again into `timeline-after.txt`.
4. Compare the two.

If you want the comparison to be exact rather than by eye, paste both into
[diffchecker.com](https://www.diffchecker.com) or any editor's compare view. The
expected result is **no differences at all** — not "reads the same", identical.

The quicker version, if you only want the signal: watch the Timeline section on screen
while the regeneration runs. It must not flicker, reflow or re-render. Only Investment
should change.
