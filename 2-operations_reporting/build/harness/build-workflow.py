#!/usr/bin/env python3
"""
Assembles koya-ops-reporting.json from the Code node bodies in ../code.

The workflow JSON is GENERATED, never hand-edited, so the JavaScript that
runs in n8n is the same text the harness tests and the same text a reviewer
reads in ../code. Editing the JSON by hand would let those three drift apart,
which is exactly how a "tested" workflow ships untested code.

    python3 harness/build-workflow.py
"""
import json
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CODE = ROOT / "code"
OUT = ROOT / "koya-ops-reporting.json"

# There is NO baked "local" copy any more, and no placeholder literals to
# bake into. Every deployment value the Code nodes need is read from the
# instance environment:
#
#     IKE_SUPABASE_URL            https://<project-ref>.supabase.co
#     IKE_KOYA_REFERENCE_DATE     2026-06-30, or "today" once sources are live
#
# The build used to emit a second file with those values substituted in, for
# instances where $env is blocked (n8n Cloud sets N8N_BLOCK_ENV_ACCESS_IN_NODE
# by default). That file carried the real project ref inside a Code node, in
# a workflow export people paste around — a project identifier baked into
# nine copies of a JSON blob is a thing nobody can rotate. If $env is blocked
# on the target instance, unblock it or set the two variables in the n8n UI;
# an unset variable now announces itself in period_warnings on every run
# instead of hiding behind a literal that happens to be right today.
SUPABASE = "={{ $('Resolve Reporting Period').first().json.supabase_url }}"


def js(name):
    return (CODE / name).read_text()


nodes = []
connections = {}


def node(name, ntype, pos, params, tv=1, **extra):
    n = {"parameters": params, "name": name, "type": ntype,
         "typeVersion": tv, "position": pos, "id": name.lower().replace(" ", "-")[:36]}
    n.update(extra)
    nodes.append(n)
    return name


def wire(src, dst, out_index=0, in_index=0):
    c = connections.setdefault(src, {"main": []})
    while len(c["main"]) <= out_index:
        c["main"].append([])
    c["main"][out_index].append({"node": dst, "type": "main", "index": in_index})


def code_node(name, filename, pos, notes=None):
    return node(name, "n8n-nodes-base.code", pos,
                {"mode": "runOnceForAllItems", "jsCode": js(filename)},
                tv=2, notes=notes, notesInFlow=False)


def if_node(name, expr, pos, notes=None):
    return node(name, "n8n-nodes-base.if", pos, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": name.lower().replace(" ", "-")[:20],
                "leftValue": expr,
                "rightValue": "",
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    }, tv=2.2, notes=notes)


