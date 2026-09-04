// n8n Code node: Normalize Project Delivery
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Normalize Project Delivery (Airtable)   (Run Once for ALL Items)
//
// Same contract as Normalize Sales: keep every record, type it, and attach
// the reasons it cannot be used rather than dropping it.
//
// ONE THING TO KNOW ABOUT THIS SOURCE
// -----------------------------------
// `status` is a SNAPSHOT of where the project stands right now. It is not
// a history. So "was this project blocked during March?" is not actually
// answerable from this data - the only honest question is "is it blocked
// now, and was it running during March?". This node computes the date span
// a project was live for; the metrics node intersects that span with the
// reporting window. The limitation is stated on the dashboard rather than
// papered over, because a leader reading "5 blocked projects" for a window
// three months ago deserves to know it means "5 blocked today, that were
// open then".
//
// The Airtable node returns fields under either `fields` or flattened onto
// the item depending on node version, so read through both.
//
// THE 100-RECORD CLIFF
// --------------------
// Airtable's REST API returns at most 100 records per response and hands
// back an `offset` cursor for the next page. The n8n node only follows that
// cursor when "Return All" is on; with it off it stops after one page and
// reports success. There is no error, no warning, and no total count in the
// response to compare against - a truncated fetch and a small table look
// EXACTLY the same from here. So the guard below is a heuristic on the one
// signal there is: a record count that lands exactly on a page boundary is
// far more likely to be a truncated fetch than a coincidence.
// ============================================================

// Airtable's page size. Not configurable, and the number the node's default
// `limit` happens to match, which is why both failure modes land here.
const AIRTABLE_PAGE_SIZE = 100;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_MAP = {
  'completed': 'Completed', 'complete': 'Completed', 'done': 'Completed',
  'in progress': 'In Progress', 'inprogress': 'In Progress', 'active': 'In Progress', 'ongoing': 'In Progress',
  'blocked': 'Blocked', 'on hold': 'Blocked', 'onhold': 'Blocked', 'stalled': 'Blocked',
};

