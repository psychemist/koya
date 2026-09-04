// n8n Code node: Resolve Reporting Period
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Resolve Reporting Period                (Run Once for ALL Items)
//
// The single place in the workflow that decides WHAT WINDOW WE ARE
// REPORTING ON. Every downstream node reads the window from here and
// never computes a date of its own. One definition, one place to fix.
//
// Three triggers land on this node and they arrive in different shapes:
//   - Webhook          POST body { period, start, end, force, reference_date }
//   - Schedule Trigger no body at all -> default period
//   - Manual Trigger   no body at all -> default period
//
// THE REFERENCE DATE IS NOT new Date().
// The three sources cover Jan 2025 - Jun 2026. Anchoring to the real
// clock makes every window empty and the dashboard look broken while the
// workflow is behaving perfectly. So the anchor is an explicit input:
//   1. webhook body.reference_date      (per-run override, used in the demo)
//   2. IKE_KOYA_REFERENCE_DATE          (deployment default - see setting())
//   3. today                            (only if neither is set)
//
// WHERE A SETTING COMES FROM, AND WHY THERE ARE TWO PLACES
// n8n exposes deployment configuration through two different objects and
// which one works depends on how the instance is hosted:
//
//   $vars   n8n Cloud - Settings -> Variables. The only one available on
//           Cloud, because Cloud does not run on a machine whose process
//           environment you control.
//   $env    self-hosted - the process environment. BLOCKED on Cloud
//           (N8N_BLOCK_ENV_ACCESS_IN_NODE), where reading it THROWS rather
//           than returning undefined.
//
// Reading only $env is what produced "Invalid URL: /rest/v1/rpc/..." on a
// Cloud run: the read threw, the catch returned '', the URL expression
// evaluated to just the path, and the HTTP node reported a malformed URL
// rather than a missing setting. setting() reads both, in that order, and
// every read is wrapped - the catch means "not configured here", never
// "crash the run".
//
// THERE IS NO HARDCODED DATE IN THIS FILE, and no hardcoded project URL
// either. Both are configuration, and configuration baked into a Code node
// is configuration nobody rotates: it ships in the exported JSON, it is
// invisible to whoever changes the env var and wonders why nothing moved,
// and it rots silently the day the dataset moves on. An unset anchor is a
// CONFIGURATION ERROR - the run falls through to the real clock and says so
// loudly in period_warnings, rather than quietly pretending it is June 2026.
//
// Set IKE_KOYA_REFERENCE_DATE=2026-06-30 while the sources are the sample
// dataset, and IKE_KOYA_REFERENCE_DATE=today on the day they go live.
// ============================================================

const DEFAULT_PERIOD = 'last_30d';
const SUPPORTED = ['last_7d', 'last_30d', 'last_90d', 'ytd', 'custom'];

// The host that appears in place of the project URL when nothing is
// configured. It is deliberately a real-looking URL on the reserved
// .invalid TLD rather than an empty string: an empty one turns
// "{{ supabase_url }}/rest/v1/rpc/publish_report" into a bare path, and n8n
// reports that as "Invalid URL", which sends the reader looking at the HTTP
// node instead of at the setting that is actually missing. This fails at
// DNS instead, naming itself in the error.
const UNSET_URL = 'https://IKE-SUPABASE-URL-IS-NOT-SET.invalid';

// ---- deployment settings ------------------------------------
// $vars first (n8n Cloud), then $env (self-hosted). Both reads are guarded:
// on Cloud, touching $env throws.
function setting(name) {
  try {
    const v = (typeof $vars !== 'undefined' && $vars) ? $vars[name] : undefined;
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return { value: String(v).trim(), source: 'vars' };
    }
  } catch (e) { /* no Variables on this instance */ }

  try {
    const v = (typeof $env !== 'undefined' && $env) ? $env[name] : undefined;
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return { value: String(v).trim(), source: 'env' };
    }
  } catch (e) { /* env access blocked, which is the Cloud default */ }

  return { value: '', source: null };
}

