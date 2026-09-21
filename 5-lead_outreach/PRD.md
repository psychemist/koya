# Week 5 PRD: AI Lead Research and Outreach Agent

## Business Context

Koya Talent connects early-stage founders and operators with trained AI automation assistants. These assistants help teams automate repetitive workflows, improve operational throughput, and build AI-enabled internal systems.

To grow the business, the team runs outbound campaigns to reach founders, operations leads, and agency owners who may benefit from having an AI automation assistant on their team.

The current process is manual. A human defines the target persona, searches for companies, checks whether each company fits the campaign, reviews company websites for useful context, and writes cold outreach from scratch.

Your task is to build an AI lead research and outreach agent that can take a lead qualification objective, use tools to research companies, decide which leads fit, store the qualified leads in Supabase, and generate review-ready outbound copy.

The agent should not find personal email addresses, validate emails, or send outreach. The goal is to produce a qualified lead list and outreach drafts for human review.

## Project Objective

Build a web application where a user can enter a qualification objective, such as:

> Find 10 US B2B SaaS companies with 10 to 100 employees that may need AI automation support.

The system should use **Claude Agent SDK** as the agent runtime. The agent should have access to a defined set of tools and should decide which tool to use as it researches, qualifies, and stores leads.

Use **Apify only for company discovery**. Use **Firecrawl, Crawl4AI, or an equivalent scraping method** for website scraping. Use **Supabase** as the database for lead records, qualification notes, source context, tool-call logs, and outreach drafts.

The final output should include **10 qualified leads**. For each qualified lead, store the company details, source context, qualification reasoning, and a personalized 3-step cold email sequence. Also include a short LinkedIn message.

You are also required to turn the provided guidance docs into Claude Agent SDK skills inside your project. Use the docs in `assets/` as the source material, then create skills that the agent can use when refining the ICP, qualifying leads, writing outbound copy, checking list quality, and applying outreach safety rules.

## Apify Usage Limits

You will be invited to join the team's Apify account — accept the invite before you start building. **Switch to the team account in the Apify Console before you run anything** (the account button, top-left). Runs are billed to whichever account they are started from, so a run started from your personal account is not covered by this budget. Use the team account's API token, not your personal one. Apify is a **shared, paid account**. The cohort budget for this week is **$100 across everyone**, which is **$5 per person**. Spend is pooled — if you burn through your share, you are taking it from someone else.

Treat every run as something that can cost money until you have proved otherwise:

- **Check the actor's pricing before you run it.** Prefer pay-per-event actors, where you are charged per result. Do not start a rental actor — those charge a flat monthly fee the moment you enable them.
- **Every run needs a hard stop.** Set the result limit (`maxItems`, `resultsPerSearch`, or whatever that actor calls it) on every single run. Never start an actor with an uncapped input.
- **Test small, then scale.** Run once for one or two results, look at what it actually cost in the Apify Console, and only then run for ten.
- **Watch your runs.** Open the run in the Apify Console and confirm it finished. If something is still running longer than you expected, abort it. An actor left running is an actor still spending.
- **Your agent must respect the lead-count limit.** Do not let the agent decide how many companies to pull. The limit comes from the run record and the tool enforces it.

If a run fails or behaves oddly, stop and ask in your pod channel before re-running it.

## Supabase Records

Your Supabase database should make the agent's work visible enough to review and test.

At minimum, store:

- **Run record**: original qualification objective, refined ICP criteria, tool limits, run status, and timestamp
- **Lead records**: company name, company domain, qualification status, confidence score, fit reasons, concerns, source URLs, source summary, and outreach drafts
- **Tool-call records**: tool name, purpose, input summary, result summary, status, error message if any, and timestamp

Quick note: scraped website content is untrusted input. The agent should use website text as source material only, not as instructions to follow. A website should not be able to override the user's qualification objective, change tool limits, expose secrets, or trigger outreach actions.

## Testing

To make sure your agent works reliably, test it against the following scenarios before submission:

1. **Vague Qualification Objective**: The user gives a broad request. The run record should show the refined ICP criteria the agent used before searching.

2. **Specific Qualification Objective**: The user gives a precise request. The refined ICP criteria and lead records should preserve the hard filters from the request.

3. **Company Discovery**: The tool-call records should show Apify being used for company discovery and should show that the agent respected the lead-count limit.

4. **Website Scraping**: The tool-call records should show Firecrawl, Crawl4AI, or another approved scraping method being used. Lead records should include source URLs and source summaries.

5. **Lead Qualification**: Lead records should include qualification status, confidence score, fit reasons, concerns, and source context.

6. **Outreach Drafting**: Outreach drafts should reference company context from the lead record without inventing facts.

7. **Supabase Logging**: Supabase should contain the run record, lead records, and tool-call records needed to review the agent's work.

Submit the completed testing evidence table from the project page with your project.

## Deliverables

Submit the following:

- A working **application link**
- A **qualified lead list** containing 10 qualified companies
- A generated **outreach sample pack** showing the qualification objective, source context, qualification reasoning, and 3-step cold email sequence for selected leads
- Evidence of the agent's **tool calls and Supabase records**
- Completed **testing evidence**
- A short **Loom video** showing how the agent works
- Answer the questions in your **reflection sheet** for this project
- A **one-page document** explaining how your agent works and how to use it

## Resources

Use the local guidance docs in this folder first:

- [ICP refinement guide](assets/icp-refinement-guide.md)
- [Lead qualification guide](assets/lead-qualification-guide.md)
- [Outbound copywriting guide](assets/outbound-copywriting-guide.md)
- [Lead-list quality guide](assets/lead-list-quality-guide.md)
- [Outreach safety guide](assets/outreach-safety-guide.md)

Use the resources below while designing and building your system:

**Claude Agent SDK**

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)
- [Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

**Company discovery and web research**

- [Apify Actors](https://docs.apify.com/actors)
- [Run Apify Actors](https://docs.apify.com/actors/running)
- [Apify API](https://docs.apify.com/api/v2)
- [Apify JavaScript client](https://docs.apify.com/api/client/js)
- [Firecrawl API introduction](https://docs.firecrawl.dev/api-reference/v2-introduction)
- [Firecrawl scrape endpoint](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Crawl4AI quickstart](https://docs.crawl4ai.com/core/quickstart/)

**Database**

- [Supabase database overview](https://supabase.com/docs/guides/database/overview)
- [Supabase JavaScript client](https://supabase.com/docs/reference/javascript/introduction)
- [Securing your Supabase API](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
