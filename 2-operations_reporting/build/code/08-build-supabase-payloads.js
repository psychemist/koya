// n8n Code node: Build Supabase Payloads
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Build Supabase Payloads                 (Run Once for ALL Items)
//
// Assembles every row this run will write, as arrays ready for PostgREST
// bulk upsert. One item out, seven arrays on it, one HTTP node per array.
//
// WHY UPSERT AND NOT INSERT
// -------------------------
// Every row carries a deterministic natural key:
//
//   report_runs            run_id      = period + window + anchor
//   report_metrics         run_id + domain + metric_key
//   report_insights        run_id
//   report_breakdowns      run_id + domain + breakdown_key + item_key
//   data_quality_warnings  run_id + ordinal
//   sales_records          lead_id
//   delivery_projects      project_id
//   people_records         employee_id
//
// Nothing is derived from a clock or an execution id. Running the same
// period twice rewrites the same rows in place; the dashboard shows one
// report, not two, and a half-finished run that is retried lands exactly
// where the first attempt would have. That is what makes this workflow
// safe to run repeatedly, and it is a property of the KEYS, not of any
// guard node upstream.
//
// The clean records are dimension tables keyed on the business id, so
// re-running a narrow period does not delete or duplicate history - it
// refreshes the rows it touched and leaves the rest alone.
// ============================================================

const metrics = $('Compute Metrics').first().json;

// Read the insight item from THIS node's input rather than by node name, so
// both upstream paths - the Claude branch and the no-data short-circuit -
// converge here without this node needing to know which one ran.
const insightItem = $input.first().json;

let brief = { estimated_input_tokens: null };
try { brief = $('Build Claude Brief').first().json; } catch (e) { /* no-data path */ }

const runId = metrics.run_id;
const now = new Date().toISOString();

// ---- report_runs --------------------------------------------
const reportRun = {
  run_id: runId,
  period_key: metrics.period.key,
  period_label: metrics.period.label,
  period_start: metrics.period.start,
  period_end: metrics.period.end,
  period_days: metrics.period.days,
  reference_date: metrics.period.reference_date,
  compare_label: metrics.period.compare_label,
  compare_start: metrics.period.compare_start,
  compare_end: metrics.period.compare_end,
  run_status: metrics.run_status,
  // Written as 'writing'. The final node in the chain flips it to
  // 'published' once every child table has landed; the dashboard view only
  // shows published runs. A half-finished run is therefore invisible rather
  // than visible-and-empty.
  publish_state: 'writing',
  metrics_hash: metrics.metrics_hash,
  insight_source: insightItem.insight_source,
  model: insightItem.model,
  confidence: insightItem.insights.confidence,
  grounded: insightItem.grounded,
  failure_reason: insightItem.failure_reason,
  source_health: metrics.source_health,
  failed_sources: metrics.failed_sources,
  dq_errors: metrics.data_quality_summary.errors,
  dq_warnings: metrics.data_quality_summary.warnings,
  dq_info: metrics.data_quality_summary.info,
  input_tokens: insightItem.usage.input_tokens,
  output_tokens: insightItem.usage.output_tokens,
  requested_by: metrics.requested_by,
  computed_at: metrics.computed_at,
  updated_at: now,
};

// ---- report_metrics -----------------------------------------
// Long and narrow rather than one wide row per run. A new metric becomes a
// new ROW, not a schema migration and a redeploy of the dashboard - and
// every value arrives with its comparison and its unavailable_reason
// attached, so the dashboard never has to guess why a tile is blank.
const DOMAIN_MAP = { sales: 'sales', delivery: 'project_delivery', people_ops: 'people_ops' };
const reportMetrics = [];
const reportBreakdowns = [];

for (const domainKey of Object.keys(DOMAIN_MAP)) {
  const domain = DOMAIN_MAP[domainKey];
  const block = metrics.metrics[domainKey];
  const trendBlock = metrics.trends[domainKey] || {};

  for (const key of Object.keys(block)) {
    if (key.startsWith('_')) continue;
    const node = block[key];
    if (!node || typeof node !== 'object' || !('value' in node)) continue;

    // Grouped results become breakdown rows, not metric rows - a metric
    // value column holding an array would be unqueryable.
    if (Array.isArray(node.value)) {
      node.value.forEach(function (entry, i) {
        // The item key is the natural key of the row inside its breakdown, so
        // a re-run replaces "Inbound" with "Inbound" and the 24 June bucket
        // with the 24 June bucket. Falling through to the array index would
        // key a bucket on its position, and a window that gains a bucket
        // would silently rewrite every row after it.
        const itemKey = entry.lead_source || entry.team || entry.department ||
          entry.owner || entry.bucket_start || String(i);
        reportBreakdowns.push({
          run_id: runId,
          domain: domain,
          breakdown_key: key,
          item_key: String(itemKey),
          rank: i,
          values: entry,
          updated_at: now,
        });
      });
      continue;
    }

    const trend = trendBlock[key] || {};
    reportMetrics.push({
      run_id: runId,
      domain: domain,
      metric_key: key,
      metric_value: typeof node.value === 'number' ? node.value : null,
      metric_text: typeof node.value === 'number' || node.value === null ? null : String(node.value),
      is_available: node.value !== null,
      unavailable_reason: node.unavailable_reason,
      previous_value: trend.previous === undefined ? null : trend.previous,
      change: trend.change === undefined ? null : trend.change,
      percent_change: trend.percent_change === undefined ? null : trend.percent_change,
      direction: trend.direction || null,
      updated_at: now,
    });
  }
}

