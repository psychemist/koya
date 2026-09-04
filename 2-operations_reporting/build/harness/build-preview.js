#!/usr/bin/env node
/*
 * Builds dashboard/preview.html — the real dashboard, with a real report
 * inlined instead of a live Supabase fetch.
 *
 * Two jobs:
 *   1. Lets anyone see the dashboard before Supabase exists.
 *   2. Proves the dashboard reads the same field names the workflow writes.
 *      It assembles the `dashboard_latest` row from the ACTUAL Supabase
 *      payloads the workflow produces, then asserts that every field the
 *      dashboard looks up is present. A rename in the pipeline breaks this
 *      script rather than silently blanking a tile in production.
 *
 *   node harness/build-preview.js
 */

const fs = require('fs');
const path = require('path');
const { runPipeline, runCodeNode } = require('./run.js');

const ROOT = path.join(__dirname, '..');

// A stand-in for the model's reply. It is clearly labelled as a sample in
// the generated page — a preview must never be mistaken for a real run.
const SAMPLE_INSIGHT = {
  executive_summary:
    'Sample commentary — this preview ships a fixed example so the page can be reviewed without a live Claude call. '
    + 'Delivery is the story this period: both projects completed landed late, so on-time completion is 0% and the '
    + 'average overrun was 6.5 days, while 5 projects sit blocked. Sales held steady at a 60% win rate on 34,200 of '
    + 'revenue won, and People Ops added 5 hires against 1 exit.',
  department_insights: [
    { area: 'sales',
      headline: 'Partner and Referral carried the revenue; Event returned nothing',
      assessment:
        'Sample commentary. 9 leads produced 3 closed won and 2 closed lost, a 60% win rate on a base of five decided deals — '
        + 'directional rather than conclusive. Revenue won was 34,200 with 40,040 still open. Partner alone accounted for 13,350 of the revenue. '
        + 'Cost per lead was 318.64 against a pro-rated spend of 2,867.74.',
      what_is_working: 'Partner leads converted at the highest value in the window, at 13,350 from two leads.',
      what_needs_attention: 'Event produced 2 leads and no revenue while marketing spend ran across the whole window.',
      priority_action: 'Ask Marketing to review Event spend against its return before the next budget cycle.',
      focus_entities: ['Partner', 'Event'] },
    { area: 'project_delivery',
      headline: 'Every completion landed late and 5 projects sit blocked',
      assessment:
        'Sample commentary. Both projects completed in the window missed their due date, so on-time completion is 0% and the average overrun '
        + 'was 6.5 days. Five projects are blocked, two of them on Automation. Completed work also came in 1,050 over budget across two costed projects.',
      what_is_working: 'Client Ops and Data each still closed work inside the window.',
      what_needs_attention: 'Automation carries 2 of the 5 blocked projects against 3 active, and completed nothing.',
      priority_action: 'Run a blocker review with the four team leads before the next sprint.',
      focus_entities: ['Automation'] },
    { area: 'people_ops',
      headline: 'Hiring outpaced exits, 5 hires against 1 exit',
      assessment:
        'Sample commentary. Headcount closed the window at 81 after 5 new hires and 1 exit, an attrition rate of 1.3%. '
        + 'Time to hire averaged 33 days. Five accepted offers have start dates after the window and are not counted as headcount.',
      what_is_working: 'Engineering added 2 people and lost none.',
      what_needs_attention: 'Five accepted offers have not started, so current headcount understates committed capacity.',
      priority_action: 'Ask People Ops to confirm start dates for the five accepted offers.',
      focus_entities: ['Engineering'] },
  ],
  risks_and_anomalies: [
    { area: 'project_delivery', entity: '', severity: 'high',
      finding: 'Every project completed in this window finished late.',
      evidence: 'on_time_completion_rate = 0 across 2 completions with a due date; average delay 6.5 days. Two completions is a small base, so treat the rate as directional.' },
    { area: 'project_delivery', entity: 'Automation', severity: 'medium',
      finding: 'Five projects are blocked, two of them on the Automation team.',
      evidence: 'blocked_projects = 5; Automation carries 2 of them against 3 active.' },
    { area: 'sales', entity: 'Event', severity: 'low',
      finding: 'Event-sourced leads produced no closed-won revenue this period.',
      evidence: '2 Event leads, 0 closed won, 0 revenue.' },
  ],
  recommended_actions: [
    { area: 'project_delivery', entity: '', priority: 'high',
      action: 'Run a blocker review with the four team leads before the next sprint.',
      rationale: 'blocked_projects = 5 with no completions from AI Apps or Automation this period.' },
    { area: 'project_delivery', entity: 'Automation', priority: 'medium',
      action: 'Re-baseline due dates for work in flight, then track slippage weekly.',
      rationale: 'Both completions ran over by an average of 6.5 days.' },
    { area: 'sales', entity: 'Unattributed', priority: 'low',
      action: 'Ask Sales to backfill the missing lead source on one lead in this window.',
      rationale: 'One lead in this period has no source and is grouped under "Unattributed".' },
  ],
  data_quality_warnings: [
    { source: 'sales', issue: 'One lead has no status and one has no deal amount.',
      impact: 'Win rate and revenue won each exclude one record, so both are marginally understated.' },
    { source: 'project_delivery', issue: 'One completed project has no actual cost.',
      impact: 'Budget variance is calculated across fewer projects than completed.' },
  ],
  confidence: 'medium',
};

