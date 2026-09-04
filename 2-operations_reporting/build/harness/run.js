#!/usr/bin/env node
/*
 * Local verification harness.
 *
 * Runs the ACTUAL n8n Code node bodies from ../code against the real source
 * files, outside n8n. Nothing is re-implemented here: the files executed are
 * byte-for-byte the ones pasted into the workflow, so a number printed by
 * this harness is a number the workflow produces.
 *
 * It exists because "I checked it in the n8n UI" is not evidence anyone can
 * re-run, and because a metrics engine that can only be tested by clicking
 * Execute Workflow is a metrics engine nobody will ever refactor safely.
 *
 *   node harness/run.js                 # all periods, summary tables
 *   node harness/run.js --period ytd    # one period
 *   node harness/run.js --json          # full metrics payload as JSON
 *   node harness/run.js --brief         # the exact payload sent to Claude
 *   node harness/run.js --assert        # run the assertion suite, exit 1 on failure
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = path.join(__dirname, '..', 'code');
const DATA = path.join(__dirname, '..', '..', 'data');
// ---- minimal n8n runtime ------------------------------------
// Implements only the surface the Code nodes actually touch:
// $input.all(), $('Node Name').all()/.first(), $env, and the item shape.
function runCodeNode(file, inputItems, nodeOutputs, env, vars) {
  const src = fs.readFileSync(path.join(CODE, file), 'utf8');

  const $input = {
    all: () => inputItems,
    first: () => inputItems[0],
  };

  const $ = (name) => {
    if (!(name in nodeOutputs)) {
      const err = new Error(`No node named "${name}" has produced output`);
      err.isN8nNodeMissing = true;
      throw err;
    }
    return {
      all: () => nodeOutputs[name],
      first: () => nodeOutputs[name][0],
    };
  };

  // $vars is n8n Cloud's Settings -> Variables; $env is the process
  // environment, which Cloud blocks. A Code node reads whichever exists, so
  // the harness has to be able to present either — including neither, which
  // is the unconfigured case the assertions cover.
  const sandbox = { $input, $, $env: env || {}, $vars: vars || {}, console, JSON, Math, Date, Number, String, Object, Array, Set, Boolean, isNaN, parseInt, parseFloat };
  sandbox.global = sandbox;

  // The node body ends in `return [...]`, which is only legal inside a
  // function — so wrap it in one, exactly as n8n does.
  const script = new vm.Script(`(function(){\n${src}\n})()`);
  return script.runInNewContext(vm.createContext(sandbox), { timeout: 15000 });
}

// ---- source loaders -----------------------------------------
// Deliberately dumb CSV parsing that mirrors what the Google Sheets and
// Airtable nodes hand over: strings, with blanks preserved as ''.
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] === undefined ? '' : cells[i]; });
    return { json: row };
  });
}

function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function loadSources(overrides = {}) {
  const sales = overrides.sales
    || parseCSV(fs.readFileSync(path.join(DATA, 'Week 2 Sales Source Data - Sheet1.csv'), 'utf8'));
  const delivery = overrides.delivery
    || parseCSV(fs.readFileSync(path.join(DATA, 'Week 2 Project Delivery Source-Grid view.csv'), 'utf8'));
  const people = overrides.people
    || [{ json: JSON.parse(fs.readFileSync(path.join(DATA, 'people-ops.json'), 'utf8')) }];
  return { sales, delivery, people };
}

// ---- full pipeline ------------------------------------------
// The reference date is CONFIGURATION, not a constant in the code node --
// 01-resolve-reporting-period.js has no hardcoded date and falls through to
// the real clock when nothing is set. So the harness has to supply what n8n
// supplies, and the anchor lives here, in the test fixture, where it belongs:
// the sample sources end on 30 June 2026, so every assertion about a window
// is written against that date.
//
// IKE_SUPABASE_URL is deliberately NOT defaulted. An unset project URL is
// meant to be reported as a config error on the run, and there is an
// assertion that checks exactly that.
const HARNESS_ENV = { IKE_KOYA_REFERENCE_DATE: '2026-06-30' };

function runPipeline(triggerBody, overrides = {}, env = {}, vars = null) {
  const nodeOutputs = {};
  const src = loadSources(overrides);
  // Per-call env wins, so a test can still assert what an unset or invalid
  // anchor does by passing it explicitly. Passing `vars` puts the settings
  // where n8n Cloud puts them instead — and passing {} for env with it is how
  // a test reproduces Cloud, where reading the process environment is blocked.
  env = Object.assign({}, HARNESS_ENV, env);

  nodeOutputs['Resolve Reporting Period'] =
    runCodeNode('01-resolve-reporting-period.js', [{ json: triggerBody }], nodeOutputs, env, vars);

  nodeOutputs['Normalize Sales'] =
    runCodeNode('02-normalize-sales.js', src.sales, nodeOutputs, env);

  nodeOutputs['Normalize Delivery'] =
    runCodeNode('03-normalize-delivery.js', src.delivery, nodeOutputs, env);

  nodeOutputs['Normalize People Ops'] =
    runCodeNode('04-normalize-people-ops.js', src.people, nodeOutputs, env);

  nodeOutputs['Compute Metrics'] =
    runCodeNode('05-compute-metrics.js', [{ json: {} }], nodeOutputs, env);

  const metrics = nodeOutputs['Compute Metrics'][0].json;

  let brief = null;
  if (fs.existsSync(path.join(CODE, '06-build-claude-brief.js'))) {
    nodeOutputs['Build Claude Brief'] =
      runCodeNode('06-build-claude-brief.js', nodeOutputs['Compute Metrics'], nodeOutputs, env);
    brief = nodeOutputs['Build Claude Brief'][0].json;
  }

  return { period: nodeOutputs['Resolve Reporting Period'][0].json, metrics, brief, nodeOutputs };
}

// ---- reporting ----------------------------------------------
const money = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-GB', { maximumFractionDigits: 2 }));
const pct = (n) => (n === null || n === undefined ? '—' : (n * 100).toFixed(1) + '%');
const v = (m) => (m && m.value !== undefined ? m.value : null);

function printPeriod(result) {
  const { metrics: r } = result;
  const p = r.period;
  const s = r.metrics.sales;
  const d = r.metrics.delivery;
  const h = r.metrics.people_ops;

  console.log('\n' + '='.repeat(74));
  console.log(`${p.label}   ${p.start} → ${p.end}   (${p.days} days, anchored to ${p.reference_date})`);
  console.log(`compare against: ${p.compare_label}  ${p.compare_start} → ${p.compare_end}`);
  console.log(`run_id: ${r.run_id}    status: ${r.run_status}    metrics_hash: ${r.metrics_hash}`);
  console.log('='.repeat(74));

  const row = (label, val, note) => console.log(`  ${label.padEnd(30)} ${String(val).padStart(14)}   ${note || ''}`);

  console.log('\nSALES');
  row('Total leads', v(s.total_leads));
  row('Closed won', v(s.closed_won_deals));
  row('Closed lost', v(s.closed_lost_deals));
  row('Pipeline value', money(v(s.pipeline_value)));
  row('Revenue won', money(v(s.revenue_won)));
  row('Win rate', pct(v(s.win_rate)));
  row('Marketing spend', money(v(s.marketing_spend)), 'pro-rated by month');
  row('Cost per lead', money(v(s.cost_per_lead)));
  row('Avg won deal value', money(v(s.average_won_deal_value)));
  console.log('  Revenue by lead source:');
  (v(s.revenue_by_lead_source) || []).forEach((x) =>
    console.log(`     ${x.lead_source.padEnd(16)} leads ${String(x.leads).padStart(3)}  won ${String(x.closed_won).padStart(3)}  revenue ${money(x.revenue_won).padStart(12)}`));
  console.log(`  spend basis: ${s._coverage.marketing_spend_basis}`);

  console.log('\nPROJECT DELIVERY');
  row('Active projects', v(d.active_projects));
  row('Completed projects', v(d.completed_projects));
  row('Blocked projects', v(d.blocked_projects), (d._coverage.blocked_project_ids || []).join(', '));
  row('On-time completion rate', pct(v(d.on_time_completion_rate)));
  row('Average delay (late only)', v(d.average_delay_days) === null ? '—' : v(d.average_delay_days) + ' d');
  row('Budget variance', money(v(d.budget_variance)));
  row('Over-budget projects', v(d.over_budget_projects));
  console.log('  Delivery load by team:');
  (v(d.delivery_load_by_team) || []).forEach((x) =>
    console.log(`     ${x.team.padEnd(16)} active ${String(x.active).padStart(3)}  blocked ${String(x.blocked).padStart(3)}  completed ${String(x.completed).padStart(3)}`));

  console.log('\nPEOPLE OPS');
  row('Applications', v(h.applications));
  row('Offers accepted', v(h.offers_accepted));
  row('New hires', v(h.new_hires));
  row('Exits', v(h.exits));
  row('Active headcount (end)', v(h.active_headcount));
  row('Opening headcount', v(h.opening_headcount));
  row('Time to hire', v(h.time_to_hire_days) === null ? '—' : v(h.time_to_hire_days) + ' d');
  row('Offer acceptance time', v(h.offer_acceptance_days) === null ? '—' : v(h.offer_acceptance_days) + ' d');
  row('Attrition rate', pct(v(h.attrition_rate)));
  row('Accepted, not yet started', v(h.accepted_offers_not_yet_started));
  console.log('  Headcount by department:');
  (v(h.headcount_by_department) || []).forEach((x) =>
    console.log(`     ${x.department.padEnd(18)} headcount ${String(x.active_headcount).padStart(3)}  hires ${String(x.new_hires).padStart(3)}  exits ${String(x.exits).padStart(3)}  apps ${String(x.applications).padStart(3)}`));

  console.log('\nUNAVAILABLE METRICS (null with a stated reason)');
  let anyNull = false;
  for (const domain of ['sales', 'delivery', 'people_ops']) {
    for (const [k, m] of Object.entries(r.metrics[domain])) {
      if (k.startsWith('_')) continue;
      if (m && m.value === null) { anyNull = true; console.log(`     ${domain}.${k}: ${m.unavailable_reason}`); }
    }
  }
  if (!anyNull) console.log('     (none — every metric computed)');

  console.log(`\nDATA QUALITY — ${r.data_quality_summary.errors} error, ${r.data_quality_summary.warnings} warning, ${r.data_quality_summary.info} info`);
  r.data_quality.forEach((w) => console.log(`     [${w.severity}] ${w.code} ${w.record_id ? '(' + w.record_id + ') ' : ''}${w.message}`));

  console.log('\nTRENDS vs ' + p.compare_label);
  for (const domain of ['sales', 'delivery', 'people_ops']) {
    for (const [k, t] of Object.entries(r.trends[domain])) {
      if (t.direction === 'not_comparable') continue;
      const arrow = t.direction === 'up' ? '▲' : t.direction === 'down' ? '▼' : '=';
      console.log(`     ${arrow} ${(domain + '.' + k).padEnd(34)} ${String(t.previous).padStart(10)} → ${String(t.current).padStart(10)}  ${t.percent_change === null ? '' : (t.percent_change * 100).toFixed(1) + '%'}`);
    }
  }
}

// Exported BEFORE the CLI dispatch below: assertions.js requires this
// module back, and a circular require resolves to whatever is on
// module.exports at that moment.
module.exports = { runPipeline, runCodeNode, loadSources, parseCSV, HARNESS_ENV };

// ---- CLI ----------------------------------------------------
// Only when this file is the entry point. Without the guard, another script
// that requires the harness would also print three period reports.
if (require.main === module) {
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

if (has('--assert')) {
  require('./assertions.js').run(runPipeline, loadSources);
} else if (has('--brief')) {
  const out = runPipeline({ period: arg('--period', 'last_30d') });
  console.log(out.brief ? JSON.stringify(out.brief, null, 2) : 'Build Claude Brief node not present.');
} else if (has('--json')) {
  const out = runPipeline({ period: arg('--period', 'last_30d') });
  console.log(JSON.stringify(out.metrics, null, 2));
} else if (has('--period')) {
  printPeriod(runPipeline({ period: arg('--period'), start: arg('--start'), end: arg('--end') }));
} else {
  ['last_30d', 'last_90d', 'ytd'].forEach((p) => printPeriod(runPipeline({ period: p })));
}
}