def supabase_upsert(name, table, conflict, payload_key, pos, notes=None):
    """PostgREST bulk upsert.

    `resolution=merge-duplicates` is what makes every write idempotent: a
    row whose natural key already exists is UPDATED, not rejected and not
    duplicated. `return=minimal` keeps the response empty, so a 92-row write
    does not drag 92 rows back through the workflow.
    """
    return node(name, "n8n-nodes-base.httpRequest", pos, {
        "method": "POST",
        "url": f"{SUPABASE}/rest/v1/{table}?on_conflict={conflict}",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "supabaseApi",
        "sendHeaders": True,
        "headerParameters": {"parameters": [
            {"name": "Content-Type", "value": "application/json"},
            {"name": "Prefer", "value": "resolution=merge-duplicates,return=minimal"},
        ]},
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($('Build Supabase Payloads').first().json."
                    + payload_key + ") }}",
        "options": {"timeout": 60000, "response": {"response": {"neverError": False}}},
    }, tv=4.2, notes=notes, retryOnFail=True, maxTries=3, waitBetweenTries=3000,
       alwaysOutputData=True)


# ============================================================
# TRIGGERS
# ============================================================
node("Every Morning at 06:00", "n8n-nodes-base.scheduleTrigger", [-1120, 40],
     {"rule": {"interval": [{"triggerAtHour": 6}]}}, tv=1.2,
     notes="Once a day, not once an hour. The sources are updated daily at best, so a "
           "tighter schedule would re-run identical numbers and pay for identical Claude "
           "calls. The freshness check downstream means even this run costs nothing when "
           "nothing has moved.")

# allowedOrigins is what makes the dashboard's "Run report" button work at
# all. The button POSTs from the page's own origin, so without an
# Access-Control-Allow-Origin header on the webhook the browser blocks the
# request before n8n ever sees it -- and it fails in a way that looks like a
# dead workflow rather than a policy decision: the preflight OPTIONS gets no
# CORS headers, fetch() rejects, and n8n's execution list stays empty because
# nothing arrived. Nothing in the n8n UI reports it either.
#
# "*" because the dashboard opens from wherever it is served -- a static
# host, a laptop, file:// during the demo -- and a wrong single origin fails
# exactly as silently. It is not the access control here; the URL is, and it
# is published to every viewer the moment N8N_WEBHOOK_URL is set. Narrow this
# to the real origin, and add Header Auth, before this is reachable from
# anywhere but your own network.
node("Dashboard Refresh Webhook", "n8n-nodes-base.webhook", [-1120, 220], {
    # Both methods, because the two callers are shaped differently and neither
    # should have to care: the dashboard button POSTs a JSON body, while a
    # human testing from a terminal or a browser reaches for a GET with a
    # query string. Resolve Reporting Period merges query and body already
    # (body wins), so the same run happens either way.
    "multipleMethods": True,
    "httpMethod": ["GET", "POST"],
    "path": "koya-report-run",
    "responseMode": "responseNode",
    "options": {"allowedOrigins": "*"},
}, tv=2, webhookId="koya-report-run",
   notes="GET ?period=last_30d or POST { period, start, end, force, requested_by }. "
         "responseMode is 'responseNode', which means n8n REQUIRES a reachable, enabled "
         "Respond to Webhook node on every path out of here - if one is missing or "
         "disabled the call fails with 'No Respond to Webhook node found in the "
         "workflow'. build-workflow.py asserts that at build time. CORS is open so the "
         "dashboard button can reach it; put it behind Header Auth before this is "
         "reachable from outside your own network - see the one-pager.")

node("Run Manually", "n8n-nodes-base.manualTrigger", [-1120, 380], {}, tv=1,
     notes="For the demo and for debugging. Uses the default period.")

# ============================================================
# PERIOD + FRESHNESS
# ============================================================
code_node("Resolve Reporting Period", "01-resolve-reporting-period.js", [-880, 220],
          notes="The ONLY node that decides dates, and the only node that resolves the "
                "Supabase base URL. Both come from the instance environment - "
                "IKE_KOYA_REFERENCE_DATE and IKE_SUPABASE_URL - with no literal fallback in "
                "the code. Set IKE_KOYA_REFERENCE_DATE=2026-06-30 while the sources are the "
                "sample dataset: they end there, and anchoring to the real clock returns "
                "empty windows that make a working dashboard look broken. An unset variable "
                "is reported on the run rather than papered over.")

node("Fetch Previous Run", "n8n-nodes-base.httpRequest", [-640, 40], {
    "url": f"{SUPABASE}/rest/v1/report_runs",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "supabaseApi",
    "sendQuery": True,
    "queryParameters": {"parameters": [
        {"name": "run_id", "value": "=eq.{{ $json.run_id }}"},
        {"name": "select", "value": "run_id,metrics_hash,insight_source,run_status"},
    ]},
    "options": {"timeout": 20000},
}, tv=4.2, alwaysOutputData=True, onError="continueRegularOutput",
   retryOnFail=True, maxTries=2, waitBetweenTries=2000,
   notes="Reads the stored fingerprint for THIS period. On Error = Continue: if Supabase "
         "is unreachable we assume the report is stale and rebuild it, which is the safe "
         "direction to fail in.")

# ============================================================
# SOURCES (parallel)
# ============================================================
node("Fetch Sales (Google Sheets)", "n8n-nodes-base.googleSheets", [-400, -140], {
    "documentId": {"__rl": True, "value": "153Cvbp30zyOXsLnZVU-5-mGe4eK-8utWxtwbRYuYH4s", "mode": "id"},
    "sheetName": {"__rl": True, "value": "gid=0", "mode": "list", "cachedResultName": "Sheet1"},
    "options": {},
}, tv=4.5, alwaysOutputData=True, onError="continueRegularOutput",
   retryOnFail=True, maxTries=3, waitBetweenTries=3000,
   notes="On Error = Continue, so a Sheets outage produces an error ITEM the normalizer "
         "turns into a named data quality error, instead of killing the run and leaving "
         "the dashboard silently stale.")

node("Fetch Delivery (Airtable)", "n8n-nodes-base.airtable", [-400, 40], {
    "operation": "search",
    "base": {"__rl": True, "value": "appL9cv8takaZy4W1", "mode": "id"},
    "table": {"__rl": True, "value": "tblm4DIwiP7n41EUX", "mode": "id"},
    "returnAll": True,
    "options": {},
}, tv=2.1, alwaysOutputData=True, onError="continueRegularOutput",
   retryOnFail=True, maxTries=3, waitBetweenTries=3000,
   notes="returnAll = TRUE, and it is load-bearing. Airtable's API returns at most 100 "
         "records per response plus an `offset` cursor; the node only follows that cursor "
         "when Return All is on. With it off the node stops after one page, returns 100 "
         "records and a 2xx, and reports success - no error, no warning, and no total in "
         "the response to compare against. This table holds 74 records today, so the bug "
         "would stay invisible until the 101st project, then silently understate every "
         "delivery metric at once. Normalize Delivery carries a POSSIBLE_TRUNCATION guard "
         "for exactly that reason: a record count that is an exact multiple of 100 is "
         "flagged, because it is far more likely to be a truncated fetch than a "
         "coincidence.")

node("Fetch People Ops (API)", "n8n-nodes-base.httpRequest", [-400, 220], {
    "url": "https://week2-people-ops-api.vercel.app/api/people-ops",
    "options": {"timeout": 30000, "response": {"response": {"neverError": False}}},
}, tv=4.2, alwaysOutputData=True, onError="continueRegularOutput",
   retryOnFail=True, maxTries=3, waitBetweenTries=3000,
   notes="Deliberately UNFILTERED. The API supports ?start=&end=, but the five People Ops "
         "metrics key off five different date fields - headcount needs people who started "
         "in 2025 - so one server-side range cannot serve them all. 92 records is one "
         "request; correctness is worth more than the bytes.")

code_node("Normalize Sales", "02-normalize-sales.js", [-160, -140],
          notes="Types every row, keeps the bad ones, and tags each with its spend month. "
                "Never coerces a missing amount to zero.")
code_node("Normalize Delivery", "03-normalize-delivery.js", [-160, 40],
          notes="Handles the UTF-8 BOM on the first CSV header, and computes each project's "
                "live span for the period overlap test.")
code_node("Normalize People Ops", "04-normalize-people-ops.js", [-160, 220],
          notes="Unrolls the API envelope and cross-checks the declared record_count, so a "
                "silently truncated response is caught rather than under-reporting headcount.")

node("Wait for All Sources", "n8n-nodes-base.merge", [80, 40],
     {"numberInputs": 3}, tv=3,
     notes="A synchronisation point, not a data join. Compute Metrics reads each source by "
           "node name; this node only guarantees all three have finished first.")

code_node("Compute Metrics", "05-compute-metrics.js", [320, 40],
          notes="Every number on the dashboard is produced here, deterministically, with no "
                "model involved. Runs twice - selected period and comparison window - so "
                "trends are measured rather than guessed.")

# ============================================================
# FRESHNESS + DATA GUARDS
# ============================================================
# The invariant, and the only safe way to write this test: SKIP ONLY WHEN A
# PRIOR FINGERPRINT WAS ACTUALLY READ AND IT MATCHES. Everything else --
# fetch failed, node returned nothing, expression threw -- is "changed".
#
# The obvious form of this condition (`!prev.run_id || prev.metrics_hash !==
# $json.metrics_hash || ...`) reads correctly and is wrong, because it leans
# on undefined-chaining through a node that is allowed to fail. Fetch
# Previous Run runs with onError: continueRegularOutput, so on a failure it
# emits its INPUT item -- the Resolve Reporting Period output, which carries
# a run_id and no metrics_hash. Both hashes then read as undefined, undefined
# !== undefined is false, and every clause collapses to false: the run is
# declared unchanged because Supabase was unreachable. And if the node emits
# no item at all, .first().json throws, and looseTypeValidation coerces the
# thrown expression to false -- the same wrong branch by a second route.
#
# Both failures land on the answer that does nothing and reports success,
# which is the one answer a freshness guard must never give by accident.
# So: read defensively, and require positive evidence to skip.
if_node("Report Changed?",
        "={{ (function () {"
        " var p;"
        " try { p = $('Fetch Previous Run').first().json || {}; } catch (e) { p = {}; }"
        " if ($json.force_refresh === true) return true;"
        " if (p.error) return true;"                      # fetch failed
        " if (!p.run_id || !p.metrics_hash) return true;"  # nothing published yet
        " if (p.run_id !== $json.run_id) return true;"     # a different window's row
        " if (p.insight_source === 'deterministic_fallback') return true;"
        " if (p.run_status === 'failed') return true;"     # last attempt died
        " return p.metrics_hash !== $json.metrics_hash;"
        " })() }}",
        [560, 40],
        notes="THE COST CONTROL. Re-running a period whose numbers have not moved skips "
              "Claude and skips every write. Fails OPEN: if the previous run cannot be "
              "read for any reason, the report is treated as changed and rebuilt. A "
              "previous run that fell back to the deterministic summary, or failed, is "
              "deliberately treated as stale, so a transient outage self-heals on the "
              "next scheduled run.")

if_node("Any Data To Report?", "={{ $json.run_status !== 'failed' }}", [800, -60],
        notes="When all three sources are down there is nothing to analyse. Paying a model "
              "to summarise nothing is the definition of a wasted call, so the run "
              "short-circuits to the deterministic path and still records a failed run.")

code_node("Build Claude Brief", "06-build-claude-brief.js", [1040, -160],
          notes="~3.5k tokens of finished figures, not 313 raw rows. Also emits "
                "allowed_figures, the list the parse node checks the model's prose against.")

node("Claude — Generate Insights", "n8n-nodes-base.httpRequest", [1280, -160], {
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "anthropicApi",
    "sendHeaders": True,
    "headerParameters": {"parameters": [
        {"name": "anthropic-version", "value": "2023-06-01"},
        {"name": "content-type", "value": "application/json"},
    ]},
    "sendBody": True,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify($json.request_body) }}",
    # 5 minutes, not 2. This is ONE non-streaming request whose duration is
    # set by how much the model writes, and adaptive thinking on Sonnet 5
    # writes before it answers: on the year-to-date window - the widest one,
    # and the one that asks for three department sections on top of the
    # summary - thinking plus output ran past the 120s ceiling and the node
    # reported a timeout. The failure was well handled (two tries, then the
    # deterministic fallback, and the report still published) but the
    # commentary was lost for the period most likely to be demoed.
    #
    # Raising the ceiling costs nothing when it is not reached; it is a
    # safety net, not a budget. The knob for cost and latency is
    # output_config.effort in Build Claude Brief.
    "options": {"timeout": 300000, "response": {"response": {"neverError": False}}},
}, tv=4.2, onError="continueRegularOutput", retryOnFail=True, maxTries=2, waitBetweenTries=5000,
   alwaysOutputData=True,
   notes="claude-sonnet-5 via n8n's Anthropic credential - the API key is never in this "
         "node, this export, or the browser. Never Error is OFF: after 2 tries a real "
         "failure becomes an error item the parse node turns into the deterministic "
         "fallback. Timeout is 300s: this is one non-streaming request and adaptive "
         "thinking runs before the answer, so the widest window (year to date, three "
         "department sections) exceeded a 120s ceiling. NOTE: do not add temperature - it "
         "is removed on Sonnet 5 and returns a 400. Determinism comes from the JSON "
         "schema instead.")

