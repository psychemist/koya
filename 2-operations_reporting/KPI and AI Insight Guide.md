# Week 2 KPI and AI Insight Guide

The PRD tells you what to build. This guide defines the minimum metrics and AI insight outputs your system should produce.

## Reporting Periods

The dashboard should support selected-period reporting. At minimum, support:

- Last 30 days
- Last 90 days
- Year to date
- Custom date range

Use the selected period to filter source records **before** calculating metrics.

> **Reference date: 30 June 2026.** All three sources cover January 2025 through June 2026. Build your reporting periods as though the report is being run on **30 June 2026**, not today. So "last 30 days" means 31 May – 30 June 2026, "last 90 days" means 1 April – 30 June 2026, and "year to date" means 1 January – 30 June 2026.
> 

> 
> 

> If you anchor your periods to today's date instead, every period will come back empty and your dashboard will look broken when your workflow is actually working correctly.
> 

## Dashboard Output

The dashboard should show:

- Selected reporting period
- Sales metrics
- Project Delivery metrics
- People Ops metrics
- AI-generated executive summary
- AI-generated operational risks or anomalies
- AI-generated recommended actions
- Data quality warnings, where relevant

The dashboard does not need to be visually complex. It should be clear enough for a stakeholder to understand what is happening in the business.

## Sales Metrics

Calculate these for the selected period:

| Metric | Definition |
| --- | --- |
| Total leads | Count of Sales records in the selected period |
| Closed won deals | Count of records where status is `Closed Won` |
| Closed lost deals | Count of records where status is `Closed Lost` |
| Pipeline value | Sum of deal amount for open deals — status `Qualified` or `Proposal Sent` |
| Revenue won | Sum of deal amount for closed won deals |
| Win rate | Closed won deals divided by closed won plus closed lost deals |
| Marketing spend | Sum or period-adjusted total marketing spend |
| Cost per lead | Marketing spend divided by total leads |
| Revenue by lead source | Revenue won grouped by lead source |

If a calculation cannot be completed because of missing data, record the issue as a data quality warning.

## Project Delivery Metrics

Calculate these for the selected period:

| Metric | Definition |
| --- | --- |
| Active projects | Count of projects in progress or blocked during the selected period |
| Completed projects | Count of projects completed during the selected period |
| Blocked projects | Count of projects with `Blocked` status |
| On-time completion rate | Completed projects finished on or before due date divided by completed projects with due dates |
| Average delay | Average days between due date and completed date for late completed projects |
| Budget variance | Actual cost minus budgeted cost |
| Over-budget projects | Count of completed projects where actual cost exceeds budgeted cost |
| Delivery load by team | Active and completed projects grouped by team |

If a project is missing a due date, completed date, or actual cost, keep the record and add a data quality warning.

## People Ops Metrics

Calculate these for the selected period:

| Metric | Definition |
| --- | --- |
| Applications | Count of applications created in the selected period |
| Offers accepted | Count of records with an offer accepted date in the selected period |
| New hires | Count of records with a start date in the selected period |
| Exits | Count of records with an exit date in the selected period |
| Active headcount | Count of employees active at the end of the selected period |
| Time to hire | Average days from application date to start date |
| Offer acceptance time | Average days from application date to offer accepted date |
| Attrition rate | Exits divided by active headcount at the start of the selected period |
| Headcount by department | Active headcount grouped by department |

For selected-period dashboards, avoid labels like "this month" unless the selected period is actually a calendar month. Use labels such as `New hires`, `Exits`, and `Active headcount`.

## Required AI Insight Output

Claude should receive the calculated metrics and a short data quality summary, and return structured insights for the selected period.

At minimum, the AI output should include:

| Field | Description |
| --- | --- |
| Executive summary | A short summary of what changed or matters most in the selected period |
| Operational risks or anomalies | Any unusual trend, underperformance, spike, missing data pattern, or delivery risk |
| Recommended actions | Concrete next steps a manager could take |
| Data quality warnings | Any source issues that affect confidence in the report |

The number of risks, anomalies, or recommended actions can vary. If there are no meaningful issues, Claude should say that clearly instead of forcing a list.

## Department-Specific Insight Prompts

Phrase the prompt in your own way, but Claude should be able to answer questions like these.

### Sales

- Which lead sources produced the strongest revenue?
- Did win rate improve, decline, or stay roughly stable for the selected period?
- Is marketing spend producing enough pipeline or revenue?
- Are any records missing fields that affect sales calculations?

### Project Delivery

- Which teams or owners appear overloaded?
- Are blocked projects increasing?
- Are projects finishing late or going over budget?
- Which delivery issue should the team address first?

### People Ops

- Is hiring volume enough to support business activity?
- Are exits concentrated in any department?
- Is time to hire increasing or decreasing?
- Which People Ops data issues reduce confidence in the report?

## Data Quality Notes

Track obvious source issues, including:

- Blank dates
- Invalid dates
- Missing status
- Missing amount or cost
- Records skipped from a calculation
- Departments with no records for the selected period

These notes should be stored in Supabase and summarised in the dashboard.