function isValidISODate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function num(v) {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim();
  if (raw === '') return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// The delivery CSV ships with a UTF-8 BOM, so the first header is
// "﻿project_id" and a naive row['project_id'] is undefined. Strip it
// here rather than in a preceding node, so the fix travels with the reader.
function field(row, names) {
  const norm = {};
  for (const k of Object.keys(row)) {
    norm[k.replace(/^﻿/, '').toLowerCase().replace(/[\s_\-]/g, '')] = row[k];
  }
  for (const n of names) {
    const key = n.toLowerCase().replace(/[\s_\-]/g, '');
    if (norm[key] !== undefined) return norm[key];
  }
  return undefined;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}

const rows = $input.all();
const out = [];
const issues = [];
const seenIds = new Set();

let index = 0;
for (const item of rows) {
  const raw = item.json || {};
  index += 1;
  // Every issue raised while reading this row is stamped with the row's own
  // dates at the end of the iteration, so Compute Metrics can tell a warning
  // about work inside the reporting window from one about work outside it.
  const issueStart = issues.length;

  if (raw.error) {
    issues.push({
      source: 'delivery', severity: 'error', code: 'SOURCE_ERROR', record_id: null,
      message: 'Airtable returned an error: ' + String(raw.error).slice(0, 200),
    });
    continue;
  }

  const row = (raw.fields && typeof raw.fields === 'object') ? Object.assign({}, raw.fields, raw) : raw;

  const projectId = str(field(row, ['project_id', 'projectid', 'id']));
  const name = str(field(row, ['project_name', 'name', 'project']));
  const team = str(field(row, ['team']));
  const owner = str(field(row, ['owner', 'assignee']));
  const rawKickoff = str(field(row, ['kickoff_date', 'kickoff', 'start_date']));
  const rawDue = str(field(row, ['due_date', 'due']));
  const rawCompleted = str(field(row, ['completed_date', 'completed']));
  const rawStatus = str(field(row, ['status']));
  const budgeted = num(field(row, ['budgeted_cost', 'budget']));
  const actual = num(field(row, ['actual_cost', 'actual']));

  if (!projectId && !name && !rawStatus && !rawKickoff) continue; // trailing blank line

  const recordId = projectId || ('delivery-row-' + index);
  const recIssues = [];

  // ---- dates ------------------------------------------------
  function readDate(value, label, severity) {
    if (!value) return null;
    if (!isValidISODate(value)) {
      recIssues.push('invalid ' + label + ' "' + value + '"');
      issues.push({
        source: 'delivery', severity: severity, code: 'INVALID_DATE', record_id: recordId,
        message: 'Project ' + recordId + ' has an invalid ' + label + ' "' + value + '". Treated as missing.',
      });
      return null;
    }
    return value;
  }

  const kickoff = readDate(rawKickoff, 'kickoff date', 'warning');
  const due = readDate(rawDue, 'due date', 'warning');
  const completed = readDate(rawCompleted, 'completed date', 'warning');

  if (!rawKickoff) {
    recIssues.push('blank kickoff date');
    issues.push({
      source: 'delivery', severity: 'warning', code: 'BLANK_DATE', record_id: recordId,
      message: 'Project ' + recordId + ' has no kickoff date, so the workflow cannot tell when it was live. Excluded from active-project and delivery-load counts.',
    });
  }

  // ---- status -----------------------------------------------
  let status = null;
  if (!rawStatus) {
    recIssues.push('missing status');
    issues.push({
      source: 'delivery', severity: 'warning', code: 'MISSING_STATUS', record_id: recordId,
      message: 'Project ' + recordId + ' has no status. Excluded from active, blocked and completed counts.',
    });
  } else {
    status = STATUS_MAP[rawStatus.toLowerCase()] || null;
    if (!status) {
      recIssues.push('unrecognised status "' + rawStatus + '"');
      issues.push({
        source: 'delivery', severity: 'warning', code: 'UNKNOWN_STATUS', record_id: recordId,
        message: 'Project ' + recordId + ' has an unrecognised status "' + rawStatus + '". Excluded from status-based counts.',
      });
    }
  }

  // ---- cross-field sanity -----------------------------------
  // These catch the errors a per-field validator cannot see. A project
  // marked Completed with no completed date will silently vanish from the
  // completed count, and without this line nobody would know why.
  if (status === 'Completed' && !completed) {
    recIssues.push('completed with no completed date');
    issues.push({
      source: 'delivery', severity: 'warning', code: 'MISSING_COMPLETED_DATE', record_id: recordId,
      message: 'Project ' + recordId + ' is marked Completed but has no completed date. It cannot be placed in a period and is excluded from completion, on-time and budget metrics.',
    });
  }
  if (status === 'Completed' && !due) {
    issues.push({
      source: 'delivery', severity: 'warning', code: 'MISSING_DUE_DATE', record_id: recordId,
      message: 'Project ' + recordId + ' completed without a due date. Counted as completed, excluded from the on-time completion rate (which has no baseline to measure against).',
    });
  }
  if (status === 'Completed' && actual === null) {
    issues.push({
      source: 'delivery', severity: 'warning', code: 'MISSING_ACTUAL_COST', record_id: recordId,
      message: 'Project ' + recordId + ' completed with no actual cost. Counted as completed, excluded from budget variance and the over-budget count.',
    });
  }
  if (status === 'Completed' && budgeted === null) {
    issues.push({
      source: 'delivery', severity: 'warning', code: 'MISSING_BUDGET', record_id: recordId,
      message: 'Project ' + recordId + ' completed with no budgeted cost. Excluded from budget variance.',
    });
  }
  if (kickoff && completed && daysBetween(kickoff, completed) < 0) {
    recIssues.push('completed before kickoff');
    issues.push({
      source: 'delivery', severity: 'warning', code: 'IMPLAUSIBLE_DATES', record_id: recordId,
      message: 'Project ' + recordId + ' has a completed date (' + completed + ') before its kickoff date (' + kickoff + '). Dates kept as given; treat its timeline metrics with caution.',
    });
  }
  if (status !== 'Completed' && completed) {
    issues.push({
      source: 'delivery', severity: 'info', code: 'STATUS_DATE_MISMATCH', record_id: recordId,
      message: 'Project ' + recordId + ' has a completed date but its status is "' + (status || rawStatus || 'blank') + '". Status is treated as the source of truth.',
    });
  }

  let duplicate = false;
  if (projectId) {
    if (seenIds.has(projectId)) {
      duplicate = true;
      issues.push({
        source: 'delivery', severity: 'warning', code: 'DUPLICATE_RECORD', record_id: recordId,
        message: 'Project ' + recordId + ' appears more than once in the source. Only the first copy is counted.',
      });
    }
    seenIds.add(projectId);
  }

  // ---- derived ----------------------------------------------
  const delayDays = (due && completed) ? daysBetween(due, completed) : null;

  out.push({
    json: {
      _source: 'delivery',
      project_id: recordId,
      project_name: name,
      team: team || 'Unassigned',
      owner: owner || 'Unassigned',
      kickoff_date: kickoff,
      due_date: due,
      completed_date: completed,
      status: status,
      status_raw: rawStatus,
      budgeted_cost: budgeted,
      actual_cost: actual,
      // Positive = late by n days, 0 = on the day, negative = early.
      delay_days: delayDays,
      // null, not 0 - "we do not know" must not read as "on budget".
      budget_variance: (budgeted !== null && actual !== null) ? (actual - budgeted) : null,
      // The window this project was live for. `null` end means still open.
      // The metrics node intersects this with the reporting period.
      live_from: kickoff,
      live_to: completed,
      is_duplicate: duplicate,
      usable_for_period: Boolean(kickoff || completed) && !duplicate,
      record_issues: recIssues,
    },
  });

  if (!team) {
    issues.push({
      source: 'delivery', severity: 'warning', code: 'MISSING_TEAM', record_id: recordId,
      message: 'Project ' + recordId + ' has no team. Grouped under "Unassigned" in delivery load.',
    });
  }

  // All three dates, not just one: a project that kicked off in April and
  // completed in June is inside both windows, and a warning about it should
  // appear in whichever one the reader has selected.
  const stamp = [kickoff, due, completed].filter(function (d) { return Boolean(d); });
  for (let i = issueStart; i < issues.length; i++) {
    issues[i].record_dates = stamp;
  }
}

if (out.length === 0) {
  issues.push({
    source: 'delivery', severity: 'error', code: 'NO_RECORDS', record_id: null,
    message: 'The Project Delivery source returned no usable rows. Every delivery metric in this report is unavailable, not zero.',
  });
}

// An exact multiple of the page size means the fetch stopped precisely where
// a page ends. That is either a genuine coincidence or a silently truncated
// read, and the difference is invisible from here - so say so rather than
// reporting a confident number built on a partial table. Every delivery
// metric is a count or an average over the set, so truncation understates
// all of them at once and nothing downstream would notice.
if (rows.length > 0 && rows.length % AIRTABLE_PAGE_SIZE === 0) {
  issues.push({
    source: 'delivery', severity: 'error', code: 'POSSIBLE_TRUNCATION', record_id: null,
    message: 'The Project Delivery source returned exactly ' + rows.length + ' records, which is a whole number of Airtable pages. Airtable pages at ' + AIRTABLE_PAGE_SIZE + ' records, so this is very likely a truncated read rather than the whole table. Check that "Return All" is enabled on the Airtable node. Every delivery metric in this report may be understated.',
  });
}

if (out.length > 0) out[0].json._source_issues = issues;
else out.push({ json: { _source: 'delivery', _empty: true, _source_issues: issues } });

return out;