node("No Usable Data", "n8n-nodes-base.set", [1040, 60], {
    "assignments": {"assignments": [{
        "id": "reason", "name": "error", "type": "string",
        "value": "=All three sources were unreachable, so no analysis was requested. Failed sources: {{ $json.failed_sources.join(', ') }}",
    }]},
    "options": {},
}, tv=3.4,
   notes="Shaped like a failed Claude call on purpose, so the parse node's existing "
         "fallback path handles it and there is only one place that builds a fallback.")

code_node("Parse & Validate Insights", "07-parse-validate-insights.js", [1520, -60],
          notes="The gate. Validates the shape, checks every figure in the prose against "
                "the numbers Claude was actually given, caps the confidence badge at what "
                "that check supports, and falls back deterministically rather than failing.")

code_node("Build Supabase Payloads", "08-build-supabase-payloads.js", [1760, -60],
          notes="Seven arrays, every row carrying a natural key. This is where the "
                "re-runnability actually lives.")

# ============================================================
# WRITES — ordered, because the child tables reference report_runs
# ============================================================
# ============================================================
# THE WRITE — one transactional RPC
#
# This replaced eight bulk upserts plus a ninth call to flip publish_state.
# Those nine calls were nine separate transactions: a chain that died at
# table six left the first five written under a run_id that never published.
# Nothing read them, but nothing removed them either. They were also UPSERTS,
# so a row an earlier attempt wrote and this one does not kept its place —
# meaning a re-run after fixing the source data left the fixed warnings
# sitting in the data quality panel.
#
# publish_report() does the lot in one transaction and REPLACES the run's
# child rows rather than merging into them. It commits everything or changes
# nothing, and the previous report survives either way.
#
# Still the Supabase Data API — /rest/v1/rpc/ is PostgREST, same credential.
# ============================================================
node("Publish Report (RPC)", "n8n-nodes-base.httpRequest", [2000, 100], {
    "method": "POST",
    "url": f"{SUPABASE}/rest/v1/rpc/publish_report",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "supabaseApi",
    "sendHeaders": True,
    "headerParameters": {"parameters": [
        {"name": "Content-Type", "value": "application/json"},
    ]},
    "sendBody": True,
    "specifyBody": "json",
    # The payload node's item, wrapped as the function's single argument.
    # Addressed by name rather than $json so the expression does not depend
    # on what happens to sit upstream.
    "jsonBody": "={{ JSON.stringify({ payload: $('Build Supabase Payloads').first().json }) }}",
    # neverError:false so a 4xx/5xx from Postgres becomes a failed node and
    # reaches the error trigger, instead of a green run that wrote nothing.
    "options": {"timeout": 120000, "response": {"response": {"neverError": False}}},
}, tv=4.2, retryOnFail=True, maxTries=3, waitBetweenTries=3000,
   alwaysOutputData=True,
   notes="ONE TRANSACTION. Every table, or none of them. A failure here rolls back "
         "completely and leaves the previous published report exactly as it was — the "
         "dashboard never sees a half-written update. The function also DELETES this "
         "run's existing child rows before inserting, so a re-run after a source fix "
         "cannot leave stale data quality warnings behind. Returns a row count per "
         "table, which Verify Publish checks rather than trusting the 2xx.")

