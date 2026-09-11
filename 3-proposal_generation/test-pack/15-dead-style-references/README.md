# 15 · Dead style references

**Claimed:** a class name that never matched cannot ship.

The review comments panel shipped with `className="field"`, `var(--line)` and
`.badge-neutral` — **three names with no rule behind any of them**. That is why the
comment composer was an unstyled browser textarea sitting in the middle of a designed
panel.

The failure mode is the point: CSS resolves an unknown class to nothing and an unknown
variable to nothing. **The compiler, the linter and code review are all blind to it.**
It surfaces only when a person looks at the screen.

## Steps — reintroduce the defect and watch it get caught

1. Open `build/components/CommentThread.tsx` in your editor.
2. Find the composer's `className` and change one of its classes to something that
   does not exist — `className="field"` is the original defect, so use that.
3. Save. Look at the comment composer in the browser.
4. Run the check:

```bash
cd ../../build && npm test
```

5. Read the failure. Then undo your edit and run it again.

## Expected

| Step | What you should see |
|---|---|
| 3 | An unstyled browser textarea. No border, wrong font, wrong padding — visibly foreign to the panel around it. **Nothing in the terminal says anything is wrong.** |
| 4 | The test **fails**, naming the file and the class that has no rule behind it. |
| 5 | Green again. |

This is the round trip that proves the test works: the original defects were
reintroduced and the test was watched failing. A test for an invisible failure that
has never been seen to fail is not yet a test.

## What is and is not checked

Only names **this project defines**. Tailwind utilities are generated on demand and
never appear in the source stylesheet, so checking every class would flag `gap-2` and
`no-underline` on every line.

The families are listed explicitly in the test, and names whose prefix collides with a
Tailwind utility — `.tbl`, `.steps`, `scroll-x` — are listed by their **full name**
instead, because a family rule could not tell `scroll-y` from Tailwind's `scroll-mt-24`.

**Adding a new component class means adding its family to that list.** That is the
cost of the test, and it is one line.

## Where the assertion lives

- `build/tests/unit/styles-exist.test.ts` — 3 assertions scanning every `.tsx` file against `globals.css`
