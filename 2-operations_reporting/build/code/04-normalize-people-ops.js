// n8n Code node: Normalize People Ops
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Normalize People Ops (HTTP API)         (Run Once for ALL Items)
//
// The API answers with ONE item: { source, record_count, records: [...] }.
// This node unrolls it, types each record, and flags what is wrong.
//
// WHY THE HTTP NODE FETCHES THE WHOLE DATASET AND FILTERS HERE
// ------------------------------------------------------------
// The API accepts ?start= and ?end=. Using them looks like the efficient
// choice and it is the wrong one, because the five People Ops metrics each
// key off a DIFFERENT date:
//
//   applications   -> application_date in the window
//   offers         -> offer_accepted_date in the window
//   new hires      -> start_date in the window
//   exits          -> exit_date in the window
//   headcount      -> started on or before the window END and had not left
//                     -> needs people who started in 2025, years outside it
//
// One server-side range cannot serve all five. Ask for June only and
// headcount collapses from ~80 to a handful, and the number still looks
// perfectly plausible on a dashboard. The dataset is 92 records; pulling
// all of it costs one request. Correctness wins by a mile.
//
// STATUS IS A CROSS-CHECK, NOT THE SOURCE OF TRUTH FOR HEADCOUNT
// --------------------------------------------------------------
// Headcount is derived from DATES: started on or before period end, and no
// exit date on or before period end. A record with a blank status therefore
// still counts correctly, and a record marked Active with a start date in
// the future correctly does NOT. Both are still reported as data quality
// issues - handled is not the same as hidden.
// ============================================================

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUS = ['Active', 'Exited', 'Candidate'];

function isValidISODate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}

const issues = [];
const out = [];
const seenIds = new Set();

// ---- unwrap the response ------------------------------------
// Tolerate: the documented envelope, a bare array, or n8n having already
// split the array into items. All three shapes have shown up in testing
// depending on how the HTTP node's response options are set.
let records = [];
let envelope = {};
const items = $input.all();

for (const item of items) {
  const j = item.json || {};

  if (j.error) {
    issues.push({
      source: 'people_ops', severity: 'error', code: 'SOURCE_ERROR', record_id: null,
      message: 'The People Ops API request failed: ' + String(j.error && (j.error.message || j.error) || j.error).slice(0, 200),
    });
    continue;
  }

  if (Array.isArray(j.records)) {
    envelope = j;
    records = records.concat(j.records);
  } else if (Array.isArray(j)) {
    records = records.concat(j);
  } else if (j.employee_id !== undefined) {
    records.push(j);
  }
}

// The API tells us how many records exist in total. If we received fewer,
// something truncated the response and every headcount number is understated.
// A silently short read is the single most dangerous failure this source has,
// because nothing about the output looks wrong.
const declared = Number(envelope.record_count);
const available = Number(envelope.total_available_records);
if (Number.isFinite(declared) && declared !== records.length) {
  issues.push({
    source: 'people_ops', severity: 'error', code: 'TRUNCATED_RESPONSE', record_id: null,
    message: 'The API declared ' + declared + ' records but ' + records.length + ' were received. People Ops metrics are incomplete.',
  });
}
if (Number.isFinite(available) && Number.isFinite(declared) && declared < available) {
  issues.push({
    source: 'people_ops', severity: 'warning', code: 'FILTERED_RESPONSE', record_id: null,
    message: 'The API returned ' + declared + ' of ' + available + ' records, so a server-side filter was applied. Headcount and attrition need the unfiltered set to be correct.',
  });
}