# A 2xx means Postgres accepted the call. It does not mean the rows the
# workflow built are the rows that landed. The function returns its own
# counts; this compares them against what was sent.
code_node("Verify Publish", "09-verify-publish.js", [2240, 100],
          notes="Compares the row counts Postgres reports back against the payload that "
                "was sent. A 2xx means the call was accepted, not that the right rows landed.")

node("Respond — Report Updated", "n8n-nodes-base.respondToWebhook", [2480, 100], {
    "respondWith": "json",
    "responseBody": "={{ JSON.stringify({ status: 'updated', "
                    "run_id: $('Compute Metrics').first().json.run_id, "
                    "period: $('Compute Metrics').first().json.period.label, "
                    "run_status: $('Compute Metrics').first().json.run_status, "
                    "insight_source: $('Parse & Validate Insights').first().json.insight_source, "
                    "confidence: $('Parse & Validate Insights').first().json.insights.confidence, "
                    "grounded: $('Parse & Validate Insights').first().json.grounded, "
                    "data_quality: $('Compute Metrics').first().json.data_quality_summary, "
                    "rows_written: $('Build Supabase Payloads').first().json.row_counts }) }}",
    "options": {},
}, tv=1.1,
   notes="The response is a receipt, not an acknowledgement. It names what was written and "
         "how far the result can be trusted, so a caller can tell a real update from a "
         "degraded one without opening n8n.")

