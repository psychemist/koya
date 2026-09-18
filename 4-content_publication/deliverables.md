# Week 4: AI Content Research and Publishing Agent

## Deliverables

**1. Front-end or application link**

The application is in [`build/`](build/) and runs locally. There is no hosted URL yet, and
claiming one would be the first dishonest thing in a system built on not doing that.

```bash
cd build
npm install
cp .env.example .env.local     # DATABASE_URL and ANTHROPIC_API_KEY at minimum
npm run migrate
npm run seed                   # manager@koya.test and editor@koya.test, password desk-demo-2026
npm run dev                    # http://localhost:3000
```

**Sign in as both accounts to see the point of it.** The manager raises the request, the editor
approves it, and the manager cannot approve their own work. That is the separation-of-duties
argument made concrete rather than described.

Deploying it needs a host carrying the environment variables from
[`build/.env.example`](build/.env.example) and one scheduled POST to `/api/queue/tick` with the
shared secret. Everything else is deployment-ready: the build passes, there are no
`NEXT_PUBLIC_*` secrets, and every credential-touching call is server-side.

---

**2. Content sample pack**

[**content-sample-pack.md**](content-sample-pack.md)

The exact input given to the system and everything it produced: the article, the LinkedIn post,
the X post, the newsletter, the full source list with each source's outcome, and the
claim-to-excerpt map. It also shows what the gates rejected on the way, because the drafts that
did not survive are the part that shows the system working.

---

**3. Testing evidence**

[**testing-evidence.md**](testing-evidence.md)

The eight-scenario table the brief asks for, plus the nine defects the testing actually found
and what each fix was. Run against the live database and the real Claude API throughout.

```text
npm test                  44 passed   deterministic gates, injection screen, hashing
npm run test:integration  11 passed   state, approval, queue, revert and recovery, on a real Postgres
npm run test:stress        5 of 5     concurrency invariants held
```

Three of those nine defects were the same shape: the code computed the right answer and wrote
down a different one. That is the finding worth carrying out of this project.

---

**4. Video walkthrough**

*To record.* The path worth filming, end to end, runs about seven minutes:

1. Raise a request as the manager, with two real URLs and one that robots.txt forbids. The
   forbidden one is reported, not skipped quietly.
2. The three angles arrive. Pick one. Point out that nothing has been written yet, and why
   that is the expensive decision.
3. While it writes, open the queue page: LinkedIn off, X off with the reason and the price,
   newsletter live.
4. The review screen. Scroll the proof, stop on a struck-through claim, read what the margin
   says about it.
5. Try to approve **as the manager**. It refuses, by name.
6. Sign in as the editor and approve. Read the confirmation dialog aloud, because it names the
   revision and says whether a post will be queued.
7. The queue row appears as `queued_manual`, not `sent`. Say why that distinction is the thing
   the whole system exists for.

---

**5. Reflection sheet**

[**reflection.md**](reflection.md) answers all five questions in full. In short:

- **Clarifying questions:** who signs off and whether they may sign their own work; what we
  have already published; whose LinkedIn exactly; the tolerance for being wrong in public; the
  budget per piece and who watches it.
- **Biggest challenge:** getting the system to tell the truth about its own state. The root
  cause every time was the gap between what the code computed and what it wrote down, and the
  durable record is what the next request reads.
- **What I would change:** make every status change name its own failure path at the type
  level, and run the real pipeline against real URLs on day one instead of near the end.
- **Edge cases:** two workers on one row, a retry after a timeout, a worker killed
  mid-dispatch, a connector that raises, an edit after approval, a double-clicked form, a model
  that ignores its schema, a source carrying instructions, a revision that makes things worse.
- **Models:** Haiku 4.5 extracts, Opus 5 plans once, Sonnet 5 writes, Haiku 4.5 judges. The
  judge is a different model from the writer on purpose, and that choice is not about cost.

---

**6. One-page documentation**

[**one-pager.txt**](one-pager.txt)

Plain text, as PRD4-extended.md's deliverables table specifies, since Mermaid has nowhere to
render in a `.txt`. Header, purpose and success criteria, how it works, how to use it per role,
setup, and an appendix of assumptions, limitations and roadmap, matching the structure of the
Week 2 and Week 3 one-pagers.

---

## The rest of the working record

| Document | What it is |
| --- | --- |
| [design-notes.md](design-notes.md) | The design reasoning, at length |
| [PRD4-extended.md](PRD4-extended.md) | The extended product requirements |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | The build plan |
| [decisions-to-sign-off.md](decisions-to-sign-off.md) | Fourteen decisions, each with what changes if you choose otherwise |
| [assets/architecture.md](assets/architecture.md) | The architecture diagram and its rationale |
| [build/README.md](build/README.md) | The code's own README |
