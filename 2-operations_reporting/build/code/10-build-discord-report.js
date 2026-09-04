// n8n Code node: Build Discord Report
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Build Discord Report                    (Run Once for ALL Items)
//
// Composes the whole published report as Discord markdown and emits it as
// ONE ITEM PER MESSAGE, so the Discord node downstream posts it in order.
//
// WHY IT SITS AFTER "Respond — Report Updated"
// --------------------------------------------
// The webhook caller is a browser waiting on a fetch. Discord is a third
// party that can be slow or down. Posting before responding would put a
// stranger's latency in front of the dashboard's spinner, and a Discord
// outage would read to the caller as a failed report - when the report was
// published, verified and is sitting on the dashboard already.
//
// WHY CHUNKS INSTEAD OF ONE MESSAGE
// ---------------------------------
// A Discord message body is capped at 2000 characters, and "a full report"
// is comfortably past that once the model has written three risks and three
// actions. Over the cap Discord rejects the whole POST with a 400 - it does
// not truncate for you - so the report would vanish exactly on the runs
// that had the most to say. This splits on line boundaries under a 1900
// character budget (leaving room for the part header), numbers the parts,
// and hard-caps the total so a pathological run cannot spam the channel.
//
// EVERY UPSTREAM READ IS DEFENSIVE
// --------------------------------
// This node is the last thing in the workflow and it is a NOTIFICATION. It
// must never be the reason a successful, published, verified run is marked
// failed. Anything it cannot read is reported inside the message as "not
// available" rather than thrown.
// ============================================================

const MAX_MESSAGE_CHARS = 1900;   // Discord's cap is 2000; the rest is headroom.
const MAX_MESSAGES = 6;           // ~11k characters. Past this, link out instead.

function pull(nodeName) {
  try { return $(nodeName).first().json || {}; } catch (e) { return {}; }
}

const metrics = pull('Compute Metrics');
const parsed = pull('Parse & Validate Insights');
const payloads = pull('Build Supabase Payloads');
const verify = $input.first() ? ($input.first().json || {}) : {};
const published = verify.ok === true ? verify : pull('Verify Publish');

const period = metrics.period || {};
const insights = parsed.insights || {};

// ---- formatting ---------------------------------------------
// Deliberately the same conventions as the dashboard and the model prompt:
// no currency symbol anywhere, rates as one-decimal percentages, durations
// in days. Three renderings of one number is how a report starts
// contradicting itself.
function num(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return 'not available';
  return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });
}
function pct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return 'not available';
  return (Number(n) * 100).toFixed(1) + '%';
}
function days(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return 'not available';
  return Number(n).toFixed(1) + ' d';
}
function fmt(key, n) {
  if (/_rate$/.test(key)) return pct(n);
  if (/_days$/.test(key)) return days(n);
  return num(n);
}
// The prompt insists on one capitalisation for department names, so the
// prose and the labels around it must not disagree. Anything not in the map
// falls back to sentence case.
const LABELS = {
  sales: 'Sales',
  marketing: 'Marketing',
  project_delivery: 'Project Delivery',
  people_ops: 'People Ops',
  cross_functional: 'Cross-functional',
  period: 'Reporting period',
};
function title(key) {
  if (LABELS[key]) return LABELS[key];
  // The unit is already in the value, so "Average delay: 6.5 d" beats
  // "Average delay days: 6.5 d". `_rate` stays: "Win rate" reads correctly.
  return String(key).replace(/_days$/, '').replace(/_/g, ' ')
    .replace(/^./, function (c) { return c.toUpperCase(); });
}

// Discord renders _italics_ and **bold** but has no tables, so the movement
// note goes inline. `not_comparable` prints nothing at all rather than a
// dash the reader has to decode.
function movement(key, t) {
  if (!t || t.direction === 'not_comparable') return '';
  if (t.direction === 'flat') return '  (unchanged)';
  if (t.direction === 'stable') return '  (broadly flat)';
  const arrow = t.direction === 'up' ? '▲' : '▼';
  const abs = /_rate$/.test(key)
    ? Math.abs(Number(t.change) * 100).toFixed(1) + ' pts'
    : num(Math.abs(Number(t.change)));
  const rel = (t.percent_change === null || t.percent_change === undefined)
    ? ''
    : ', ' + (Number(t.percent_change) * 100).toFixed(1) + '%';
  return '  (' + arrow + ' ' + abs + rel + ')';
}