# ============================================================
# NOTIFY — after the response, never before it
#
# The webhook caller is a browser waiting on a fetch. Discord is a third
# party that can be slow or down, and putting it in front of the response
# would make a Discord outage read to the caller as a failed report -- when
# the report was published, verified, and is already on the dashboard.
#
# So it hangs off Respond -- Report Updated: the caller is answered, THEN
# the channel is told. n8n keeps executing after a Respond node, so nothing
# is lost by responding first.
# ============================================================
code_node("Build Discord Report", "10-build-discord-report.js", [2720, 100],
          notes="Composes the whole published report as Discord markdown and emits ONE ITEM "
                "PER MESSAGE. A Discord message body is capped at 2000 characters and Discord "
                "rejects an over-length POST outright rather than truncating it - so a "
                "single-message design would fail on exactly the runs with the most to say. "
                "Splits on line boundaries under a 1900 character budget, numbers the parts, "
                "and caps the total at 6 messages. Every upstream read is wrapped: this is a "
                "notification, and it must never be the reason a published, verified run is "
                "marked failed.")

# The Discord node runs once per input item, and n8n preserves item order,
# so the numbered parts arrive in sequence.
#
# authentication: "webhook" means a channel webhook URL held in an n8n
# credential -- no bot, no gateway, no OAuth app, and no token anywhere in
# this export. It is the right shape for a one-way notification.
node("Post Report to Discord", "n8n-nodes-base.discord", [2960, 100], {
    "authentication": "webhook",
    "content": "={{ $json.content }}",
    "options": {},
}, tv=2, retryOnFail=True, maxTries=2, waitBetweenTries=3000,
   onError="continueRegularOutput",
   notes="On Error = Continue, deliberately. A Discord outage must not fail a run whose "
         "report is already published and verified in Supabase - the dashboard is the "
         "record, this is the announcement. Attach a Discord Webhook credential holding "
         "the channel's webhook URL; the URL is a bearer secret (anyone holding it can "
         "post to the channel) so it lives in the credential store, never in this file.")

