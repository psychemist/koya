# Participant Guide: Building Production-Ready Systems (Cohort 3)

## What This Guide Is For

This guide explains **how your work is evaluated in this program** and what we mean by building *production-ready* automation systems.

You are not being graded on how many tools you use or how clever your solution looks. You are being graded on whether the system you built could realistically be used by a business.

Many automations work once, in perfect conditions. Real systems run repeatedly, fail in unexpected ways, and are relied on by other people.

This guide exists to help you build for that reality — and to communicate your thinking clearly through your submissions.

## What "Production-Ready" Means in This Program

In this program, *production-ready* does not mean complex or feature-heavy.

A production-ready system is one that can run **reliably over time**, even when things go wrong.

That means assuming:

- inputs will be messy or incomplete
- external services may fail
- automations may run more than once
- someone else depends on the outcome

Your job is not to prevent every failure, but to **design for failure**.

If your automation only works on the happy path, it is a demo.

If it can handle errors, edge cases, and repeated runs without breaking, it is production-ready.

Everything else in this guide builds on this idea.

## The Core Production Skills We Grade For

When we evaluate your projects we are not just looking at whether the automation works. We are looking at **how it behaves when reality doesn't cooperate**.

These are the five production skills we explicitly grade for.

### Error Handling & Failure Visibility

Systems fail. What matters is whether the failure is **visible and understandable**.

Your solutions must:

- Detect when something goes wrong
- Surface errors clearly instead of failing silently
- Make it possible to tell *what failed and why*

If an automation breaks and no one can tell, it is not production-ready.

### Handling Edge Cases

Real inputs are rarely perfect.

Your solutions must reflect that you have thought about:

- Missing or incomplete data
- Unexpected formats or values
- Situations that break assumptions

You do not need to handle every possible edge case, but you should show that you have **identified the important ones** and designed around them.

---

### Cost Awareness & Resource Usage

Production-ready systems run often. Small inefficiencies add up quickly.

Your work must show signs that you have thought about:

- When an automation should *not* run
- Avoiding unnecessary API or AI calls
- Reusing results instead of recomputing them

You do not need exact cost calculations, but you should demonstrate **intentional use of resources**, not wasteful execution.

<aside>

**Model selection is part of this.** From Week 2 onward, every set of reflections asks which model you used and what you traded off. Picking the largest available model for a task that a smaller one handles is a cost decision, and it is graded under Critical Thinking. "It was the default" is not an answer.

</aside>

---

### Building Unbreakable Workflows

A production-ready workflow should be safe to run repeatedly.

Build systems that handle retries, avoid duplicates, and do not corrupt data when run more than once.

---

### Security & Data Responsibility

Production systems do not expose secrets or sensitive data.

We look for evidence that you understand basic operational security:

- No hardcoded API keys or credentials in nodes
- Proper use of environment variables or credential managers
- No secrets committed to your GitHub repo — including in the history, not just the current file
- No sensitive data exposed in screenshots or demo videos
- No real user data shown unnecessarily
- Thoughtful handling of access and permissions

A system that works but exposes secrets is not production-ready.

## How Your Work Is Graded

Your work is graded across three dimensions:

- **Technical Execution**
- **Communication**
- **Critical Thinking**

These are closely related. Strong submissions tend to score well across all three, because they reflect clear thinking about the system, the business problem it solves, and how it behaves in real conditions.

### Grading Overview

| Grade Level | What This Level Represents | **Technical Execution** | **Communication (Video)** | **Critical Thinking (Reflections)** |
| --- | --- | --- | --- | --- |
| **1 – Incomplete** | A demo that only works in ideal conditions | Automation works only on a narrow happy path and breaks easily. No meaningful error handling or safeguards. | Video is confusing, disorganised, or skips explaining how the system behaves. | Reflections are missing or show no engagement with the problem. |
| **2 – Beginning** | A working solution that lacks robustness | Automation achieves the core objective but is fragile (little to no error handling, no edge case consideration). | Video explains basic functionality but lacks a clear narrative or focus on outcomes. | Reflections describe what was built, not why decisions were made. |
| **3 – Functional** | A system that works as expected | Automation is fully functional, efficient, and handles common edge cases. | Video is clear and concise, and explains the approach effectively. | Reflections identify challenges but stop short of deeper analysis or lessons learned. |
| **4 – Proficient** | A production-ready system | Automation is reliable, safe to run repeatedly, handles multiple edge cases, and follows basic security best practices. | Video clearly demos the system, focusing on behaviour, outcomes, and reliability. | Reflections analyse problems, explain trade-offs, and extract meaningful lessons. |
| **5 – Excellent** | A system built with ownership and judgment | Automation goes beyond the PRD to improve reliability, clarity, or robustness. Failure modes are well handled. | Video is compelling, well-structured, and includes reflection and improvement ideas. | Reflections demonstrate self-mentoring: clear critique of the work and thoughtful future improvements. |

Each dimension is scored out of 5, so each project is out of 15. **You pass on an 11/15 average across the six weeks**, not week by week.

---

## Submissions & Deliverables

Your submission has **four parts**: your workflow, a one-pager, a demo video, and written reflections. From Week 3 there is a fifth — a shareable link.

Together they should clearly communicate **what you built, why it exists, and whether it can be trusted**.

---

### Workflow

You must submit the **actual n8n workflow** you built.

It should:

- Reflect the system shown in your video
- Be runnable and not broken
- Include error handling and safeguards where relevant
- Be safe to run more than once

The workflow is evaluated for **structure, robustness, and production readiness**, not just correctness.

From Week 3 you are building with Claude Code on top of n8n. Everything above still applies — the substrate has not changed, only how fast you can move on it. Code you did not write is still code you own and still code you have to be able to explain.

---

### Shareable link — Week 3 onward

Every project from Week 3 ships a **working front-end with a link somebody else can open**.

It must:

- Actually load, from a machine that is not yours, without you present
- Still be live when your project is graded — a link that has gone down is a submission that cannot be marked
- Not expose keys or credentials to the browser

This is the single most common way a strong project loses points: the build was good and the link was dead.

---

### One-Pager

Your one-pager should read like a short internal document someone else could rely on. It should not be overly technical.

**Include:**

- **Header:** title, owner, key links, last updated date
- **Purpose & Success Criteria:** who it is for, what problem existed, what it does, what changes if it works, how success is measured
- **How it Works:** high-level system behaviour
- **How to Use It:** step by step
- **Appendix (optional):** assumptions, limitations, troubleshooting, artefacts

---

### Demo Video

Your video should be understandable to anyone. **5–8 minutes maximum.**

**Flow:**

1. Who you are and what you built
2. The business problem
3. How the system solves it, and what success looks like
4. Demo:
    - the happy path
    - at least one failure or edge case
5. Key artefacts
6. Brief reflections on trade-offs and improvements

Focus on **behaviour and outcomes**, not nodes.

---

### Reflections

Your reflections should demonstrate **judgment and learning**, not just completion.

Strong reflections show:

- awareness of challenges and their root causes
- understanding of trade-offs — including **which model you chose and why**, from Week 2 on
- consideration of robustness and edge cases
- how your approach evolved

This is where Critical Thinking is scored. It is the cheapest five points in the program to earn and the most commonly thrown away.

---

### Final Check Before Submitting

Before you submit, ask yourself:

- Is the business purpose clear?
- Would someone trust this to run more than once?
- Are failures visible and handled?
- Does the link still open on someone else's machine?
- Are there any keys in the repo, the video, or the front-end?
- Do the submissions focus on outcomes, not just execution?

If yes, you are aligned with what this program is looking for.