const SEVERITY = { high: '🔴', medium: '🟠', low: '🟡' };
const DQ = { error: '⛔', warning: '⚠️', info: 'ℹ️' };

// ---- header --------------------------------------------------
// The three values Compute Metrics actually produces. A run missing one
// source is still published — a partial report beats no report — so
// `partial` is a warning, not a failure.
const runStatus = String(metrics.run_status || 'unknown');
const STATUS_ICON = { succeeded: '✅', partial: '⚠️', failed: '⛔' };
const statusIcon = STATUS_ICON[runStatus] || '❔';
const source = parsed.insight_source === 'claude'
  ? ('Claude' + (parsed.model ? ' (' + parsed.model + ')' : '') + (parsed.grounded ? ', grounded' : ', UNVERIFIED FIGURES'))
  : 'deterministic fallback — the model call did not succeed';

const dq = metrics.data_quality_summary || {};
const rows = published.rows_written || payloads.row_counts || {};
const totalRows = Object.keys(rows).reduce(function (a, k) { return a + Number(rows[k] || 0); }, 0);

const lines = [];
lines.push('**KOYA TALENT — OPERATIONS REPORT**');
lines.push(period.label || 'Reporting period not available');
lines.push('`' + (period.start || '?') + '` → `' + (period.end || '?') + '`'
  + (period.days ? '  ·  ' + period.days + ' days' : '')
  + (period.compare_label ? '  ·  compared with ' + period.compare_label : ''));
lines.push('');
lines.push(statusIcon + '  Run status **' + runStatus + '**  ·  Confidence **'
  + String(insights.confidence || 'unknown') + '**');
lines.push('Insights: ' + source);
lines.push('Data quality: ' + (dq.errors || 0) + ' errors, ' + (dq.warnings || 0) + ' warnings'
  + (dq.affected_sources && dq.affected_sources.length ? ' (' + dq.affected_sources.join(', ') + ')' : ''));
lines.push('Published: ' + totalRows + ' rows across ' + Object.keys(rows).length + ' tables  ·  run `'
  + String(metrics.run_id || 'unknown') + '`');

// Every figure below was produced by code, not by the model. When the model
// call failed the prose is deterministic and says so above — but the numbers
// are identical either way, and that is worth the reader knowing.
if (parsed.insight_source !== 'claude') {
  lines.push('');
  lines.push('> The commentary below was generated deterministically because the model call did not succeed. Every figure is unaffected.');
} else if (parsed.grounded === false) {
  lines.push('');
  lines.push('> Some figures in the commentary could not be matched against the calculated metrics: '
    + (parsed.unverified_figures || []).slice(0, 8).join(', ') + '. Treat the prose with care; the figures below are authoritative.');
}

// ---- executive summary ---------------------------------------
lines.push('');
lines.push('__**Executive summary**__');
lines.push(String(insights.executive_summary || 'No summary was produced for this run.'));

// ---- the numbers ---------------------------------------------
// Driven off the metrics object itself rather than a hardcoded list, so a
// metric added upstream appears here without this node being edited — the
// alternative is a report that quietly stops mentioning a new KPI.
const DOMAINS = [
  ['sales', 'Sales and marketing'],
  ['delivery', 'Project Delivery'],
  ['people_ops', 'People Ops'],
];

for (const pair of DOMAINS) {
  const key = pair[0];
  const domain = (metrics.metrics || {})[key];
  if (!domain) continue;
  const trend = (metrics.trends || {})[key] || {};

  lines.push('');
  lines.push('__**' + pair[1] + '**__');

  for (const metricKey of Object.keys(domain)) {
    if (metricKey.charAt(0) === '_') continue;          // _coverage and friends
    const node = domain[metricKey];
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node.value)) continue;            // breakdowns, handled below
    if (node.value !== null && typeof node.value === 'object') continue;

    if (node.value === null) {
      // A missing number is reported WITH ITS REASON. "not available" on its
      // own invites the reader to assume zero, which is the one reading the
      // whole pipeline is built to prevent.
      lines.push('• ' + title(metricKey) + ': not available — ' + String(node.unavailable_reason || 'no reason recorded'));
    } else {
      lines.push('• ' + title(metricKey) + ': **' + fmt(metricKey, node.value) + '**' + movement(metricKey, trend[metricKey]));
    }
  }
}