node("Nothing To Update", "n8n-nodes-base.noOp", [800, 200], {}, tv=1,
     notes="Terminal, and the cheapest possible outcome: no model call, no writes.")

node("Respond — Unchanged", "n8n-nodes-base.respondToWebhook", [1040, 200], {
    "respondWith": "json",
    "responseBody": "={{ JSON.stringify({ status: 'unchanged', "
                    "run_id: $('Compute Metrics').first().json.run_id, "
                    "period: $('Compute Metrics').first().json.period.label, "
                    "reason: 'The source data has not changed since the last run for this period. "
                    "Nothing was re-analysed and nothing was rewritten.' }) }}",
    "options": {},
}, tv=1.1)

# ============================================================
# ERROR PATH
# ============================================================
node("On Workflow Error", "n8n-nodes-base.errorTrigger", [320, 600], {}, tv=1,
     notes="Set this workflow as its own Error Workflow in Settings. Without this, an "
           "unhandled failure is visible only to whoever opens the executions list.")

code_node("Build Failure Record", "11-build-failure-record.js", [560, 600],
          notes="Records the failure AS A REPORT RUN, so a broken run is visible on the "
                "dashboard rather than only in n8n's execution log. A stale dashboard that "
                "looks healthy is worse than one that says it is stale. Reads IKE_SUPABASE_URL "
                "from the instance environment with no literal fallback: if it is unset the "
                "RPC 404s and the failure is loud in the execution log, which beats a "
                "hardcoded URL filing failure records against whichever project this workflow "
                "was exported from.")

