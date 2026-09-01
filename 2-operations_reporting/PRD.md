# Week 2: AI Operations Reporting System

## Introduction

Koya Talent runs several operating teams that track their work in different tools. Sales keeps pipeline activity in Google Sheets. Project Delivery manages client project records in Airtable. People Ops data comes from an internal API.

Leadership needs one reporting system that brings these sources together, calculates useful metrics, highlights operational risks, and keeps a dashboard up to date. The current process depends on manual exports, copy-paste cleanup, and one-off analysis.

Your task is to build an automation that pulls data from these systems, prepares the data for analysis, uses Claude to generate useful operational insights, stores the results in Supabase, and updates a dashboard.

## Project Overview

Here is a high-level overview of how the automation should work:

1. **Trigger Automation**: Your automation should run when the dashboard needs to be updated. You may use a manual trigger, scheduled trigger, webhook, or another trigger that fits your build.
2. **Collect Data**: Pull raw data from each department's source: [Sales (Google Sheets)](https://docs.google.com/spreadsheets/d/153Cvbp30zyOXsLnZVU-5-mGe4eK-8utWxtwbRYuYH4s/edit?gid=0#gid=0) downloaded [here](data/Week%202%20Sales%20Source%20Data%20-%20Sheet1.csv), [Project Delivery (Airtable)](https://airtable.com/appL9cv8takaZy4W1/tblm4DIwiP7n41EUX/viwDUynZnKiqx8qzH?blocks=hide) downloaded [here](data/Week%202%20Project%20Delivery%20Source-Grid%20view.csv), and [People Ops (public mock API)](https://week2-people-ops-api.vercel.app/api/people-ops) downloaded [here](data/people-ops.json) .
3. **Calculate Key Metrics**: Clean and process the collected data to compute the [Week 2 key performance metrics and AI insight requirements](./KPI%20and%20AI%20Insight%20Guide.md).
4. **Generate AI Insights**: Use Claude to analyze the calculated metrics and identify trends, anomalies, risks, and recommended actions.
5. **Update Dashboard**: Store the cleaned records, calculated metrics, and AI insights in Supabase, then update a dashboard that reads from Supabase.

You will be required to use **n8n** to build the automation, **Claude through the n8n integration** for the analysis step, and **Supabase** as the dashboard source of truth. You are free to incorporate any other tools or services that help you achieve the outcome effectively.

### People Ops API

For the People Ops source, use n8n's HTTP Request node to make a `GET` request to the API endpoint. The API returns JSON records.

Optional filters:

- `?start=2026-01-01&end=2026-06-30`
- `?department=Engineering`
- `?status=Exited`

Quick tip: Claude works best when you give it the reporting picture, not every raw row. Use n8n to calculate the core metrics first, then send Claude a short summary with the numbers it needs to analyze. Include obvious issues like blank dates, missing statuses, skipped records, or a department with no data for the selected period.

## Testing

To make sure your automation works reliably, use the following test cases to validate your build before submission:

1. **Source Retrieval Accuracy**: Confirm that the workflow pulls records from Google Sheets, Airtable, and the People Ops API. Check that the records match the source data.
2. **Selected-Period Reporting**: Test at least two reporting periods, such as last 30 days and year to date. Confirm that the dashboard changes when the selected period changes. Anchor your periods to the **30 June 2026 reference date** — see the KPI guide. The source data ends in June 2026, so periods anchored to today's date will return no records.
3. **Metric Calculation Validation**: Manually check a sample of your calculated metrics against the source data. Confirm that the formulas or workflow logic are correct.
4. **Claude Insight Quality**: Confirm that Claude's insights are based on the calculated metrics, not unsupported assumptions. Check that the output includes the required insight fields from the KPI guide.
5. **Supabase and Dashboard Update**: Confirm that the workflow saves the cleaned data, metrics, and AI insights in Supabase and that the dashboard reflects the latest run.
6. **Messy Data Handling**: Test how your workflow handles blank dates, missing statuses, missing amounts, invalid dates, or incomplete records. The workflow should handle these cases cleanly without breaking the full run.

Submit a completed testing evidence table with your project:

| Test case | Expected result | Actual result | Passed? | Notes or fix made |
| --- | --- | --- | --- | --- |
| Source retrieval accuracy |  |  |  |  |
| Selected-period reporting |  |  |  |  |
| Metric calculation validation |  |  |  |  |
| Claude insight quality |  |  |  |  |
| Supabase and dashboard update |  |  |  |  |
| Messy data handling |  |  |  |  |

## Deliverables

Submit the following:

1. **Workflow artifact**
    
    Your n8n workflow export or blueprint.
    
2. **Dashboard**
    
    A working dashboard connected to Supabase.
    
3. **Testing evidence**
    
    Completed testing evidence table.
    
4. **Video walkthrough**
    
    A short Loom video showing the automation in action.
    
5. **Reflection sheet**
    
    Answer the questions in your reflection sheet for this project.
    
    1. **Model-selection note**
        
        A short note explaining which Claude model you used, why you selected it, what alternative you considered, and how you thought about quality, cost, latency, and task complexity.
        
6. **One-page documentation**
    
    Submit one page of documentation for your system.
    

## Resources

Use the resources below to understand the tools and patterns required for this project.

#### Start Here

- n8n intro video
- Optional: n8n Quickstart course
- Work with nodes
- Referencing data in the UI

#### Pull Data From Sources

- Google Sheets node
- Airtable node
- HTTP Request node
- Schedule Trigger node

#### Normalize and Transform Data

- Code node
- Code node cookbook
- Data transformation in n8n

#### Add Claude Analysis

- Get started with Claude
- Claude context windows
- Claude prompt engineering best practices
- Anthropic pricing

#### Store and Display Outputs

- Supabase database overview
- Supabase tables and data
- Supabase Data API
- Supabase Row Level Security
- Securing your Supabase API

#### Test and Debug

- All executions
- n8n evaluations overview

Week 2 KPI and AI Insight Guide