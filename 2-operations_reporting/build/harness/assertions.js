/*
 * Assertion suite for the Koya Ops Reporting metrics engine.
 *
 * Runs the real n8n Code node bodies against the real source files and
 * against deliberately corrupted variants of them. Every assertion is a
 * claim made in the test evidence table, so the table can be regenerated
 * rather than hand-written.
 *
 *   node harness/run.js --assert
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];
let group = '';

function section(name) { group = name; console.log('\n' + name + '\n' + '-'.repeat(name.length)); }

const brief = (x) => {
  const s = JSON.stringify(x);
  return s === undefined ? 'undefined' : (s.length > 90 ? s.slice(0, 87) + '...' : s);
};

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok    ${label}  = ${brief(actual)}`); }
  else { fail++; failures.push(`${group} :: ${label}`); console.log(`  FAIL  ${label}\n          expected ${brief(expected)}\n          actual   ${brief(actual)}`); }
}

function truthy(label, actual) {
  if (actual) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; failures.push(`${group} :: ${label}`); console.log(`  FAIL  ${label} (expected truthy, got ${JSON.stringify(actual)})`); }
}

const v = (m) => (m && m.value !== undefined ? m.value : undefined);

function run(runPipeline, loadSources) {
  const CODE = path.join(__dirname, '..', 'code');
  const { runCodeNode, parseCSV } = require('./run.js');

  // ==========================================================
  section('1. Period resolution — anchored to 30 June 2026, per the KPI guide');
  // ==========================================================
  const p30 = runPipeline({ period: 'last_30d' }).period;
  const p90 = runPipeline({ period: 'last_90d' }).period;
  const pytd = runPipeline({ period: 'ytd' }).period;

  check('last_30d start', p30.period_start, '2026-05-31');
  check('last_30d end', p30.period_end, '2026-06-30');
  check('last_90d start', p90.period_start, '2026-04-01');
  check('ytd start', pytd.period_start, '2026-01-01');
  check('ytd compares against same window in 2025', [pytd.compare_start, pytd.compare_end], ['2025-01-01', '2025-06-30']);
  check('rolling window compares against the window before it', [p30.compare_start, p30.compare_end], ['2026-04-30', '2026-05-30']);
  check('run_id is deterministic', p30.run_id, 'run_last_30d_2026-05-31_2026-06-30_2026-06-30');
  truthy('reference date did not come from the system clock', p30.reference_date === '2026-06-30');

  const custom = runPipeline({ period: 'custom', start: '2026-03-01', end: '2026-03-31' }).period;
  check('custom range honoured', [custom.period_start, custom.period_end], ['2026-03-01', '2026-03-31']);

  const reversed = runPipeline({ period: 'custom', start: '2026-03-31', end: '2026-03-01' }).period;
  check('reversed custom range is swapped, not rejected', [reversed.period_start, reversed.period_end], ['2026-03-01', '2026-03-31']);
  truthy('reversed range raises a warning', reversed.period_warnings.some((w) => w.code === 'REVERSED_CUSTOM_RANGE'));

  const bad = runPipeline({ period: 'custom', start: 'not-a-date', end: '2026-03-01' }).period;
  check('invalid custom range falls back to the default period', bad.period_key, 'last_30d');
  truthy('invalid custom range raises a warning', bad.period_warnings.some((w) => w.code === 'INVALID_CUSTOM_RANGE'));

  const unknown = runPipeline({ period: 'last_year_or_so' }).period;
  check('unknown period falls back to default', unknown.period_key, 'last_30d');

  const envRun = runPipeline({ period: 'last_30d' }, {}, { IKE_KOYA_REFERENCE_DATE: '2025-06-30' }).period;
  check('IKE_KOYA_REFERENCE_DATE sets the anchor', envRun.period_end, '2025-06-30');
  check('and the run records where the anchor came from', envRun.reference_date_source, 'env');

  const todayRun = runPipeline({ period: 'last_30d' }, {}, { IKE_KOYA_REFERENCE_DATE: 'today' }).period;
  check('"today" is a supported value, not a bad date', todayRun.reference_date_source, 'clock');
  truthy('and "today" does not report itself as invalid',
    !todayRun.period_warnings.some((w) => w.code === 'INVALID_REFERENCE_DATE'));

  // There is no hardcoded anchor left in the code node. With nothing set the
  // run must fall through to the clock AND say so loudly -- a silent constant
  // is exactly what was removed.
  const unsetRun = runPipeline({ period: 'last_30d' }, {}, { IKE_KOYA_REFERENCE_DATE: '' }).period;
  check('an unset anchor falls through to the clock', unsetRun.reference_date, new Date().toISOString().slice(0, 10));
  truthy('and the run says the anchor is not configured',
    unsetRun.period_warnings.some((w) => w.code === 'REFERENCE_DATE_NOT_SET' && w.severity === 'error'));

  const badEnvRun = runPipeline({ period: 'last_30d' }, {}, { IKE_KOYA_REFERENCE_DATE: 'last tuesday' }).period;
  truthy('an unparseable anchor is an error, not a silent fallback',
    badEnvRun.period_warnings.some((w) => w.code === 'INVALID_REFERENCE_DATE' && w.severity === 'error'));

  // ==========================================================
  section('2. Metric calculation — hand-checked against the source rows');
  // ==========================================================
  const r30 = runPipeline({ period: 'last_30d' }).metrics;
  const s30 = r30.metrics.sales;

  // 9 dated rows fall in 31 May – 30 Jun 2026: LEAD-1137..1144 plus
  // LEAD-MISS-SOURCE (2026-06-29). LEAD-BAD-DATE (2026-02-30) is excluded.
  check('total leads', v(s30.total_leads), 9);
  check('closed won', v(s30.closed_won_deals), 3);
  check('closed lost', v(s30.closed_lost_deals), 2);
  check('revenue won = 9450 + 11400 + 13350', v(s30.revenue_won), 34200);
  check('pipeline = 8900 + 11840 + 11400 + 7900', v(s30.pipeline_value), 40040);
  check('win rate = 3 / (3 + 2)', v(s30.win_rate), 0.6);

  // The headline trap: one budget per month, repeated on every row.
  // 1 day of May (2100/31 = 67.74) + all of June (2800).
  check('marketing spend is pro-rated, not column-summed', v(s30.marketing_spend), 2867.74);
  check('cost per lead = 2867.74 / 9', v(s30.cost_per_lead), 318.64);

  const rytd = runPipeline({ period: 'ytd' }).metrics;
  check('YTD marketing spend = sum of 6 distinct monthly budgets',
    v(rytd.metrics.sales.marketing_spend), 2300 + 1900 + 2600 + 2400 + 2100 + 2800);
  truthy('a naive column sum would have been ~20x larger',
    291800 / v(rytd.metrics.sales.marketing_spend) > 15);

  const d30 = r30.metrics.delivery;
  check('completed in window (PROJ-2070, PROJ-2072)', v(d30.completed_projects), 2);
  check('both completed late, so on-time rate is 0', v(d30.on_time_completion_rate), 0);
  check('average delay = (5 + 8) / 2', v(d30.average_delay_days), 6.5);
  check('budget variance = (3450-3050) + (4200-3550)', v(d30.budget_variance), 1050);
  check('over-budget projects', v(d30.over_budget_projects), 2);

  const h30 = r30.metrics.people_ops;
  // 92 records − 1 candidate with no start − 5 future starts − 5 exits = 81
  check('active headcount at 30 Jun 2026', v(h30.active_headcount), 81);
  check('exits in window (EMP-3056, 2026-06-10)', v(h30.exits), 1);
  check('accepted offers with a start date after the window', v(h30.accepted_offers_not_yet_started), 5);
  truthy('opening headcount is measured the day before the window opens', v(h30.opening_headcount) === 77);

  const deptTotal = v(h30.headcount_by_department).reduce((a, d) => a + d.active_headcount, 0);
  check('department headcounts reconcile to the total', deptTotal, v(h30.active_headcount));

  const srcTotal = v(s30.revenue_by_lead_source).reduce((a, x) => a + x.revenue_won, 0);
  check('revenue by lead source reconciles to revenue won', srcTotal, v(s30.revenue_won));

  // ==========================================================
  section('3. Selected-period reporting — the numbers actually move');
  // ==========================================================
  const r90 = runPipeline({ period: 'last_90d' }).metrics;
  check('leads differ across the three periods',
    [v(r30.metrics.sales.total_leads), v(r90.metrics.sales.total_leads), v(rytd.metrics.sales.total_leads)],
    [9, 25, 49]);
  truthy('each period produces a distinct run_id',
    new Set([r30.run_id, r90.run_id, rytd.run_id]).size === 3);
  truthy('each period produces a distinct metrics hash',
    new Set([r30.metrics_hash, r90.metrics_hash, rytd.metrics_hash]).size === 3);

  const empty = runPipeline({ period: 'custom', start: '2026-07-01', end: '2026-07-31' }).metrics;
  check('a window past the end of the data returns no leads', v(empty.metrics.sales.total_leads), 0);
  check('win rate on an empty window is unavailable, NOT 0%', v(empty.metrics.sales.win_rate), null);
  truthy('and it says why', /no deals were closed/i.test(empty.metrics.sales.win_rate.unavailable_reason));
  truthy('an empty window is flagged as a data quality warning',
    empty.data_quality.some((d) => d.code === 'EMPTY_PERIOD'));

  // ==========================================================
  section('4. Idempotency — the same input twice produces the same output');
  // ==========================================================
  const a = runPipeline({ period: 'last_90d' }).metrics;
  const b = runPipeline({ period: 'last_90d' }).metrics;
  check('run_id is stable across runs', a.run_id, b.run_id);
  check('metrics_hash is stable across runs', a.metrics_hash, b.metrics_hash);
  check('every metric is byte-identical', JSON.stringify(a.metrics), JSON.stringify(b.metrics));

  const outsA = buildOutputs(runPipeline, 'last_90d');
  const outsB = buildOutputs(runPipeline, 'last_90d');
  const payloadA = runCodeNode('08-build-supabase-payloads.js', outsA['Parse & Validate Insights'], outsA, {});
  const payloadB = runCodeNode('08-build-supabase-payloads.js', outsB['Parse & Validate Insights'], outsB, {});
  const keysOf = (rows, f) => rows.map(f).sort();
  check('report_metrics keys are stable across runs',
    keysOf(payloadA[0].json.report_metrics, (r) => r.run_id + '|' + r.domain + '|' + r.metric_key),
    keysOf(payloadB[0].json.report_metrics, (r) => r.run_id + '|' + r.domain + '|' + r.metric_key));
  truthy('no payload key contains a timestamp or execution id',
    payloadA[0].json.report_metrics.every((r) => !/\d{4}-\d{2}-\d{2}T/.test(r.run_id + r.domain + r.metric_key)));
  truthy('sales records are keyed on lead_id, so a re-run updates in place',
    new Set(payloadA[0].json.sales_records.map((r) => r.lead_id)).size === payloadA[0].json.sales_records.length);

  // ==========================================================
  section('5. Messy data — the five seeded bad records, handled by name');
  // ==========================================================
  const dq = rytd.data_quality;
  const hasCode = (code, id) => dq.some((d) => d.code === code && (!id || d.record_id === id));

  // LEAD-MISS-STATUS (2025-04-29) and LEAD-MISS-AMOUNT (2025-09-28) are dated
  // OUTSIDE the year-to-date window, so 05 deliberately folds them into the
  // one OUTSIDE_SELECTED_PERIOD line rather than listing them against a
  // report they do not affect. Asserting them against `rytd` was asserting
  // that the scoping does not work. Both halves are checked instead: the
  // normalizer flags them, and the period scoping accounts for them without
  // dropping them on the floor.
  const salesIssues = runCodeNode('02-normalize-sales.js', loadSources({}).sales, {}, {})[0].json._source_issues;
  const flagged = (code, id) => salesIssues.some((i) => i.code === code && i.record_id === id);
  truthy('LEAD-MISS-STATUS  blank status flagged', flagged('MISSING_STATUS', 'LEAD-MISS-STATUS'));
  truthy('LEAD-MISS-AMOUNT  blank amount flagged', flagged('MISSING_AMOUNT', 'LEAD-MISS-AMOUNT'));
  truthy('and both are accounted for on a window they fall outside, not silently dropped',
    dq.some((d) => d.code === 'OUTSIDE_SELECTED_PERIOD'
      && /MISSING_AMOUNT x1/.test(d.message) && /MISSING_STATUS x1/.test(d.message)));

  const y2025 = runPipeline({ period: 'custom', start: '2025-01-01', end: '2025-12-31' }).metrics;
  truthy('and on a window that does contain them, they are listed individually',
    y2025.data_quality.some((d) => d.record_id === 'LEAD-MISS-STATUS')
    && y2025.data_quality.some((d) => d.record_id === 'LEAD-MISS-AMOUNT'));
  truthy('LEAD-BAD-DATE     2026-02-30 rejected as a real calendar date', hasCode('INVALID_DATE', 'LEAD-BAD-DATE'));
  truthy('LEAD-MISS-SOURCE  blank lead source flagged', hasCode('MISSING_LEAD_SOURCE', 'LEAD-MISS-SOURCE'));
  truthy('PROJ-MISS-DUE     completed with no due date flagged', hasCode('MISSING_DUE_DATE', 'PROJ-MISS-DUE'));
  truthy('PROJ-MISS-COST    completed with no actual cost flagged', hasCode('MISSING_ACTUAL_COST', 'PROJ-MISS-COST'));
  truthy('EMP-BAD-STATUS    blank status flagged', hasCode('MISSING_STATUS', 'EMP-BAD-STATUS'));

  // The point of the design: flagged AND still counted correctly.
  const ytdSales = rytd.metrics.sales;
  truthy('LEAD-MISS-SOURCE still appears in the revenue breakdown as "Unattributed"',
    v(ytdSales.revenue_by_lead_source).some((x) => x.lead_source === 'Unattributed'));
  check('PROJ-MISS-COST is counted as a completion despite having no cost',
    v(runPipeline({ period: 'custom', start: '2026-05-01', end: '2026-05-31' }).metrics.metrics.delivery.completed_projects) >= 1, true);
  truthy('EMP-BAD-STATUS is still in headcount — dates drive it, not status',
    v(rytd.metrics.people_ops.active_headcount) === 81);

  // ---- injected corruption, beyond what the source ships ----
  const src = loadSources();
  const corruptSales = JSON.parse(JSON.stringify(src.sales));
  corruptSales.push({ json: { date: '2026-06-05', lead_id: 'LEAD-JUNK-AMT', status: 'Closed Won', deal_amount: 'twelve thousand', marketing_spend: '2800', lead_source: 'Inbound' } });
  corruptSales.push({ json: { date: '', lead_id: 'LEAD-NO-DATE', status: 'Qualified', deal_amount: '5000', marketing_spend: '2800', lead_source: 'Event' } });
  corruptSales.push({ json: { date: '2026-06-07', lead_id: 'LEAD-1137', status: 'Closed Won', deal_amount: '9450', marketing_spend: '2800', lead_source: 'Outbound' } });
  corruptSales.push({ json: { date: '2026-06-08', lead_id: 'LEAD-NEG', status: 'Closed Won', deal_amount: '-4000', marketing_spend: '2800', lead_source: 'Partner' } });

  const corrupted = runPipeline({ period: 'last_30d' }, { sales: corruptSales }).metrics;
  truthy('the run completes with corrupted input', corrupted.run_status === 'succeeded');
  truthy('unparseable amount is flagged, not coerced to 0',
    corrupted.data_quality.some((d) => d.record_id === 'LEAD-JUNK-AMT' && d.code === 'MISSING_AMOUNT'));
  truthy('blank date is flagged and excluded from the period',
    corrupted.data_quality.some((d) => d.record_id === 'LEAD-NO-DATE' && d.code === 'BLANK_DATE'));
  truthy('a duplicated lead_id is caught',
    corrupted.data_quality.some((d) => d.record_id === 'LEAD-1137' && d.code === 'DUPLICATE_RECORD'));
  truthy('a negative amount is flagged', corrupted.data_quality.some((d) => d.code === 'NEGATIVE_AMOUNT'));
  check('the duplicate did not double-count revenue',
    v(corrupted.metrics.sales.revenue_won), 34200 - 4000); // +LEAD-NEG, duplicate rejected
  check('lead count includes the junk-amount row but not the undated one',
    v(corrupted.metrics.sales.total_leads), 11);

  const messyStatus = JSON.parse(JSON.stringify(src.delivery));
  messyStatus.push({ json: { project_id: 'PROJ-CASE', project_name: 'Case Test', team: 'Data', owner: 'Mide', kickoff_date: '2026-06-01', due_date: '2026-06-20', completed_date: '2026-06-18', status: 'completed', budgeted_cost: '1000', actual_cost: '900' } });
  messyStatus.push({ json: { project_id: 'PROJ-WEIRD', project_name: 'Weird Status', team: 'Data', owner: 'Mide', kickoff_date: '2026-06-01', due_date: '2026-06-20', completed_date: '', status: 'Halfway-ish', budgeted_cost: '1000', actual_cost: '900' } });
  const messyD = runPipeline({ period: 'last_30d' }, { delivery: messyStatus }).metrics;
  check('lowercase "completed" is normalised and counted', v(messyD.metrics.delivery.completed_projects), 3);
  truthy('an unrecognised status is flagged rather than guessed',
    messyD.data_quality.some((d) => d.record_id === 'PROJ-WEIRD' && d.code === 'UNKNOWN_STATUS'));

  // ==========================================================
  section('6. Source failure — a dead source degrades, it does not crash');
  // ==========================================================
  const noSales = runPipeline({ period: 'last_30d' }, { sales: [{ json: { error: 'Google Sheets: 503 Service Unavailable' } }] }).metrics;
  check('run is marked partial, not succeeded', noSales.run_status, 'partial');
  check('failed source is named', noSales.failed_sources, ['sales']);
  truthy('the source error is recorded as an error-level issue',
    noSales.data_quality.some((d) => d.code === 'SOURCE_ERROR' && d.severity === 'error'));
  truthy('delivery metrics still computed', v(noSales.metrics.delivery.completed_projects) === 2);
  truthy('people ops metrics still computed', v(noSales.metrics.people_ops.active_headcount) === 81);
  check('sales win rate is unavailable rather than 0', v(noSales.metrics.sales.win_rate), null);
  // The counts are the dangerous ones: a ratio with no denominator was
  // already null, but "0 leads" is arithmetic that is both correct and
  // completely misleading when the answer is that nobody counted.
  check('and so is the lead COUNT — a dead source is unknown, not zero', v(noSales.metrics.sales.total_leads), null);
  check('and revenue won', v(noSales.metrics.sales.revenue_won), null);
  truthy('the reason names the system that did not answer',
    /Google Sheets/.test(noSales.metrics.sales.total_leads.unavailable_reason));
  check('the lead source breakdown is empty rather than a row of zeros',
    v(noSales.metrics.sales.revenue_by_lead_source), []);
  check('and the trend chart has nothing to draw rather than a flat line at zero',
    v(noSales.metrics.sales.trend_series), []);
  truthy('nothing can be trended against a window that was never measured',
    noSales.trends.sales.total_leads.direction === 'not_comparable');

  // A source that ANSWERED and had nothing in the window is a real zero, and
  // must stay one — this is the case the rule above must not swallow.
  const quiet = runPipeline({ period: 'custom', start: '2025-01-01', end: '2025-01-02' }).metrics;
  check('a window with no rows in a healthy source is a real zero, not unavailable',
    v(quiet.metrics.sales.total_leads), 0);
  truthy('and it says so in the data quality list',
    quiet.data_quality.some((d) => d.code === 'EMPTY_PERIOD'));

  const allDead = runPipeline({ period: 'last_30d' }, {
    sales: [{ json: { error: 'down' } }],
    delivery: [{ json: { error: 'down' } }],
    people: [{ json: { error: 'down' } }],
  }).metrics;
  check('all three sources down marks the run failed', allDead.run_status, 'failed');

  const truncated = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'people-ops.json'), 'utf8'));
  truncated.records = truncated.records.slice(0, 40); // record_count still says 92
  const short = runPipeline({ period: 'last_30d' }, { people: [{ json: truncated }] }).metrics;
  truthy('a short read is caught by the declared record_count',
    short.data_quality.some((d) => d.code === 'TRUNCATED_RESPONSE' && d.severity === 'error'));

  // ==========================================================
  section('7. Claude response handling — every failure mode is a fixture');
  // ==========================================================
  const outputs = buildOutputs(runPipeline, 'last_30d');
  const allowed = outputs['Build Claude Brief'][0].json.allowed_figures;

  const goodBody = {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 3500, output_tokens: 700 },
    content: [{ type: 'text', text: JSON.stringify({
      executive_summary: 'Revenue won was 34200 across 3 closed-won deals, on a win rate of 60%. Both projects completed in the window landed late.',
      risks_and_anomalies: [{ area: 'project_delivery', severity: 'high', finding: 'On-time completion fell to zero.', evidence: 'on_time_completion_rate = 0 across 2 completions; average delay 6.5 days.' }],
      recommended_actions: [{ area: 'project_delivery', priority: 'high', action: 'Review the 5 blocked projects with team leads this week.', rationale: 'blocked_projects = 5.' }],
      data_quality_warnings: [{ source: 'sales', issue: 'One lead has no source.', impact: 'Revenue by lead source under-attributes to Unattributed.' }],
      confidence: 'high',
    }) }],
  };

  const parseWith = (body) => runCodeNode('07-parse-validate-insights.js', [{ json: body }], outputs, {})[0].json;

  const good = parseWith(goodBody);
  check('a clean response is attributed to Claude', good.insight_source, 'claude');
  check('a clean response is grounded', good.grounded, true);
  check('no unverified figures', good.unverified_figures, []);
  check('confidence is preserved when the figures check out', good.insights.confidence, 'high');

  const hallucinated = JSON.parse(JSON.stringify(goodBody));
  hallucinated.content[0].text = JSON.stringify({
    executive_summary: 'Revenue won was 87650 this period, up from 61200, driven by a 43% lift in outbound.',
    risks_and_anomalies: [], recommended_actions: [], data_quality_warnings: [], confidence: 'high',
  });
  const halluc = parseWith(hallucinated);
  check('invented figures are detected', halluc.grounded, false);
  truthy('and named', halluc.unverified_figures.includes(87650) && halluc.unverified_figures.includes(61200));
  check('confidence is downgraded regardless of what the model claimed', halluc.insights.confidence, 'low');
  check('the model\'s own claim is retained for audit', halluc.model_confidence_claimed, 'high');

  const rounded = JSON.parse(JSON.stringify(goodBody));
  rounded.content[0].text = JSON.stringify({
    executive_summary: 'Marketing spend was 2,868 for the period and cost per lead 318.64.',
    risks_and_anomalies: [], recommended_actions: [], data_quality_warnings: [], confidence: 'medium',
  });
  check('honest rounding (2867.74 written as 2,868) is not flagged', parseWith(rounded).unverified_figures, []);

  const apiError = parseWith({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  check('an API error falls back deterministically', apiError.insight_source, 'deterministic_fallback');
  truthy('the fallback still contains the real numbers', /34,200|34200/.test(apiError.insights.executive_summary));
  truthy('the fallback names the failure', /overloaded/i.test(apiError.failure_reason));
  check('the fallback is forced to low confidence', apiError.insights.confidence, 'low');
  truthy('the fallback still raises the blocked projects', apiError.insights.risks_and_anomalies.some((r) => /blocked/i.test(r.finding)));

  const n8nError = parseWith({ error: 'connect ETIMEDOUT 160.79.104.10:443' });
  check('an n8n error item falls back too', n8nError.insight_source, 'deterministic_fallback');

  const garbage = parseWith({ content: [{ type: 'text', text: 'Sure! Here is the analysis you asked for.' }] });
  check('prose with no JSON falls back', garbage.insight_source, 'deterministic_fallback');

  const fenced = JSON.parse(JSON.stringify(goodBody));
  fenced.content[0].text = '```json\n' + goodBody.content[0].text + '\n```';
  check('a fenced object is recovered', parseWith(fenced).insight_source, 'claude');

  const partial = JSON.parse(JSON.stringify(goodBody));
  partial.content[0].text = JSON.stringify({ executive_summary: 'Short.', confidence: 'medium' });
  const partialOut = parseWith(partial);
  check('missing arrays become empty arrays', [partialOut.insights.risks_and_anomalies, partialOut.insights.recommended_actions], [[], []]);
  truthy('and the omission is recorded', partialOut.validation_notes.length >= 2);

  const badEnum = JSON.parse(JSON.stringify(goodBody));
  badEnum.content[0].text = JSON.stringify({
    executive_summary: 'Fine.',
    risks_and_anomalies: [{ area: 'marketing', severity: 'catastrophic', finding: 'Something.', evidence: 'x' }],
    recommended_actions: [], data_quality_warnings: [], confidence: 'certain',
  });
  const enumOut = parseWith(badEnum);
  check('an out-of-enum area is coerced to a valid one', enumOut.insights.risks_and_anomalies[0].area, 'cross_functional');
  check('an out-of-enum severity is coerced', enumOut.insights.risks_and_anomalies[0].severity, 'medium');
  check('an out-of-enum confidence is coerced', enumOut.model_confidence_claimed, 'medium');

  const configRun = runPipeline({ period: 'last_30d' }).metrics;
  truthy('an unset SUPABASE_URL is reported as a config error',
    configRun.config_errors.some((c) => c.code === 'SUPABASE_URL_NOT_SET'));
  truthy('and is kept OUT of data quality, so it cannot downgrade report confidence',
    !configRun.data_quality.some((d) => d.code === 'SUPABASE_URL_NOT_SET'));

  const refusal = parseWith({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' }, content: [] });
  check('a refusal is handled as a failure, not an empty answer', refusal.insight_source, 'deterministic_fallback');

  const truncatedOut = parseWith(Object.assign({}, goodBody, { stop_reason: 'max_tokens' }));
  truthy('a max_tokens stop is surfaced as a validation note',
    truncatedOut.validation_notes.some((n) => /max_tokens/.test(n)));

  // ==========================================================
  section('8. Supabase payloads — shape and reconciliation');
  // ==========================================================
  const payload = payloadA[0].json;
  check('one report_runs row', payload.report_runs.length, 1);
  check('one report_insights row', payload.report_insights.length, 1);
  truthy('every metric row carries its run_id', payload.report_metrics.every((r) => r.run_id === payload.run_id));
  truthy('breakdowns are separated from scalar metrics',
    payload.report_metrics.every((r) => !Array.isArray(r.metric_value)) && payload.report_breakdowns.length > 0);
  truthy('unavailable metrics travel with their reason',
    payload.report_metrics.filter((r) => !r.is_available).every((r) => Boolean(r.unavailable_reason)));
  check('all 148 sales rows are stored, not just the in-period ones', payload.sales_records.length, 148);
  check('all 74 delivery rows are stored', payload.delivery_projects.length, 74);
  check('all 92 people rows are stored', payload.people_records.length, 92);
  truthy('data quality rows have deterministic ordinals',
    payload.data_quality_warnings.every((r, i) => r.ordinal === i));
  // The payload still carries 'writing'. publish_report() overrides it to
  // 'published' inside the transaction, so the value here is a harmless
  // default rather than a state the database ever observes. Kept as a
  // belt-and-braces default in case the payload is ever written directly.
  check('the payload defaults to unpublished, never to published',
    payload.report_runs[0].publish_state, 'writing');

  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  truthy('the dashboard view shows published runs only, so a half-written run is invisible',
    /latest_report_runs[\s\S]{0,400}publish_state = 'published'/.test(sql));

  // ==========================================================
  section('9. Transactional publish');
  // ==========================================================
  truthy('publish_report exists and is transactional by construction',
    /create or replace function public\.publish_report/.test(sql));
  truthy('publish_report REPLACES the run rather than merging into it, so a re-run cannot leave stale warnings',
    /delete from public\.report_runs where run_id = v_run_id/.test(sql));
  truthy('publish_report sets publish_state itself, inside the transaction',
    /jsonb_build_object\('publish_state', 'published'\)/.test(sql));
  truthy('publish_report names the failing step in its error',
    /publish_report failed at step "%"/.test(sql));
  truthy('record_failed_run forces publish_state to failed, so a failure cannot enter the period selector',
    /jsonb_build_object\('publish_state', 'failed'\)/.test(sql));
  truthy('record_failed_run only stamps the affected period, never rewrites it',
    /set last_failure_at\s+= now\(\),/.test(sql));
  truthy('both functions are execute-revoked from the browser roles',
    /revoke all on function public\.publish_report\(jsonb\)\s+from public, anon, authenticated/.test(sql)
    && /revoke all on function public\.record_failed_run\(jsonb\) from public, anon, authenticated/.test(sql));
  truthy('both functions are granted only to service_role',
    /grant execute on function public\.publish_report\(jsonb\)\s+to service_role/.test(sql)
    && /grant execute on function public\.record_failed_run\(jsonb\) to service_role/.test(sql));
  truthy('security definer functions pin their search_path',
    (sql.match(/set search_path = pg_catalog, public/g) || []).length >= 2);
  // A second CREATE OR REPLACE of this view anywhere in the file would reset
  // its reloptions and silently drop security_invoker, leaving the whole read
  // path running with the view owner's rights. Defining it once is what stops
  // that, so that is what is asserted.
  check('latest_report_runs is defined exactly once, so nothing can reset its security_invoker',
    (sql.match(/create or replace view public\.latest_report_runs/g) || []).length, 1);
  truthy('the staleness columns live on the table, not in a later view rebuild',
    /create table if not exists public\.report_runs[\s\S]*?last_failure_at\s+timestamptz[\s\S]*?\);/.test(sql));
  truthy('an existing database gets the staleness columns too',
    /alter table public\.report_runs add column if not exists last_failure_at/.test(sql));
  truthy('the dashboard view exposes staleness so the banner needs no extra request',
    /r\.last_failure_at,\s*\n\s*r\.last_failure_reason,/.test(sql));

  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'koya-ops-reporting.json'), 'utf8'));
  const nodeNames = wf.nodes.map((n) => n.name);
  truthy('the eight bulk upserts and the publish call are gone',
    !nodeNames.some((n) => n.startsWith('Upsert')) && !nodeNames.includes('Publish Report Run'));
  truthy('one RPC node writes the report', nodeNames.includes('Publish Report (RPC)'));
  truthy('the RPC response is verified rather than assumed', nodeNames.includes('Verify Publish'));
  truthy('the failure path goes through record_failed_run',
    nodeNames.includes('Record Failed Run (RPC)'));
  truthy('the RPC node lets a Postgres error fail the node instead of swallowing it',
    wf.nodes.find((n) => n.name === 'Publish Report (RPC)')
      .parameters.options.response.response.neverError === false);
  truthy('the failure record carries the period it was refreshing',
    wf.nodes.find((n) => n.name === 'Build Failure Record')
      .parameters.jsCode.includes('affected_period_key'));
  truthy('people_records has no anon read policy',
    !/'people_records'[^\n]*\n?[^\n]*anon_read/.test(sql) && sql.includes('people_records deliberately gets NO anon policy'));
  truthy('no anon policy grants anything but select',
    !/create policy[\s\S]{0,120}to anon[\s\S]{0,40}for (insert|update|delete)/i.test(sql));

  // ==========================================================
  section('10. Airtable pagination — the 100-record cliff');
  // ==========================================================
  // Airtable pages at 100 records and hands back an `offset` cursor. The n8n
  // node only follows it when Return All is on; with it off the node stops
  // after one page and returns a 2xx. Nothing in the response says it was
  // truncated, so both halves of the defence are asserted: the node fetches
  // everything, and the normalizer flags a count that lands on a page
  // boundary in case it ever stops.
  truthy('the Airtable node fetches every page, not the first 100',
    wf.nodes.find((n) => n.name === 'Fetch Delivery (Airtable)').parameters.returnAll === true);

  const AIRTABLE_PAGE = 100;
  const oneRow = loadSources({}).delivery[0];
  const exactlyOnePage = Array.from({ length: AIRTABLE_PAGE }, (_, i) => ({
    json: Object.assign({}, oneRow.json, { project_id: 'PROJ-PAGE-' + i }),
  }));
  const truncatedFetch = runPipeline({ period: 'last_30d' }, { delivery: exactlyOnePage }).metrics;
  truthy('exactly 100 delivery records is reported as a probable truncation',
    truncatedFetch.data_quality.some((d) => d.code === 'POSSIBLE_TRUNCATION' && d.severity === 'error'));

  const notAPage = runPipeline({ period: 'last_30d' }).metrics;
  truthy('and a count that is not a page boundary is not flagged',
    !notAPage.data_quality.some((d) => d.code === 'POSSIBLE_TRUNCATION'));

  // ==========================================================
  section('11. Discord report — the full report, inside Discord\'s limits');
  // ==========================================================
  const DISCORD_CAP = 2000;
  const discordOutputs = buildOutputs(runPipeline, 'last_30d');
  discordOutputs['Build Supabase Payloads'] = require('./run.js').runCodeNode(
    '08-build-supabase-payloads.js', discordOutputs['Parse & Validate Insights'], discordOutputs, {});
  const sentRows = discordOutputs['Build Supabase Payloads'][0].json;
  discordOutputs['Verify Publish'] = require('./run.js').runCodeNode('09-verify-publish.js', [{
    json: { ok: true, run_id: sentRows.run_id, publish_state: 'published',
            rows: Object.assign({}, sentRows.row_counts, { report_insights: 1 }) },
  }], discordOutputs, {});

  const discordMsgs = require('./run.js').runCodeNode(
    '10-build-discord-report.js', discordOutputs['Verify Publish'], discordOutputs, {});

  truthy('the report is emitted as one item per Discord message', discordMsgs.length >= 1);
  truthy('every message is under Discord\'s 2000 character cap — an over-length POST is rejected outright, not truncated',
    discordMsgs.every((m) => m.json.content.length <= DISCORD_CAP));
  truthy('multi-part reports are numbered, so a missing message is obvious',
    discordMsgs.length === 1 || discordMsgs.every((m, i) => m.json.content.startsWith('`(' + (i + 1) + '/' + discordMsgs.length + ')`')));

  const wholeReport = discordMsgs.map((m) => m.json.content).join('\n');
  truthy('it carries the period', wholeReport.includes('Last 30 days'));
  truthy('it carries the run id', wholeReport.includes(sentRows.run_id));
  truthy('it carries the executive summary', wholeReport.includes('Placeholder summary used by the harness.'));
  truthy('it carries figures from every domain',
    ['Total leads', 'Active projects', 'Active headcount'].every((k) => wholeReport.includes(k)));
  truthy('money carries no currency symbol or code',
    !/[£$€₦]/.test(wholeReport) && !/\bGBP\b|\bUSD\b|\bNGN\b/.test(wholeReport));
  truthy('a metric that could not be calculated travels with its reason, never as a bare zero',
    !/: \*\*null\*\*/.test(wholeReport));

  // The notification must never be the reason a published, verified run is
  // marked failed — so it has to survive every upstream node being missing.
  let survived = true;
  try {
    require('./run.js').runCodeNode('10-build-discord-report.js', [{ json: {} }], {}, {});
  } catch (e) { survived = false; }
  truthy('it does not throw when every upstream node is unreachable', survived);

  const discordNode = wf.nodes.find((n) => n.name === 'Post Report to Discord');
  truthy('the Discord node exists and is fed by the report builder', Boolean(discordNode));
  truthy('a Discord outage cannot fail a run whose report is already published',
    discordNode.onError === 'continueRegularOutput');
  truthy('no Discord webhook URL is written into the workflow file — it is a bearer secret',
    !JSON.stringify(wf).includes('discord.com/api/webhooks'));
  truthy('Discord is posted AFTER the webhook responds, so a slow third party cannot stall the caller',
    wf.connections['Respond — Report Updated'].main[0].some((c) => c.node === 'Build Discord Report'));

  // ==========================================================
  section('12. No deployment values baked into the workflow');
  // ==========================================================
  const wfText = JSON.stringify(wf);

  // The Claude call is one non-streaming request whose duration is set by how
  // much the model writes — and adaptive thinking writes before it answers.
  // At 120s the year-to-date window timed out, fell back to the rules-based
  // summary, and published a report whose commentary was missing for the
  // period most worth reading. The fallback worked; the ceiling was wrong.
  // The HTTP node, not "Build Claude Brief" — both have Claude in the name,
  // and the Code node has no options to check.
  const claudeNode = wf.nodes.filter(
    (n) => n.type === 'n8n-nodes-base.httpRequest' && /Claude/.test(n.name))[0];
  truthy('the Claude call has a ceiling sized for the widest window, not the narrowest',
    claudeNode && (claudeNode.parameters.options || {}).timeout >= 300000);
  check('and a timeout degrades to the fallback rather than failing the run',
    claudeNode && claudeNode.onError, 'continueRegularOutput');

  truthy('the Supabase URL is read from IKE_SUPABASE_URL', wfText.includes('IKE_SUPABASE_URL'));
  truthy('the reference date is read from IKE_KOYA_REFERENCE_DATE', wfText.includes('IKE_KOYA_REFERENCE_DATE'));
  truthy('no hardcoded Supabase project URL survives anywhere in the export',
    !/https:\/\/[a-z0-9-]+\.supabase\.co/.test(wfText));
  truthy('and no unprefixed env read is left to collide on a shared instance',
    !/\$env\.(SUPABASE_URL|KOYA_REFERENCE_DATE)\b/.test(wfText));

  // ==========================================================
  section('19. Settings resolve on n8n Cloud, where $env is blocked');
  // ==========================================================
  // Cloud does not run on a machine whose process environment you control:
  // Settings -> Variables is the only place a value can live, and reading
  // $env there THROWS. Reading only $env was what produced
  // "Invalid URL: /rest/v1/rpc/publish_report" on a Cloud run — the read
  // threw, the catch returned '', and the URL expression evaluated to a bare
  // path three nodes downstream of the missing setting.
  const cloud = runPipeline({ period: 'last_30d' }, {}, { IKE_KOYA_REFERENCE_DATE: '', IKE_SUPABASE_URL: '' }, {
    IKE_SUPABASE_URL: 'https://cloud-project.supabase.co',
    IKE_KOYA_REFERENCE_DATE: '2026-06-30',
  }).period;
  check('the project URL is found in n8n Variables', cloud.supabase_url, 'https://cloud-project.supabase.co');
  check('so is the reporting anchor', cloud.reference_date, '2026-06-30');
  check('and the run records which of the two places each came from',
    [cloud.config_source.supabase_url, cloud.config_source.reference_date], ['vars', 'vars']);
  truthy('with no config error raised', !cloud.period_warnings.some((w) => w.code === 'SUPABASE_URL_NOT_SET'));

  // Self-hosted: the same settings, the other object.
  const selfHosted = runPipeline({ period: 'last_30d' }, {}, {
    IKE_SUPABASE_URL: 'https://self-hosted.supabase.co', IKE_KOYA_REFERENCE_DATE: '2026-06-30',
  }, {}).period;
  check('the process environment still works where it is readable',
    [selfHosted.supabase_url, selfHosted.config_source.supabase_url],
    ['https://self-hosted.supabase.co', 'env']);

  // Variables win, so a Cloud instance that also has a stale env var behaves
  // the way its UI says it does.
  const both = runPipeline({ period: 'last_30d' }, {}, { IKE_SUPABASE_URL: 'https://from-env.supabase.co' },
    { IKE_SUPABASE_URL: 'https://from-vars.supabase.co' }).period;
  check('Variables take precedence over the environment', both.supabase_url, 'https://from-vars.supabase.co');

  // Unconfigured: the failure has to name itself.
  const unset = runPipeline({ period: 'last_30d' }, {}, { IKE_SUPABASE_URL: '' }, {}).period;
  check('an unset project URL is flagged as a config error', unset.supabase_url_configured, false);
  truthy('and the URL handed to the write nodes names the missing setting rather than being empty',
    /IKE-SUPABASE-URL-IS-NOT-SET/.test(unset.supabase_url));
  truthy('an empty one would have made n8n report a malformed URL instead',
    unset.supabase_url.startsWith('https://'));
  truthy('the message says where to put it on either kind of instance',
    unset.period_warnings.some((w) => w.code === 'SUPABASE_URL_NOT_SET' && /Variables/.test(w.message) && /environment/.test(w.message)));

  // A URL missing its scheme fails exactly like an absent one, so it is
  // caught here rather than in an HTTP node.
  const noScheme = runPipeline({ period: 'last_30d' }, {}, { IKE_SUPABASE_URL: 'abcdefgh.supabase.co' }, {}).period;
  check('a URL with no scheme is rejected rather than passed on', noScheme.supabase_url_configured, false);

  // The failure path reads the same two places — a failure on Cloud that
  // could not find the URL could not even record itself.
  const failureBody = runCodeNode('11-build-failure-record.js', [{ json: { execution: { id: 'e1' }, workflow: { name: 'w' } } }], {}, {},
    { IKE_SUPABASE_URL: 'https://cloud-project.supabase.co' })[0].json;
  check('the failure record resolves its URL from Variables too',
    failureBody.supabase_url, 'https://cloud-project.supabase.co');

  // ==========================================================
  section('13. Last 7 days — the shortest window the dashboard offers');
  // ==========================================================
  const p7 = runPipeline({ period: 'last_7d' });
  check('last_7d window', [p7.period.period_start, p7.period.period_end], ['2026-06-23', '2026-06-30']);
  check('last_7d is 8 dates, inclusive of both ends, like every other rolling window', p7.period.period_days, 8);
  check('last_7d compares against the 8 days before it',
    [p7.period.compare_start, p7.period.compare_end], ['2026-06-15', '2026-06-22']);
  check('last_7d run_id is deterministic', p7.period.run_id, 'run_last_7d_2026-06-23_2026-06-30_2026-06-30');
  truthy('and it returns fewer leads than the 30-day window',
    v(p7.metrics.metrics.sales.total_leads) < v(runPipeline({ period: 'last_30d' }).metrics.metrics.sales.total_leads));

  // ==========================================================
  section('14. Data quality is scoped to the selected period');
  // ==========================================================
  const dq7 = runPipeline({ period: 'last_7d' }).metrics;
  const dqYtd = runPipeline({ period: 'ytd' }).metrics;

  const strayDated = dq7.data_quality.filter((w) =>
    w.record_date && (w.record_date < '2026-06-23' || w.record_date > '2026-06-30'));
  check('no warning about a record dated outside the window is listed', strayDated.length, 0);

  const rollup = dq7.data_quality.filter((w) => w.code === 'OUTSIDE_SELECTED_PERIOD');
  check('the ones that were filtered out are still counted, in one line', rollup.length, 1);
  truthy('and that line says how many', /further source issue/.test(rollup[0].message));
  check('the rollup is info, so it cannot colour the report\'s confidence', rollup[0].severity, 'info');
  check('the summary carries the out-of-window count separately',
    dq7.data_quality_summary.outside_period > 0, true);

  truthy('a wider window surfaces more of the same issues individually',
    dqYtd.data_quality.length > dq7.data_quality.length);

  const undated = dq7.data_quality.filter((w) => w.record_id === 'LEAD-BAD-DATE');
  check('a record with no usable date is shown in every window, not filed under one', undated.length, 1);
  check('and it is labelled as such rather than as an in-window issue', undated[0].scope, 'undated_record');

  const inPeriodCodes = dq7.data_quality.filter((w) => w.scope === 'in_period');
  truthy('in-window issues carry the date that put them there',
    inPeriodCodes.every((w) => w.record_date >= '2026-06-23' && w.record_date <= '2026-06-30'));

  check('the warning badge counts only what is on screen',
    dq7.data_quality_summary.warnings,
    dq7.data_quality.filter((w) => w.severity === 'warning').length);

  // ==========================================================
  section('15. Trend series — the shape of the window');
  // ==========================================================
  const grain = (key) => runPipeline({ period: key }).metrics.trend_grain;
  check('a week is bucketed by day', grain('last_7d'), 'day');
  check('a month is bucketed by week', grain('last_30d'), 'week');
  check('half a year is bucketed by month', grain('ytd'), 'month');

  const m30 = runPipeline({ period: 'last_30d' }).metrics;
  const series30 = v(m30.metrics.sales.trend_series);
  check('the buckets start where the period starts', series30[0].bucket_start, m30.period.start);
  check('and end where it ends', series30[series30.length - 1].bucket_end, m30.period.end);
  check('the most recent bucket is a whole one — a short last bucket draws as a cliff',
    series30[series30.length - 1].partial, false);
  truthy('the short bucket, where there is one, is the first',
    series30.slice(1).every((b) => b.partial === false));

  const contiguous = series30.every((b, i) => {
    if (i === 0) return true;
    const prevEnd = new Date(series30[i - 1].bucket_end + 'T00:00:00Z');
    prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
    return prevEnd.toISOString().slice(0, 10) === b.bucket_start;
  });
  truthy('the buckets tile the window with no gap and no overlap', contiguous);

  const sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
  check('bucketed leads add up to the period total',
    sum(series30, 'leads'), v(m30.metrics.sales.total_leads));
  check('bucketed revenue adds up to revenue won',
    Math.round(sum(series30, 'revenue_won')), Math.round(v(m30.metrics.sales.revenue_won)));
  check('bucketed completions add up to completed projects',
    sum(v(m30.metrics.delivery.trend_series), 'completed'), v(m30.metrics.delivery.completed_projects));
  check('bucketed hires add up to new hires',
    sum(v(m30.metrics.people_ops.trend_series), 'new_hires'), v(m30.metrics.people_ops.new_hires));

  const peopleSeries = v(m30.metrics.people_ops.trend_series);
  check('headcount is a level, so the last bucket matches the headline figure',
    peopleSeries[peopleSeries.length - 1].active_headcount, v(m30.metrics.people_ops.active_headcount));

  // ==========================================================
  section('16. Breakdowns reconcile with the headline figures');
  // ==========================================================
  const bySource = v(m30.metrics.sales.revenue_by_lead_source);
  check('lead sources add up to total leads', sum(bySource, 'leads'), v(m30.metrics.sales.total_leads));
  check('lead sources add up to revenue won',
    Math.round(sum(bySource, 'revenue_won')), Math.round(v(m30.metrics.sales.revenue_won)));
  truthy('a source with nothing decided has no win rate rather than a win rate of zero',
    bySource.every((x) => (x.closed_won + x.closed_lost > 0) === (x.win_rate !== null)));

  const byTeam = v(m30.metrics.delivery.delivery_load_by_team);
  check('teams add up to active projects', sum(byTeam, 'active'), v(m30.metrics.delivery.active_projects));
  check('teams add up to completed projects', sum(byTeam, 'completed'), v(m30.metrics.delivery.completed_projects));
  check('teams add up to blocked projects', sum(byTeam, 'blocked'), v(m30.metrics.delivery.blocked_projects));
  truthy('every blocked project is named, not just counted',
    sum(byTeam, 'blocked') === byTeam.reduce((a, t) => a + t.blocked_items.length, 0));

  const byDept = v(m30.metrics.people_ops.headcount_by_department);
  check('departments add up to active headcount',
    sum(byDept, 'active_headcount'), v(m30.metrics.people_ops.active_headcount));
  check('departments add up to exits', sum(byDept, 'exits'), v(m30.metrics.people_ops.exits));

  // ==========================================================
  section('17. Department sections and named entities');
  // ==========================================================
  const brief30 = runPipeline({ period: 'last_30d' }).brief;
  truthy('the brief lists the real teams, departments and lead sources',
    brief30.allowed_entities.indexOf('Automation') >= 0 && brief30.allowed_entities.indexOf('Engineering') >= 0);
  truthy('the brief carries the bucketed series so trends are measured, not inferred',
    brief30.brief.shape_of_the_period.sales.length > 0);

  const outs17 = runPipeline({ period: 'last_30d' }).nodeOutputs;
  outs17['Build Claude Brief'] = runCodeNode('06-build-claude-brief.js', outs17['Compute Metrics'], outs17, {});

  const reply = (obj) => [{ json: {
    model: 'claude-sonnet-5', stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 100 },
    content: [{ type: 'text', text: JSON.stringify(obj) }],
  } }];

  const full = {
    executive_summary: 'Revenue won was 34,200 across 9 leads.',
    department_insights: [
      { area: 'sales', headline: 'Partner carried it', assessment: 'Partner produced 13,350.',
        what_is_working: 'Partner.', what_needs_attention: 'Event.', priority_action: 'Review Event spend.',
        focus_entities: ['Partner', 'Nowhere Team'] },
      { area: 'project_delivery', headline: 'Late', assessment: 'Both completions were late.',
        what_is_working: '', what_needs_attention: 'Automation.', priority_action: 'Review blockers.',
        focus_entities: ['Automation'] },
    ],
    risks_and_anomalies: [
      { area: 'project_delivery', entity: 'Automation', severity: 'high', finding: 'Blocked work.', evidence: '5 blocked.' },
      { area: 'sales', entity: 'Imaginary Source', severity: 'low', finding: 'Made-up team.', evidence: 'None.' },
    ],
    recommended_actions: [],
    data_quality_warnings: [],
    confidence: 'high',
  };
  const parsedFull = runCodeNode('07-parse-validate-insights.js', reply(full), outs17, {})[0].json;

  check('all three departments get a section, even the one the model skipped',
    parsedFull.insights.department_insights.map((x) => x.area), ['sales', 'project_delivery', 'people_ops']);
  check('the skipped one says so rather than rendering as an empty panel',
    parsedFull.insights.department_insights[2].missing, true);
  truthy('and it is recorded as a validation note',
    parsedFull.validation_notes.some((n) => /People Ops/.test(n)));
  check('a team that exists is kept on the finding',
    parsedFull.insights.risks_and_anomalies[0].entity, 'Automation');
  check('a team that does not exist is dropped rather than shown to whoever it half-matches',
    parsedFull.insights.risks_and_anomalies[1].entity, '');
  check('the same check applies to a section\'s focus list',
    parsedFull.insights.department_insights[0].focus_entities, ['Partner']);
  truthy('the invented names are named in the validation notes',
    parsedFull.validation_notes.some((n) => /Imaginary Source/.test(n)));

  // A figure invented inside a department section must be caught by the same
  // groundedness check as one invented in the summary — the sections carry
  // most of the numbers, so exempting them would exempt most of the report.
  const withBadFigure = JSON.parse(JSON.stringify(full));
  withBadFigure.department_insights[0].assessment = 'Partner produced 987654 in revenue.';
  const parsedBad = runCodeNode('07-parse-validate-insights.js', reply(withBadFigure), outs17, {})[0].json;
  truthy('a figure invented in a department section is flagged',
    parsedBad.unverified_figures.indexOf(987654) >= 0);
  check('and the report is not badged as grounded', parsedBad.grounded, false);

  // The fallback has to fill the same panels, or a failed model call empties
  // three sections of the dashboard with no explanation.
  const parsedFallback = runCodeNode('07-parse-validate-insights.js',
    [{ json: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } }], outs17, {})[0].json;
  check('the rules-based fallback still fills all three department sections',
    parsedFallback.insights.department_insights.map((x) => x.area), ['sales', 'project_delivery', 'people_ops']);
  truthy('and its sections carry the real figures',
    /34,200|34200/.test(parsedFallback.insights.department_insights[0].assessment));

  // ==========================================================
  section('18. What reaches Supabase carries the new columns');
  // ==========================================================
  outs17['Parse & Validate Insights'] = runCodeNode('07-parse-validate-insights.js', reply(full), outs17, {});
  const payload18 = runCodeNode('08-build-supabase-payloads.js',
    outs17['Parse & Validate Insights'], outs17, {})[0].json;

  check('department sections are written with the insights',
    payload18.report_insights[0].department_insights.length, 3);
  truthy('every data quality row says where it sits relative to the window',
    payload18.data_quality_warnings.every((w) => typeof w.in_period === 'boolean' && Boolean(w.scope)));
  const bucketRows = payload18.report_breakdowns.filter((b) => b.breakdown_key === 'trend_series');
  truthy('trend buckets are written as breakdowns', bucketRows.length > 0);
  truthy('and each is keyed on its own start date, not on its position in the array',
    bucketRows.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.item_key)));

  // ==========================================================
  console.log('\n' + '='.repeat(74));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n  Failures:'); failures.forEach((f) => console.log('    - ' + f)); }
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
}

// Re-runs the pipeline and returns the node-output map, with a stubbed
// Claude response already parsed, so nodes 07 and 08 can be exercised.
function buildOutputs(runPipeline, period) {
  const { runCodeNode } = require('./run.js');
  const res = runPipeline({ period });
  const outputs = res.nodeOutputs;
  const stub = {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 3500, output_tokens: 700 },
    content: [{ type: 'text', text: JSON.stringify({
      executive_summary: 'Placeholder summary used by the harness.',
      risks_and_anomalies: [], recommended_actions: [], data_quality_warnings: [], confidence: 'medium',
    }) }],
  };
  outputs['Parse & Validate Insights'] = runCodeNode('07-parse-validate-insights.js', [{ json: stub }], outputs, {});
  return outputs;
}

module.exports = { run };