node("Record Failed Run (RPC)", "n8n-nodes-base.httpRequest", [800, 600], {
    "method": "POST",
    "url": "={{ $json.supabase_url }}/rest/v1/rpc/record_failed_run",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "supabaseApi",
    "sendHeaders": True,
    "headerParameters": {"parameters": [
        {"name": "Content-Type", "value": "application/json"},
    ]},
    "sendBody": True,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ payload: { report_runs: $json.rows, "
                "affected_period_key: $json.affected_period_key } }) }}",
    "options": {"timeout": 30000},
}, tv=4.2, retryOnFail=True, maxTries=2, waitBetweenTries=3000, onError="continueRegularOutput",
   notes="Records the failure WITHOUT touching the report it failed to refresh. The "
         "function forces publish_state='failed', so the failure can never appear in the "
         "dashboard's period selector, and only stamps last_failure_at/reason on the "
         "affected period. Yesterday's report stays on screen and says it is stale — an "
         "outage at 6am is not a reason to blank a dashboard.")

# ============================================================
# CONNECTIONS
# ============================================================
for t in ["Every Morning at 06:00", "Dashboard Refresh Webhook", "Run Manually"]:
    wire(t, "Resolve Reporting Period")

wire("Resolve Reporting Period", "Fetch Previous Run")
wire("Fetch Previous Run", "Fetch Sales (Google Sheets)")
wire("Fetch Previous Run", "Fetch Delivery (Airtable)")
wire("Fetch Previous Run", "Fetch People Ops (API)")

wire("Fetch Sales (Google Sheets)", "Normalize Sales")
wire("Fetch Delivery (Airtable)", "Normalize Delivery")
wire("Fetch People Ops (API)", "Normalize People Ops")

wire("Normalize Sales", "Wait for All Sources", 0, 0)
wire("Normalize Delivery", "Wait for All Sources", 0, 1)
wire("Normalize People Ops", "Wait for All Sources", 0, 2)

wire("Wait for All Sources", "Compute Metrics")
wire("Compute Metrics", "Report Changed?")

wire("Report Changed?", "Any Data To Report?", 0)     # true
wire("Report Changed?", "Nothing To Update", 1)        # false
wire("Nothing To Update", "Respond — Unchanged")

wire("Any Data To Report?", "Build Claude Brief", 0)   # true
wire("Any Data To Report?", "No Usable Data", 1)       # false

wire("Build Claude Brief", "Claude — Generate Insights")
wire("Claude — Generate Insights", "Parse & Validate Insights")
wire("No Usable Data", "Parse & Validate Insights")

wire("Parse & Validate Insights", "Build Supabase Payloads")

write_chain = [
    "Build Supabase Payloads", "Publish Report (RPC)", "Verify Publish",
    "Respond — Report Updated",
]
for a, b in zip(write_chain, write_chain[1:]):
    wire(a, b)

wire("Respond — Report Updated", "Build Discord Report")
wire("Build Discord Report", "Post Report to Discord")

wire("On Workflow Error", "Build Failure Record")
wire("Build Failure Record", "Record Failed Run (RPC)")

# ============================================================
# BUILD-TIME GUARD
#
# responseMode 'responseNode' makes the Respond to Webhook node part of the
# contract, not a nicety: n8n refuses the call with "No Respond to Webhook
# node found in the workflow" if it cannot reach an enabled one. That is a
# wiring mistake, and a wiring mistake should fail here rather than at 6am
# against a live URL.
# ============================================================
def assert_webhook_paths_respond():
    RESPOND = "n8n-nodes-base.respondToWebhook"
    kind = {n["name"]: n["type"] for n in nodes}
    disabled = {n["name"] for n in nodes if n.get("disabled")}
    nxt = {}
    for src, conn in connections.items():
        for out in conn.get("main", []):
            for t in out:
                nxt.setdefault(src, []).append(t["node"])

    webhooks = [n["name"] for n in nodes if n["type"] == "n8n-nodes-base.webhook"]
    dead = []

    # The requirement is that a path PASSES THROUGH an enabled Respond node,
    # not that it ends at one. Work continues after the response -- the
    # Discord report is posted there on purpose, so the caller is not left
    # waiting on a third party -- and an earlier version of this check read
    # "ends at" and failed the moment that was added. Once a Respond node is
    # reached the path is satisfied and there is nothing further to prove,
    # so the walk stops there.
    def walk(node, path, responded):
        if not responded and kind.get(node) == RESPOND and node not in disabled:
            return                   # this path responds; done
        onward = nxt.get(node, [])
        if not onward:
            dead.append(" -> ".join(path))
            return
        for t in onward:
            if t in path:            # a loop cannot be a terminus
                continue
            walk(t, path + [t], responded)

    for w in webhooks:
        walk(w, [w], False)

    if dead:
        raise SystemExit(
            "BUILD FAILED - these paths leave a webhook without reaching an enabled "
            "Respond to Webhook node:\n  " + "\n  ".join(dead))
    print(f"webhook check: OK ({len(webhooks)} webhook, every path responds)")


assert_webhook_paths_respond()

workflow = {
    "name": "Koya Talent — AI Operations Reporting",
    "nodes": nodes,
    "connections": connections,
    "settings": {
        "executionOrder": "v1",
        "saveManualExecutions": True,
        "saveDataErrorExecution": "all",
        "saveDataSuccessExecution": "all",
        "executionTimeout": 900,
        # Set this to THIS workflow's own id after import so the Error Trigger fires.
        "errorWorkflow": "",
    },
    "pinData": {},
    "meta": {"instanceId": "koya-week2"},
    "tags": [],
}

text = json.dumps(workflow, indent=2, ensure_ascii=False)
OUT.write_text(text)
print(f"wrote {OUT.relative_to(ROOT.parent)}  ({len(nodes)} nodes, {os.path.getsize(OUT):,} bytes)")

# --- sanity checks on the generated graph --------------------
names = {n["name"] for n in nodes}
problems = []
for src, conn in connections.items():
    if src not in names:
        problems.append(f"connection from unknown node: {src}")
    for group in conn["main"]:
        for c in group:
            if c["node"] not in names:
                problems.append(f"connection to unknown node: {c['node']}")

triggers = {"Every Morning at 06:00", "Dashboard Refresh Webhook", "Run Manually", "On Workflow Error"}
targets = {c["node"] for conn in connections.values() for g in conn["main"] for c in g}
for n in names - triggers - targets:
    problems.append(f"orphan node (nothing connects to it): {n}")

for n in nodes:
    if n["type"] == "n8n-nodes-base.code":
        body = n["parameters"]["jsCode"]
        if "return" not in body:
            problems.append(f"code node has no return: {n['name']}")

print("graph check:", "OK" if not problems else "PROBLEMS")
for p in problems:
    print("  -", p)