function buildRow(periodKey) {
  const res = runPipeline({ period: periodKey });
  const outputs = res.nodeOutputs;

  const claudeResponse = {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 3490, output_tokens: 640 },
    content: [{ type: 'text', text: JSON.stringify(SAMPLE_INSIGHT) }],
  };

  outputs['Parse & Validate Insights'] =
    runCodeNode('07-parse-validate-insights.js', [{ json: claudeResponse }], outputs, {});
  const payloads = runCodeNode('08-build-supabase-payloads.js',
    outputs['Parse & Validate Insights'], outputs, {})[0].json;

  const run = payloads.report_runs[0];
  const ins = payloads.report_insights[0];

  // Exactly the column list the dashboard_latest view produces.
  return {
    run_id: run.run_id,
    period_key: run.period_key,
    period_label: run.period_label,
    period_start: run.period_start,
    period_end: run.period_end,
    period_days: run.period_days,
    reference_date: run.reference_date,
    compare_label: run.compare_label,
    run_status: run.run_status,
    confidence: run.confidence,
    grounded: run.grounded,
    insight_source: run.insight_source,
    model: run.model,
    failure_reason: run.failure_reason,
    source_health: run.source_health,
    failed_sources: run.failed_sources,
    compare_start: run.compare_start,
    compare_end: run.compare_end,
    dq_errors: run.dq_errors,
    dq_warnings: run.dq_warnings,
    dq_info: run.dq_info,
    updated_at: run.updated_at,
    executive_summary: ins.executive_summary,
    department_insights: ins.department_insights,
    risks_and_anomalies: ins.risks_and_anomalies,
    recommended_actions: ins.recommended_actions,
    ai_data_quality_warnings: ins.ai_data_quality_warnings,
    unverified_figures: ins.unverified_figures,
    validation_notes: ins.validation_notes,
    metrics: payloads.report_metrics,
    breakdowns: payloads.report_breakdowns,
    data_quality: payloads.data_quality_warnings,
  };
}

const rows = {
  last_7d: buildRow('last_7d'),
  last_30d: buildRow('last_30d'),
  last_90d: buildRow('last_90d'),
  ytd: buildRow('ytd'),
};