let index = 0;
for (const rec of records) {
  index += 1;
  const r = rec || {};
  // Issues raised for this employee are stamped with the employee's own
  // lifecycle dates below, so a warning can be matched to the reporting
  // window rather than shown under every period regardless.
  const issueStart = issues.length;

  const employeeId = str(r.employee_id) || ('people-row-' + index);
  const department = str(r.department);
  const role = str(r.role);
  const rawStatus = str(r.status);
  const recIssues = [];

  function readDate(value, label, required) {
    const v = str(value);
    if (!v) {
      if (required) {
        recIssues.push('blank ' + label);
        issues.push({
          source: 'people_ops', severity: 'warning', code: 'BLANK_DATE', record_id: employeeId,
          message: 'Employee ' + employeeId + ' has no ' + label + '. Excluded from metrics that depend on it.',
        });
      }
      return null;
    }
    if (!isValidISODate(v)) {
      recIssues.push('invalid ' + label + ' "' + v + '"');
      issues.push({
        source: 'people_ops', severity: 'warning', code: 'INVALID_DATE', record_id: employeeId,
        message: 'Employee ' + employeeId + ' has an invalid ' + label + ' "' + v + '". Treated as missing.',
      });
      return null;
    }
    return v;
  }

  const applicationDate = readDate(r.application_date, 'application date', true);
  const offerDate = readDate(r.offer_accepted_date, 'offer accepted date', false);
  const startDate = readDate(r.start_date, 'start date', false);
  const exitDate = readDate(r.exit_date, 'exit date', false);

  // ---- status -----------------------------------------------
  let status = null;
  if (!rawStatus) {
    recIssues.push('missing status');
    issues.push({
      source: 'people_ops', severity: 'warning', code: 'MISSING_STATUS', record_id: employeeId,
      message: 'Employee ' + employeeId + ' has a blank status. Headcount is derived from start and exit dates, so this record is still counted correctly, but its lifecycle stage cannot be confirmed.',
    });
  } else if (VALID_STATUS.indexOf(rawStatus) === -1) {
    const match = VALID_STATUS.filter(function (s) { return s.toLowerCase() === rawStatus.toLowerCase(); })[0];
    if (match) { status = match; }
    else {
      recIssues.push('unrecognised status "' + rawStatus + '"');
      issues.push({
        source: 'people_ops', severity: 'warning', code: 'UNKNOWN_STATUS', record_id: employeeId,
        message: 'Employee ' + employeeId + ' has an unrecognised status "' + rawStatus + '".',
      });
    }
  } else {
    status = rawStatus;
  }

  if (!department) {
    recIssues.push('missing department');
    issues.push({
      source: 'people_ops', severity: 'warning', code: 'MISSING_DEPARTMENT', record_id: employeeId,
      message: 'Employee ' + employeeId + ' has no department. Grouped under "Unassigned" in the headcount breakdown.',
    });
  }

  // ---- cross-field sanity -----------------------------------
  if (status === 'Exited' && !exitDate) {
    issues.push({
      source: 'people_ops', severity: 'warning', code: 'MISSING_EXIT_DATE', record_id: employeeId,
      message: 'Employee ' + employeeId + ' is marked Exited but has no exit date. They will still be counted in headcount, and are missing from the exit count.',
    });
  }
  if (exitDate && status !== 'Exited') {
    issues.push({
      source: 'people_ops', severity: 'info', code: 'STATUS_DATE_MISMATCH', record_id: employeeId,
      message: 'Employee ' + employeeId + ' has an exit date but a status of "' + (status || 'blank') + '". Dates drive headcount, so the exit is honoured.',
    });
  }
  if (applicationDate && startDate && daysBetween(applicationDate, startDate) < 0) {
    recIssues.push('start date before application date');
    issues.push({
      source: 'people_ops', severity: 'warning', code: 'IMPLAUSIBLE_DATES', record_id: employeeId,
      message: 'Employee ' + employeeId + ' has a start date (' + startDate + ') before their application date (' + applicationDate + '). Excluded from time to hire.',
    });
  }
  if (startDate && exitDate && daysBetween(startDate, exitDate) < 0) {
    issues.push({
      source: 'people_ops', severity: 'warning', code: 'IMPLAUSIBLE_DATES', record_id: employeeId,
      message: 'Employee ' + employeeId + ' has an exit date (' + exitDate + ') before their start date (' + startDate + ').',
    });
  }

  let duplicate = false;
  if (str(r.employee_id)) {
    if (seenIds.has(employeeId)) {
      duplicate = true;
      issues.push({
        source: 'people_ops', severity: 'warning', code: 'DUPLICATE_RECORD', record_id: employeeId,
        message: 'Employee ' + employeeId + ' appears more than once in the API response. Only the first copy is counted.',
      });
    }
    seenIds.add(employeeId);
  }

  const timeToHire = (applicationDate && startDate && daysBetween(applicationDate, startDate) >= 0)
    ? daysBetween(applicationDate, startDate) : null;
  const offerTime = (applicationDate && offerDate && daysBetween(applicationDate, offerDate) >= 0)
    ? daysBetween(applicationDate, offerDate) : null;

  // An employment record spans up to four dates and can legitimately touch
  // several reporting windows. All of them are stamped; the window test
  // downstream is "any of these dates falls inside".
  const stamp = [applicationDate, offerDate, startDate, exitDate]
    .filter(function (d) { return Boolean(d); });
  for (let i = issueStart; i < issues.length; i++) {
    issues[i].record_dates = stamp;
  }

  out.push({
    json: {
      _source: 'people_ops',
      employee_id: employeeId,
      department: department || 'Unassigned',
      role: role,
      application_date: applicationDate,
      offer_accepted_date: offerDate,
      start_date: startDate,
      exit_date: exitDate,
      status: status,
      status_raw: rawStatus,
      time_to_hire_days: timeToHire,
      offer_acceptance_days: offerTime,
      is_duplicate: duplicate,
      usable_for_period: !duplicate,
      record_issues: recIssues,
    },
  });
}

if (out.length === 0) {
  issues.push({
    source: 'people_ops', severity: 'error', code: 'NO_RECORDS', record_id: null,
    message: 'The People Ops API returned no usable records. Every People Ops metric in this report is unavailable, not zero.',
  });
}

if (out.length > 0) out[0].json._source_issues = issues;
else out.push({ json: { _source: 'people_ops', _empty: true, _source_issues: issues } });

return out;