// ---- date helpers -------------------------------------------
// Everything is handled as a plain YYYY-MM-DD string in UTC. No local
// timezone ever touches these values: an n8n instance in Lagos and one in
// London must produce byte-identical windows, or the same period gets two
// different run_ids and the dashboard shows two "latest" runs.
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isValidISODate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  // Rejects 2026-02-30: Date rolls it to March 2, so the round trip fails.
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function toUTC(s) { return new Date(s + 'T00:00:00Z'); }
function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) {
  const d = toUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}
function daysBetween(a, b) {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000);
}

// ---- gather the trigger payload -----------------------------
// Any of the three triggers may be the one that fired. Read defensively:
// a Schedule Trigger item is {timestamp, ...} with no body at all.
const first = ($input.all()[0] && $input.all()[0].json) || {};
const body = (first.body && typeof first.body === 'object') ? first.body : first;
const query = (first.query && typeof first.query === 'object') ? first.query : {};
const req = Object.assign({}, query, body); // body wins over querystring

const warnings = [];

// ---- 1. reference date --------------------------------------
function resolveReferenceDate() {
  const fromRequest = String(req.reference_date || '').trim();
  if (fromRequest) {
    if (isValidISODate(fromRequest)) return { value: fromRequest, source: 'request' };
    warnings.push({
      code: 'INVALID_REFERENCE_DATE',
      severity: 'warning',
      message: 'reference_date "' + fromRequest + '" is not a valid YYYY-MM-DD date. Falling back to the configured anchor.',
    });
  }

  const configured = setting('IKE_KOYA_REFERENCE_DATE');
  const fromEnv = configured.value;

  if (fromEnv) {
    // 'today' is an explicit, supported value: set IKE_KOYA_REFERENCE_DATE=today
    // on the day the sources go live and this file needs no edit. Checked
    // BEFORE the ISO test, or it fails validation and reports itself as a
    // bad date on the way to doing exactly the right thing.
    if (fromEnv.toLowerCase() === 'today') {
      return { value: new Date().toISOString().slice(0, 10), source: 'clock' };
    }
    if (isValidISODate(fromEnv)) return { value: fromEnv, source: configured.source };
    warnings.push({
      code: 'INVALID_REFERENCE_DATE',
      severity: 'error',
      message: 'IKE_KOYA_REFERENCE_DATE "' + fromEnv + '" (read from ' + (configured.source === 'vars' ? 'n8n Variables' : 'the instance environment') + ') is neither a YYYY-MM-DD date nor "today". Anchoring to the real clock instead, which will return an empty window while the sources end before today.',
    });
    return { value: new Date().toISOString().slice(0, 10), source: 'clock_after_invalid_env' };
  }

  // Nothing configured. The clock is the only honest answer left, and it is
  // very probably the wrong one, so this is an error rather than a shrug.
  warnings.push({
    code: 'REFERENCE_DATE_NOT_SET',
    severity: 'error',
    message: 'IKE_KOYA_REFERENCE_DATE is not set, so the report is anchored to today. Set it in n8n under Settings -> Variables (n8n Cloud) or in the instance environment (self-hosted). If the sources end before today every window will be empty and the dashboard will look broken while the workflow is behaving correctly. Use the dataset horizon while the sample data is the source, or "today" once the sources are live.',
  });
  return { value: new Date().toISOString().slice(0, 10), source: 'clock_unset' };
}

const ref = resolveReferenceDate();
const referenceDate = ref.value;

// ---- 2. period key ------------------------------------------
let periodKey = String(req.period || req.period_key || '').trim().toLowerCase();
if (periodKey === '') {
  periodKey = DEFAULT_PERIOD;
} else if (SUPPORTED.indexOf(periodKey) === -1) {
  warnings.push({
    code: 'UNKNOWN_PERIOD',
    severity: 'warning',
    message: 'Unknown period "' + periodKey + '". Supported: ' + SUPPORTED.join(', ') + '. Defaulted to ' + DEFAULT_PERIOD + '.',
  });
  periodKey = DEFAULT_PERIOD;
}