// ---- contract check -----------------------------------------
// Every metric key and breakdown key the dashboard looks up must exist in
// what the workflow writes. This is the check that stops a rename in the
// pipeline from silently blanking a tile nobody notices for a month.
const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
const wantedMetrics = [...html.matchAll(/metrics\['([a-z_]+)\.([a-z_]+)'\]/g)].map((m) => m[1] + '.' + m[2]);
const wantedBreakdowns = [...html.matchAll(/breakdowns\['([a-z_]+)\.([a-z_]+)'\]/g)].map((m) => m[1] + '.' + m[2]);

const haveMetrics = new Set(rows.last_30d.metrics.map((m) => m.domain + '.' + m.metric_key));
const haveBreakdowns = new Set(rows.last_30d.breakdowns.map((b) => b.domain + '.' + b.breakdown_key));

const missing = [
  ...wantedMetrics.filter((k) => !haveMetrics.has(k)).map((k) => 'metric ' + k),
  ...wantedBreakdowns.filter((k) => !haveBreakdowns.has(k)).map((k) => 'breakdown ' + k),
];

console.log(`dashboard reads ${new Set(wantedMetrics).size} metrics and ${new Set(wantedBreakdowns).size} breakdowns`);
console.log(`workflow writes ${haveMetrics.size} metrics and ${haveBreakdowns.size} breakdowns`);
if (missing.length) {
  console.error('\nCONTRACT BROKEN — the dashboard asks for keys the workflow does not write:');
  missing.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('contract check: OK — every key the dashboard reads is written by the workflow');

const unused = [...haveMetrics].filter((k) => !wantedMetrics.includes(k));
if (unused.length) console.log('\nstored but not shown on the dashboard (fine — available for ad-hoc queries):\n  ' + unused.join('\n  '));

// ---- write the preview --------------------------------------
const banner = `
  <div class="notice info" style="margin-bottom:16px">
    <strong>Offline preview</strong>
    <div>Real metrics and real data quality warnings, calculated by the workflow from the source
    files. The AI commentary is a fixed sample, not a live Claude call. Use the period buttons —
    the numbers change. Point <code>index.html</code> at Supabase for the live version.</div>
  </div>`;

const preview = html
  // The preview is a single self-contained file and never touches Supabase,
  // so the generated config.js it would load does not exist beside it — and
  // must not, since config.js is gitignored while preview.html is committed.
  // Drop the tag and stand in an empty config, so the page boots clean
  // instead of logging a 404 for a file nobody was meant to ship.
  .replace(
    '<script src="config.js"></script>',
    '<script>window.KOYA_CONFIG = {};</script>'
  )
  .replace(
    /loadPeriod\('last_30d'\);/,
    'renderFixture("last_30d");'
  )
  .replace(
    /\/\/ ---- boot ---------------------------------------------------/,
    `// ---- offline fixture (preview build only) -------------------
const FIXTURES = ${JSON.stringify(rows)};
function renderFixture(key) {
  if (!FIXTURES[key]) {
    $('notices').innerHTML = '';
    $('report').classList.add('hidden');
    $('periodLine').textContent = 'Not in this preview.';
    return notice('info', 'Not in the offline preview',
      'The preview ships the four preset periods. Custom ranges need the live dashboard against Supabase.');
  }
  state.period = key;
  document.querySelectorAll('#controls button[data-period]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.period === key)));
  $('notices').innerHTML = '';
  $('trust').innerHTML = '';
  $('notices').insertAdjacentHTML('beforeend', ${JSON.stringify(banner)});
  render(FIXTURES[key]);
}
loadPeriod = renderFixture;

// ---- boot ---------------------------------------------------`
  )
  .replace('let state =', 'let loadPeriod; let state =')
  .replace('async function loadPeriod(periodKey) {', 'async function liveLoadPeriod(periodKey) {')
  .replace('<title>Koya Talent — Operations Report</title>',
           '<title>Koya Talent — Operations Report (preview)</title>');

fs.writeFileSync(path.join(ROOT, 'dashboard', 'preview.html'), preview);
console.log('\nwrote dashboard/preview.html — open it in a browser, no Supabase needed');
