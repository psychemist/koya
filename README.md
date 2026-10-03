# Koya — AI Operations Cohort Projects

Six AI-driven operations projects built for Koya Talent, a staffing and workforce agency, across a cohort program. Each week ships a working system against a real operational pain point: invoice processing, ops reporting, proposal generation, content publishing, lead research and outreach, and customer support.

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

### [6: Customer Support](6-customer-support/)
The RelayPay Support Line: a customer calls (a Vapi web call) or chats, and gets a grounded answer, one clarifying question, a hand-off to a human with a booked callback, or an honest decline. A Claude Agent SDK agent is the language model behind the call, with no built-in tools, only seven MCP support tools: knowledge search, customer, transaction and payout lookups, tickets, escalations and events. Every reply passes six code checks before it is spoken or shown (citations from this turn, no promised outcomes, nothing sensitive among them), and identity is enforced by the tools from the conversation record, not from what the caller says. Customers sign in with their account email and customer ID, or continue as guests with knowledge base answers only. An escalation books a Cal.com callback, emails the support inbox and posts to Discord. A staff console covers conversations, tickets, escalations and the knowledge base, with analytics and evaluations for admins.

Deployed as three Render services from [`6-customer-support/render.yaml`](6-customer-support/render.yaml): the Next.js `web` app (support page and console), the `agent` service Vapi calls as its model, and the `mcp` server. They share one Supabase database; the Vapi assistant's settings live in `build/vapi/assistant.json` and are pushed with `npm run vapi:sync`.

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