// ---- risks ----------------------------------------------------
const risks = Array.isArray(insights.risks_and_anomalies) ? insights.risks_and_anomalies : [];
lines.push('');
lines.push('__**Risks and anomalies**__');
if (!risks.length) {
  lines.push('None worth raising this period.');
} else {
  for (const r of risks) {
    lines.push((SEVERITY[r.severity] || '🟡') + ' **' + title(String(r.area || 'cross functional')) + '** — ' + String(r.finding || ''));
    if (r.evidence) lines.push('_' + String(r.evidence) + '_');
  }
}

// ---- actions --------------------------------------------------
const actions = Array.isArray(insights.recommended_actions) ? insights.recommended_actions : [];
lines.push('');
lines.push('__**Recommended actions**__');
if (!actions.length) {
  lines.push('None warranted this period.');
} else {
  let i = 0;
  for (const a of actions) {
    i += 1;
    lines.push(i + '. ' + (SEVERITY[a.priority] || '🟡') + ' **' + title(String(a.area || 'cross functional')) + '** — ' + String(a.action || ''));
    if (a.rationale) lines.push('_' + String(a.rationale) + '_');
  }
}

// ---- data quality ---------------------------------------------
// The model's wording, not the raw diagnostics: 40 identical field-level
// warnings belong on the dashboard, not in a channel people have to read.
const dqWarnings = Array.isArray(insights.data_quality_warnings) ? insights.data_quality_warnings : [];
lines.push('');
lines.push('__**Data quality**__');
if (!dqWarnings.length) {
  lines.push('Nothing affecting the conclusions above.');
} else {
  for (const w of dqWarnings) {
    lines.push('⚠️ **' + title(String(w.source || 'source')) + '** — ' + String(w.issue || ''));
    if (w.impact) lines.push('→ ' + String(w.impact));
  }
}

// A config error is a DEPLOYMENT problem, kept out of data quality upstream
// so it cannot downgrade the report's confidence. It still has to reach a
// human, and this is the message a human actually reads.
const configErrors = Array.isArray(metrics.config_errors) ? metrics.config_errors : [];
if (configErrors.length) {
  lines.push('');
  lines.push('__**Configuration**__');
  for (const c of configErrors) lines.push('⛔ ' + String(c.message || c.code));
}

lines.push('');
lines.push('_Koya Talent AI Operations Reporting · n8n · ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC_');

// ---- chunk ----------------------------------------------------
// Split on line boundaries so a bullet is never cut mid-word. A single line
// longer than the budget (a very long executive summary) is hard-split, and
// that is the only place a word can break.
const chunks = [];
let buf = '';
function flush() { if (buf.length) { chunks.push(buf); buf = ''; } }

// A section heading stranded at the bottom of a message, with its content in
// the next one, reads as a report that lost something. So a heading is
// measured together with the line under it and they move as a pair.
function isHeading(line) { return /^__\*\*.*\*\*__$/.test(line); }

for (let i = 0; i < lines.length; i += 1) {
  let line = lines[i];
  const glue = (isHeading(line) && lines[i + 1] !== undefined) ? lines[i + 1].length + 1 : 0;

  while (line.length > MAX_MESSAGE_CHARS) {
    flush();
    chunks.push(line.slice(0, MAX_MESSAGE_CHARS));
    line = line.slice(MAX_MESSAGE_CHARS);
  }
  if (buf.length + line.length + 1 + glue > MAX_MESSAGE_CHARS) flush();
  buf += (buf.length ? '\n' : '') + line;
}
flush();

let truncated = false;
if (chunks.length > MAX_MESSAGES) {
  truncated = true;
  chunks.length = MAX_MESSAGES;
  chunks[MAX_MESSAGES - 1] += '\n\n_…report truncated at ' + MAX_MESSAGES + ' messages. The full report is on the dashboard._';
}

// One item per message. The Discord node runs once per item and n8n keeps
// item order, so parts arrive in sequence.
return chunks.map(function (raw, idx) {
  // A blank line left at a split point renders as dead space at the top or
  // bottom of a Discord message.
  const content = raw.replace(/^\n+/, '').replace(/\n+$/, '');
  const header = chunks.length > 1 ? '`(' + (idx + 1) + '/' + chunks.length + ')`\n' : '';
  return {
    json: {
      content: header + content,
      part: idx + 1,
      parts: chunks.length,
      truncated: truncated,
      run_id: metrics.run_id || null,
      period_key: period.key || null,
      run_status: runStatus,
    },
  };
});
