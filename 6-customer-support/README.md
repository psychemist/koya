# Week 6: Production Customer Support Agent

RelayPay Support Line: a customer can call or chat with RelayPay support and get a grounded answer, one clarifying question, a clean hand-off to a human with a booked callback, or an honest decline.

## Files

- `PRD.md`: the project brief, as issued
- `PRD6-extended.md`: the spec. Extends the brief with the decisions it leaves open: where the agent sits on the voice path, what makes an answer grounded in a way code can check, when identity is established, what escalation actually does, idempotency, cost limits, the chat channel, failure modes, and a 28-row testing bar
- `render.yaml`: the Render blueprint for the three services
- `assets/relaypay-knowledge-base.md`: approved support knowledge for the agent
- `assets/brand-direction.md`: visual direction for the voice and chat interface
- `assets/support-decision-rules.md`: rules for answering, clarifying, escalating, or declining
- `assets/escalation-rules.md`: support escalation policy
- `assets/mcp-tool-requirements.md`: the MCP tools the server implements
- `assets/supabase-schema-and-seed-data.md`: Supabase schema and seed-data guidance
- `assets/seed-data/`: starter customer, transaction, and payout records loaded into Supabase
- `assets/test-scenarios.md`: scenarios the eval harness grades
- `assets/docs/`: the source policies the spec implements, including the escalation and support handling policy

Start with `PRD.md`, then read `PRD6-extended.md` for what gets built.

## The build

The code is in `build/`, and `build/.env.example` documents every environment variable it needs. It is three services on one Supabase database:

- **Agent service** (`build/agent/`): Vapi treats it as the language model for voice calls, and the web page uses its `/chat` route for chat. One Claude Agent SDK session per conversation, with no built-in tools: only the RelayPay MCP tools. Every reply passes six code checks before anyone hears or reads it: the reply shape, citations from this turn, escalation when a record needs it, no promised outcomes or times, nothing sensitive, and plain speakable words. Per-call rules on tool use (budget, tool calls per turn, no lookups once escalated) run as a PreToolUse hook.
- **MCP server** (`build/mcp/`): the seven support tools (knowledge search, customer, transaction and payout lookups, tickets, escalations, events), with every call logged. Identity is enforced here, from the conversation record, not from what the caller says. An escalation books a Cal.com callback, emails the support inbox through Resend and posts to Discord; an outbox sweeper retries any alert that did not go out.
- **Web app** (`build/app/`):
  - The support page, with **Call** (Vapi web call) and **Chat**. A customer signs in with their account email and customer ID, or continues as a guest. A signed-in caller is already verified and sees their open requests; a guest gets knowledge base answers only.
  - The support console, for staff: conversations, tickets and escalations with their status, and the knowledge base (add and retire articles). Admins also see analytics and evaluations.

The Vapi assistant is saved in Vapi, not sent per call. `build/vapi/assistant.json` is its source of truth, and `npm run vapi:sync` pushes it.

## Running it

Common commands, from `build/`:

```bash
npm run migrate && npm run seed && npm run kb:ingest   # database, seed data, knowledge base
npm run seed:users                                     # the two console accounts, from SEED_* variables
npm run mcp        # MCP server on :8788
npm run agent      # agent service on :8787
npm run dev        # web app on :3000
npm run mcp:stdio  # the MCP server over stdio, for MCP Inspector or Claude Desktop
npm test && npm run test:integration                   # unit and integration suites
npm run eval -- --local                                # the scenario harness, graded from stored records
npm run evidence                                       # writes test-evidence.md from the latest eval runs
npm run smoke                                          # nine checks against a running stack
npm run vapi:sync -- --dry                             # show the assistant Vapi would get; drop --dry to push it
```

After running the integration suite against a shared database, run `npm run kb:ingest` again: the suite loads test vectors into the knowledge base.

`npm run eval -- --local` adds fault-injection rows that need `ALLOW_FAULT_INJECTION=true` on the agent and the MCP server. Never run it against production; run `npm run eval` there instead.

## Deploying

`render.yaml` deploys all three services to Render. In the Render dashboard, set the Blueprint Path to `6-customer-support/render.yaml`. Secrets are set in the dashboard; budgets, models and thresholds are committed in the file.

- The web service runs `npm run migrate` before each deploy. No other service migrates.
- `NEXT_PUBLIC_*` values are compiled into the page, so set them before the web service's first build.
- A change to `build/vapi/assistant.json` reaches Vapi only through `npm run vapi:sync`, not through a deploy.

To check a deploy, point the smoke checks at the live services:

```bash
SMOKE_WEB_URL=https://relaypay-web.onrender.com SMOKE_AGENT_URL=https://relaypay-agent.onrender.com \
SMOKE_MCP_URL=https://relaypay-mcp.onrender.com npm run smoke
```
