# Koya — AI Operations Cohort Projects

Four AI-driven operations projects built for Koya Talent, a staffing and workforce agency, across a cohort program. Each week ships a working system against a real operational pain point: invoice processing, ops reporting, proposal generation, and content publishing.

## Projects

### [1 — Invoice Processing](1-invoice_processing/)
Novus Realty receives vendor invoices as PDF attachments and inline email text. An n8n workflow extracts, OCRs, validates and standardizes them into structured records, including handling scanned invoices with no text layer.

### [2 — Operations Reporting](2-operations_reporting/)
Sales, delivery and people-ops data lives in three disconnected tools (Google Sheets, Airtable, an internal API). A scheduled pipeline normalizes all three, computes metrics, generates an AI-written insight brief, and publishes to a read-only dashboard and Discord.

### [3 — Proposal Generation](3-proposal_generation/)
A Next.js app that turns a client intake into a drafted, gated, human-approved proposal with grounding checks, style gates, prompt-injection defenses, team approval workflow, and delivery via a shareable link.

### [4 — Content Publication](4-content_publication/)
A content research and publishing agent for LinkedIn, X and a newsletter: research with citation tracking, a tiered quality-gate pipeline, human review, and scheduled publishing via n8n.

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