// ---- report_insights ----------------------------------------
const reportInsights = {
  run_id: runId,
  insight_source: insightItem.insight_source,
  model: insightItem.model,
  executive_summary: insightItem.insights.executive_summary,
  department_insights: insightItem.insights.department_insights || [],
  risks_and_anomalies: insightItem.insights.risks_and_anomalies,
  recommended_actions: insightItem.insights.recommended_actions,
  ai_data_quality_warnings: insightItem.insights.data_quality_warnings,
  confidence: insightItem.insights.confidence,
  model_confidence_claimed: insightItem.model_confidence_claimed,
  grounded: insightItem.grounded,
  unverified_figures: insightItem.unverified_figures,
  validation_notes: insightItem.validation_notes,
  failure_reason: insightItem.failure_reason,
  stop_reason: insightItem.stop_reason,
  input_tokens: insightItem.usage.input_tokens,
  output_tokens: insightItem.usage.output_tokens,
  estimated_input_tokens: brief.estimated_input_tokens,
  generated_at: insightItem.generated_at,
  updated_at: now,
};

// ---- data_quality_warnings ----------------------------------
// The ordinal makes the key deterministic without a hash. Order is stable
// because the upstream nodes walk the sources in a fixed order, so re-running
// overwrites row 7 with row 7 rather than appending a second copy.
const dqRows = metrics.data_quality.map(function (w, i) {
  return {
    run_id: runId,
    ordinal: i,
    source: w.source === 'delivery' ? 'project_delivery' : w.source,
    severity: w.severity,
    code: w.code,
    record_id: w.record_id,
    message: w.message,
    // Where the issue sits relative to the reporting window. Compute Metrics
    // has already dropped the issues that belong to other windows; these
    // columns are what let the dashboard say WHY a warning is on screen -
    // a record inside the window, a record with no date at all, or the run.
    record_date: w.record_date === undefined ? null : w.record_date,
    scope: w.scope || 'run',
    in_period: w.in_period === undefined ? true : w.in_period,
    updated_at: now,
  };
});

// ---- cleaned records ----------------------------------------
// Stored so a number on the dashboard can be traced to the rows behind it
// WITHOUT opening the source systems - which is what makes the report
// auditable by someone who has no Airtable login.
function clean(nodeName, mapper) {
  try {
    return $(nodeName).all()
      .map(function (i) { return i.json || {}; })
      .filter(function (r) { return !r._empty; })
      .map(mapper);
  } catch (e) { return []; }
}

const salesRecords = clean('Normalize Sales', function (r) {
  return {
    lead_id: r.lead_id,
    lead_date: r.date,
    status: r.status,
    status_raw: r.status_raw,
    deal_amount: r.deal_amount,
    lead_source: r.lead_source,
    spend_month: r.spend_month,
    is_usable: r.usable_for_period,
    record_issues: r.record_issues,
    last_seen_run_id: runId,
    updated_at: now,
  };
});

const deliveryProjects = clean('Normalize Delivery', function (r) {
  return {
    project_id: r.project_id,
    project_name: r.project_name,
    team: r.team,
    owner: r.owner,
    kickoff_date: r.kickoff_date,
    due_date: r.due_date,
    completed_date: r.completed_date,
    status: r.status,
    status_raw: r.status_raw,
    budgeted_cost: r.budgeted_cost,
    actual_cost: r.actual_cost,
    budget_variance: r.budget_variance,
    delay_days: r.delay_days,
    is_usable: r.usable_for_period,
    record_issues: r.record_issues,
    last_seen_run_id: runId,
    updated_at: now,
  };
});

const peopleRecords = clean('Normalize People Ops', function (r) {
  return {
    employee_id: r.employee_id,
    department: r.department,
    role: r.role,
    application_date: r.application_date,
    offer_accepted_date: r.offer_accepted_date,
    start_date: r.start_date,
    exit_date: r.exit_date,
    status: r.status,
    status_raw: r.status_raw,
    time_to_hire_days: r.time_to_hire_days,
    offer_acceptance_days: r.offer_acceptance_days,
    is_usable: r.usable_for_period,
    record_issues: r.record_issues,
    last_seen_run_id: runId,
    updated_at: now,
  };
});

return [{
  json: {
    run_id: runId,
    report_runs: [reportRun],
    report_metrics: reportMetrics,
    report_breakdowns: reportBreakdowns,
    report_insights: [reportInsights],
    data_quality_warnings: dqRows,
    sales_records: salesRecords,
    delivery_projects: deliveryProjects,
    people_records: peopleRecords,
    row_counts: {
      report_metrics: reportMetrics.length,
      report_breakdowns: reportBreakdowns.length,
      data_quality_warnings: dqRows.length,
      sales_records: salesRecords.length,
      delivery_projects: deliveryProjects.length,
      people_records: peopleRecords.length,
    },
  },
}];