// ---- 3. window ----------------------------------------------
// Windows are INCLUSIVE of both endpoints and match the KPI guide exactly:
//   last  7 days -> 23 Jun - 30 Jun 2026   (end minus 7 days)
//   last 30 days -> 31 May - 30 Jun 2026   (end minus 30 days)
//   last 90 days ->  1 Apr - 30 Jun 2026   (end minus 90 days)
//   year to date ->  1 Jan - 30 Jun 2026
// The guide's own worked examples are the spec. A "30 day" window that is
// inclusive on both ends spans 31 dates; that is intentional and is stated
// on the dashboard so nobody reconciles a count and finds it one off.
let start;
let end;
let label;

if (periodKey === 'custom') {
  const cs = String(req.start || '').trim();
  const ce = String(req.end || '').trim();
  const badStart = !isValidISODate(cs);
  const badEnd = !isValidISODate(ce);

  if (badStart || badEnd) {
    warnings.push({
      code: 'INVALID_CUSTOM_RANGE',
      severity: 'warning',
      message: 'Custom range needs valid start and end dates (YYYY-MM-DD). Got start="' + cs + '", end="' + ce + '". Fell back to ' + DEFAULT_PERIOD + '.',
    });
    periodKey = DEFAULT_PERIOD;
  } else if (daysBetween(cs, ce) < 0) {
    // Swap rather than fail. A reversed range is a user slip, not a reason
    // to deny leadership a report, but it is recorded so it is visible.
    warnings.push({
      code: 'REVERSED_CUSTOM_RANGE',
      severity: 'warning',
      message: 'Custom range start (' + cs + ') was after end (' + ce + '). The two were swapped.',
    });
    start = ce; end = cs;
  } else {
    start = cs; end = ce;
  }

  if (start && end) {
    label = 'Custom: ' + start + ' to ' + end;
    if (daysBetween(start, end) > 1095) {
      warnings.push({
        code: 'VERY_WIDE_RANGE',
        severity: 'info',
        message: 'Custom range spans ' + (daysBetween(start, end) + 1) + ' days. Trend comparisons over windows this wide are weak.',
      });
    }
  }
}

if (!start) {
  end = referenceDate;
  if (periodKey === 'last_7d') { start = addDays(end, -7); label = 'Last 7 days'; }
  else if (periodKey === 'last_30d') { start = addDays(end, -30); label = 'Last 30 days'; }
  else if (periodKey === 'last_90d') { start = addDays(end, -90); label = 'Last 90 days'; }
  else if (periodKey === 'ytd') { start = end.slice(0, 4) + '-01-01'; label = 'Year to date'; }
}

const spanDays = daysBetween(start, end) + 1;

// ---- 4. the comparison window -------------------------------
// The KPI guide asks Claude whether win rate "improved, declined, or stayed
// stable" and whether time to hire is rising. Neither question can be
// answered from one window of numbers. So every run computes a second,
// comparable window and hands Claude both. Without this the model has to
// guess at a direction, and a guessed trend reads exactly like a real one.
//
//   rolling windows -> the equal-length window immediately before
//   year to date    -> the SAME calendar span one year earlier, because
//                      "1 Jan - 30 Jun vs the preceding 181 days of last
//                      year" compares a half year to a different half year
//                      and the seasonality makes it meaningless
let compareStart;
let compareEnd;
let compareLabel;

if (periodKey === 'ytd') {
  const priorYear = String(Number(end.slice(0, 4)) - 1);
  compareStart = priorYear + '-01-01';
  compareEnd = priorYear + end.slice(4);
  if (!isValidISODate(compareEnd)) compareEnd = priorYear + '-02-28'; // 29 Feb -> 28 Feb
  compareLabel = 'Same period ' + priorYear;
} else {
  compareEnd = addDays(start, -1);
  compareStart = addDays(compareEnd, -(spanDays - 1));
  compareLabel = 'Preceding ' + spanDays + ' days';
}

