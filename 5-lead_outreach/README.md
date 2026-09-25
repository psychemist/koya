# Week 5: AI Lead Research and Outreach Agent

This folder contains the Week 5 project brief and reference docs for the build.

## Files

- `PRD.md`: the project brief, as issued
- `PRD5-extended.md`: the spec. Extends the brief with the decisions it leaves open: budget enforcement, the untrusted-content architecture, qualification evidence rules, copy gates, hosting, cost model, notifications, failure modes, and a 21-row testing bar
- `assets/icp-refinement-guide.md`: guidance for turning vague targeting into clear ICP criteria
- `assets/lead-qualification-guide.md`: guidance for judging whether a company fits the ICP
- `assets/outbound-copywriting-guide.md`: guidance for writing review-ready outbound copy
- `assets/lead-list-quality-guide.md`: guidance for checking list quality before submission
- `assets/outreach-safety-guide.md`: guidance for safe agent behavior and approval rules

Start with `PRD.md`, then read `PRD5-extended.md` for what gets built.

The files in `assets/` are the source material for the Claude Agent SDK skills. Their finished `SKILL.md` form lives in `build/agent-workspace/.claude/skills/`.

The build itself is in `build/`, and `build/.env.example` documents every environment variable it needs. `render.yaml` in this folder deploys it as two Render services.
