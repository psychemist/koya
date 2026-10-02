# Week 6: Production Customer Support Agent

RelayPay Support Line: a customer can call or chat with RelayPay support and get a grounded answer, one clarifying question, a clean hand-off to a human with a booked callback, or an honest decline.

## Files

- `PRD.md`: the project brief, as issued
- `PRD6-extended.md`: the spec. Extends the brief with the decisions it leaves open: where the agent sits on the voice path, what makes an answer grounded in a way code can check, when identity is established, what escalation actually does, idempotency, cost limits, the chat channel, failure modes, and a 28-row testing bar
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

The code is in `build/`, and `build/.env.example` documents every environment variable it needs. It is three services:

- **Agent service** (`build/agent/`): Vapi treats it as the language model for voice calls, and the web page uses its `/chat` route for chat. One Claude Agent SDK session per conversation. Every reply passes six code checks before anyone hears or reads it.
- **MCP server** (`build/mcp/`): the seven support tools (knowledge search, customer, transaction and payout lookups, tickets, escalations, events), with every call logged.
- **Web app** (`build/app/`): the support page with **Call** and **Chat**, and the signed-in support console.

`render.yaml` in this folder deploys all three to Render.

Common commands, from `build/`:

```bash
npm run migrate && npm run seed && npm run kb:ingest   # database, seed data, knowledge base
npm run mcp      # MCP server on :8788
npm run agent    # agent service on :8787
npm run dev      # web app on :3000
npm test && npm run test:integration                   # unit and integration suites
npm run eval -- --local                                # the scenario harness, graded from stored records
npm run smoke                                          # nine checks against a running stack
```

After running the integration suite against a shared database, run `npm run kb:ingest` again: the suite loads test vectors into the knowledge base.
