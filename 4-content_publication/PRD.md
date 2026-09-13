# Week 4 PRD: AI Content Research and Publishing Agent

## Introduction

The content team at a Koya Talent marketing agency creates and publishes content across LinkedIn, X, and an email newsletter.

The current workflow includes brainstorming content ideas, researching source material, creating SEO articles, adapting the selected article for each channel, reviewing the final content internally, and publishing or scheduling it for release.

The process works, but it takes too much manual effort to scale while keeping quality, tone, and factual accuracy consistent.

Your task is to build an AI content research and publishing agent that helps the team move from a raw idea or source URL to reviewed, channel-ready content.

The automation should begin when a content manager submits a content request. At minimum, the request should include a raw content idea, the target audience, and any supporting material or source URL. You may decide what other inputs to collect and how the content manager should submit them.

The system should research the topic, retrieve relevant source material, choose the sources or excerpts that matter, plan the content, generate article options, evaluate its own output, revise weak drafts, and prepare the selected content for LinkedIn, X, and an email newsletter.

Generated articles should follow the [SEO best practices](assets/seo-best-practices.md). Channel-specific outputs should follow the [platform formatting rules](assets/channel-formatting-rules.md).

The system should include a review step where a human can approve, reject, revise, or select content before publishing or scheduling. The final content should stay grounded in reviewed source material, and the system should make it clear which sources informed the output.

You may use n8n, custom code, Claude API, Claude through n8n, a backend application, a simple front-end, search or scraping tools, a retrieval system, a database, a publishing queue, or any other tools that fit your implementation.

## Testing

To make sure your automation works reliably, test it against the following scenarios before submission:

1. **Raw Idea Request**: A content request with only a topic or idea should produce relevant article options.

2. **URL-Based Request**: A content request with a source URL should extract useful source material and use it in the generated content.

3. **Research and Source Grounding**: The system should show which sources informed the output and avoid claims that are not supported by the available material.

4. **Evaluation and Revision Loop**: The system should evaluate draft quality using the [content evaluation rubric](assets/content-evaluation-rubric.md), revise weak sections, and preserve the review history.

5. **Human Approval**: The system should not publish or schedule content until a human approves it.

6. **Channel Formatting**: The selected article should be adapted into LinkedIn, X, and newsletter formats that follow the formatting rules.

7. **Publishing or Scheduling**: Approved content should be published, scheduled, or saved into a clear publishing queue.

8. **Failure Handling**: If research, retrieval, generation, evaluation, approval, publishing, or logging fails, the system should make the failure clear enough to debug.

Submit the completed testing evidence table from the project page with your project.

## Deliverables

Submit the following:

- A working **front-end or application link**
- A generated **content sample pack** that shows the input given to the system and the outputs it produced, including the article, LinkedIn post, X post, email newsletter, and source list
- Completed **testing evidence**
- A short **Loom video** showing how the automation works
- Answer the questions in your **reflection sheet** for this project
- A **one-page document** explaining how your automation works and how to use it

## Resources

Use the local assets in this folder first:

- [SEO best practices](assets/seo-best-practices.md)
- [Platform formatting rules](assets/channel-formatting-rules.md)
- [Content evaluation rubric](assets/content-evaluation-rubric.md)

Use the resources below while designing and building your system:

**Claude and AI generation**

- [Get started with Claude](https://platform.claude.com/docs/en/get-started)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)

**Research, scraping, and retrieval**

- [Firecrawl API introduction](https://docs.firecrawl.dev/api-reference/v2-introduction)
- [Firecrawl scrape endpoint](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Crawl4AI quickstart](https://docs.crawl4ai.com/core/quickstart/)
- [Supabase AI and Vectors](https://supabase.com/docs/guides/ai)
- [Supabase vector columns](https://supabase.com/docs/guides/ai/vector-columns)

**Optional workflow automation**

- [n8n HTTP Request node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
- [n8n Code node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code/)
- [n8n executions](https://docs.n8n.io/workflows/executions/all-executions/)