// ---- 5. run identity ----------------------------------------
// run_id is DETERMINISTIC and derived only from the window. Re-running the
// same period upserts the same row instead of appending a new one, which is
// what makes the whole workflow safe to run twice. Nothing random, no
// timestamp, no execution id in the key.
const runId = ['run', periodKey, start, end, referenceDate].join('_').replace(/[^a-zA-Z0-9_\-]/g, '');

const force = req.force === true || String(req.force || '').toLowerCase() === 'true';

// ---- 6. Supabase base URL -----------------------------------
// Resolved once, here, so every write node reads it from one place.
// Configuration only - there is no literal to fall back to. A project URL is
// not a secret (the browser is served it in dashboard/config.js), but it IS a
// project identifier, and hardcoding it means the exported workflow points
// at one specific Supabase project forever. The KEY is a different matter
// entirely and lives in n8n's credential store, never in this workflow, the
// exported JSON, or the browser.
const supabaseSetting = setting('IKE_SUPABASE_URL');
let supabaseUrl = supabaseSetting.value.replace(/\/+$/, '');
let supabaseUrlConfigured = Boolean(supabaseUrl);

if (supabaseUrl && !/^https:\/\//.test(supabaseUrl)) {
  // A URL without a scheme fails the same way an absent one does - as a
  // malformed URL in an HTTP node, three nodes downstream of the mistake.
  warnings.push({
    code: 'SUPABASE_URL_NOT_SET',
    severity: 'error',
    message: 'IKE_SUPABASE_URL is "' + supabaseUrl + '", which does not start with https://. It must be the full project URL, e.g. https://YOUR-PROJECT-REF.supabase.co. Every Supabase write will fail until this is fixed.',
  });
  supabaseUrl = '';
  supabaseUrlConfigured = false;
}

if (!supabaseUrlConfigured) {
  // Substituted rather than left empty: see UNSET_URL above. The write still
  // fails - it has to, there is nowhere to write - but it fails saying what
  // is missing instead of "Invalid URL".
  supabaseUrl = UNSET_URL;
  warnings.push({
    code: 'SUPABASE_URL_NOT_SET',
    severity: 'error',
    message: 'IKE_SUPABASE_URL is not set, so there is nowhere to publish this report. ' +
      'On n8n Cloud add it under Settings -> Variables; self-hosted, add it to the instance ' +
      'environment. The value is the Supabase project URL, e.g. https://YOUR-PROJECT-REF.supabase.co ' +
      '- Project Settings -> Data API. Every Supabase write will fail until this is done.',
  });
}

// Where the report can legitimately be empty, say so up front rather than
// letting an empty dashboard read as a broken one.
if (daysBetween(referenceDate, start) > 0) {
  warnings.push({
    code: 'WINDOW_AFTER_REFERENCE',
    severity: 'warning',
    message: 'The window starts (' + start + ') after the reference date (' + referenceDate + '). Expect no records.',
  });
}

return [{
  json: {
    run_id: runId,
    period_key: periodKey,
    period_label: label,
    period_start: start,
    period_end: end,
    period_days: spanDays,
    compare_start: compareStart,
    compare_end: compareEnd,
    compare_label: compareLabel,
    reference_date: referenceDate,
    reference_date_source: ref.source,
    // Which of $vars / $env each setting was found in, so a run that used
    // the wrong one can be diagnosed from its output rather than by guessing.
    config_source: {
      reference_date: ref.source,
      supabase_url: supabaseSetting.source,
    },
    supabase_url_configured: supabaseUrlConfigured,
    force_refresh: force,
    supabase_url: supabaseUrl,
    requested_by: String(req.requested_by || '').slice(0, 120) || 'scheduled',
    triggered_at: new Date().toISOString(),
    period_warnings: warnings,
  },
}];
