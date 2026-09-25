# Koya — AI Operations Cohort Projects

Five AI-driven operations projects built for Koya Talent, a staffing and workforce agency, across a cohort program. Each week ships a working system against a real operational pain point: invoice processing, ops reporting, proposal generation, content publishing, and lead research and outreach.

## Projects

### [1 — Invoice Processing](1-invoice_processing/)
Novus Realty receives vendor invoices as PDF attachments and inline email text. An n8n workflow extracts, OCRs, validates and standardizes them into structured records, including handling scanned invoices with no text layer.

### [2 — Operations Reporting](2-operations_reporting/)
Sales, delivery and people-ops data lives in three disconnected tools (Google Sheets, Airtable, an internal API). A scheduled pipeline normalizes all three, computes metrics, generates an AI-written insight brief, and publishes to a read-only dashboard and Discord.

### [3 — Proposal Generation](3-proposal_generation/)
A Next.js app that turns a client intake into a drafted, gated, human-approved proposal with grounding checks, style gates, prompt-injection defenses, team approval workflow, and delivery via a shareable link.

### [4 — Content Publication](4-content_publication/)
A content research and publishing agent for LinkedIn, X and a newsletter: research with citation tracking, a tiered quality-gate pipeline, human review, and scheduled publishing via n8n.

### [5 — Lead Research and Outreach](5-lead_outreach/)
A Claude Agent SDK agent that refines a vague objective into an ICP, discovers companies, reads their sites behind a quarantined injection screen, qualifies each against stored evidence, and drafts a 3-step email sequence plus a LinkedIn message. Nothing is ever sent. Five `SKILL.md` files carry the qualification criteria and safety rules, and the run is bounded by per-run and per-day spend caps enforced in code rather than watched.

Deployed as two Render services from [`5-lead_outreach/render.yaml`](5-lead_outreach/render.yaml): a Next.js `web` service holding the review UI, and a `worker` running the agent loop. They share one Supabase database and communicate only through it, with the `runs` table acting as the queue.

## Structure

Each project folder follows the same shape:

```
N-project_name/
├── PRD.md              product requirements
├── README.md            brief notes for that week (where present)
├── assets/              diagrams and reference guides
└── build/                the actual implementation (app code, n8n workflows, tests)
```

## Setup

Each project's `build/.env.example` documents the environment variables it needs. Copy it to `.env` (or `.env.local`, per that project's convention), fill in real values, and follow that folder's own README/PRD for run instructions.
