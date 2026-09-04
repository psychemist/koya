// n8n Code node: Normalize Sales
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Normalize Sales (Google Sheets)         (Run Once for ALL Items)
//
// Turns whatever the Sheets node hands back into typed, canonical records
// plus an explicit list of everything wrong with them.
//
// TWO RULES THIS NODE NEVER BREAKS:
//
// 1. A BAD RECORD IS NEVER SILENTLY DROPPED. It is kept, marked
//    usable_for_period = false, and the reason is attached to it. The
//    metrics node then decides, metric by metric, whether it can be used.
//    Deleting the row here would make the count quietly wrong and nobody
//    would ever know which rows went missing.
//
// 2. A MISSING NUMBER IS null, NEVER 0. "Closed Won with no amount" and
//    "Closed Won for nothing" are different facts. Coercing blank to zero
//    silently understates revenue and there is no way to detect it later.
//
// 3. EVERY ISSUE CARRIES THE DATES OF THE RECORD IT CAME FROM, in
//    `record_dates`. Without them the dashboard's data quality panel is a
//    list about the whole spreadsheet shown under a heading that says
//    "Last 30 days" - warnings about leads from March sitting under a June
//    report, inflating the warning badge for records the numbers above
//    never touched. Compute Metrics uses these dates to decide which
//    issues belong to the selected window. An issue with no dates at all
//    (a source outage, an undated row) belongs to every window, and is
//    marked as such rather than silently dropped.
//
// THE marketing_spend TRAP
// ------------------------
// marketing_spend is NOT a per-lead cost. The source carries ONE budget
// figure per calendar month, repeated on every row of that month. Summing
// the column over the full history gives 291,800 against a true spend of
// 33,500 - inflated 8.7x, and cost per lead inflated with it. So this node
// only tags each row with its month; the metrics node collapses month to a
// single figure. See computeMarketingSpend() in Compute Metrics.
// ============================================================

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Canonical status vocabulary. The source is clean today; a hand-edited
// sheet will not be, so accept the obvious variants rather than dropping
// a real deal over a lowercase 'w'.
const STATUS_MAP = {
  'closed won': 'Closed Won', 'closedwon': 'Closed Won', 'won': 'Closed Won',
  'closed lost': 'Closed Lost', 'closedlost': 'Closed Lost', 'lost': 'Closed Lost',
  'qualified': 'Qualified',
  'proposal sent': 'Proposal Sent', 'proposal': 'Proposal Sent',
};

function isValidISODate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s; // rejects 2026-02-30
}

// Accepts a bare number, "3,500", "$3,500.00", " 3500 ". Returns null for
// anything it cannot read - including the empty string. Never returns 0
// unless the source genuinely said zero.
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

// Sheets and Airtable both hand back column names with whatever casing and
// spacing the header row happens to have. Read through a normalised map so
// a renamed "Deal Amount" does not become a silent null.
function field(row, names) {
  const keys = Object.keys(row);
  const norm = {};
  for (const k of keys) norm[k.toLowerCase().replace(/[\s_\-]/g, '')] = row[k];
  for (const n of names) {
    const key = n.toLowerCase().replace(/[\s_\-]/g, '');
    if (norm[key] !== undefined) return norm[key];
  }
  return undefined;
}

const rows = $input.all();
const out = [];
const issues = [];
const seenLeadIds = new Set();

let index = 0;
for (const item of rows) {
  const row = item.json || {};
  index += 1;

  // The Sheets node with onError=continue emits an error item rather than
  // throwing. That is a source failure, not a data problem - it must not be
  // mistaken for "the sheet was empty".
  if (row.error) {
    issues.push({
      source: 'sales', severity: 'error', code: 'SOURCE_ERROR',
      record_id: null,
      message: 'Google Sheets returned an error: ' + String(row.error).slice(0, 200),
    });
    continue;
  }

  const leadId = str(field(row, ['lead_id', 'leadid', 'id']));
  const rawDate = str(field(row, ['date', 'lead_date', 'created_date']));
  const rawStatus = str(field(row, ['status', 'deal_status', 'stage']));
  const rawAmount = field(row, ['deal_amount', 'amount', 'value']);
  const rawSpend = field(row, ['marketing_spend', 'spend']);
  const rawSource = str(field(row, ['lead_source', 'source', 'channel']));

  // A row with no identifier and no date is not a lead, it is a blank line
  // left at the bottom of a spreadsheet. Skip it without noise - flagging
  // trailing blanks as data quality issues trains people to ignore the list.
  if (!leadId && !rawDate && !rawStatus && rawAmount === undefined) continue;

  const recordId = leadId || ('sales-row-' + index);
  const recIssues = [];
  // Everything pushed to `issues` from here to the end of this iteration
  // belongs to this record, and gets stamped with its dates below.
  const issueStart = issues.length;

  // ---- date -------------------------------------------------
  let date = null;
  if (!rawDate) {
    recIssues.push('blank date');
    issues.push({
      source: 'sales', severity: 'warning', code: 'BLANK_DATE', record_id: recordId,
      message: 'Lead ' + recordId + ' has no date. It cannot be placed in a reporting period and is excluded from every period metric.',
    });
  } else if (!isValidISODate(rawDate)) {
    recIssues.push('invalid date "' + rawDate + '"');
    issues.push({
      source: 'sales', severity: 'warning', code: 'INVALID_DATE', record_id: recordId,
      message: 'Lead ' + recordId + ' has an invalid date "' + rawDate + '" (not a real calendar date in YYYY-MM-DD). Excluded from every period metric.',
    });
  } else {
    date = rawDate;
  }

  // ---- status -----------------------------------------------
  let status = null;
  if (!rawStatus) {
    recIssues.push('missing status');
    issues.push({
      source: 'sales', severity: 'warning', code: 'MISSING_STATUS', record_id: recordId,
      message: 'Lead ' + recordId + ' has no status. It still counts as a lead but is excluded from win rate, pipeline value and revenue.',
    });
  } else {
    const mapped = STATUS_MAP[rawStatus.toLowerCase()];
    if (mapped) {
      status = mapped;
      if (mapped !== rawStatus) {
        issues.push({
          source: 'sales', severity: 'info', code: 'STATUS_NORMALIZED', record_id: recordId,
          message: 'Lead ' + recordId + ' status "' + rawStatus + '" was read as "' + mapped + '".',
        });
      }
    } else {
      recIssues.push('unrecognised status "' + rawStatus + '"');
      issues.push({
        source: 'sales', severity: 'warning', code: 'UNKNOWN_STATUS', record_id: recordId,
        message: 'Lead ' + recordId + ' has an unrecognised status "' + rawStatus + '". Counted as a lead only.',
      });
    }
  }

  // ---- amount -----------------------------------------------
  const amount = num(rawAmount);
  const isClosedWon = status === 'Closed Won';
  const isOpen = status === 'Qualified' || status === 'Proposal Sent';

  if (amount === null && (isClosedWon || isOpen)) {
    // Only a problem where the amount is actually used. A Closed Lost deal
    // with no amount changes nothing, so it raises nothing.
    recIssues.push('missing deal amount');
    issues.push({
      source: 'sales', severity: 'warning', code: 'MISSING_AMOUNT', record_id: recordId,
      message: 'Lead ' + recordId + ' is "' + status + '" but has no deal amount. It is counted in the deal count and excluded from ' + (isClosedWon ? 'revenue won' : 'pipeline value') + '.',
    });
  }
  if (amount !== null && amount < 0) {
    recIssues.push('negative deal amount');
    issues.push({
      source: 'sales', severity: 'warning', code: 'NEGATIVE_AMOUNT', record_id: recordId,
      message: 'Lead ' + recordId + ' has a negative deal amount (' + amount + '). Kept as-is; it will pull totals down.',
    });
  }

  // ---- lead source ------------------------------------------
  let leadSource = rawSource;
  if (!leadSource) {
    leadSource = 'Unattributed';
    recIssues.push('missing lead source');
    issues.push({
      source: 'sales', severity: 'warning', code: 'MISSING_LEAD_SOURCE', record_id: recordId,
      message: 'Lead ' + recordId + ' has no lead source. Grouped under "Unattributed" so its revenue is not lost from the source breakdown.',
    });
  }

  // ---- duplicate guard --------------------------------------
  // A re-export appended to the sheet instead of replacing it is the most
  // common way this source breaks. Second copy of a lead_id is dropped from
  // the metrics and named, rather than quietly doubling revenue.
  let duplicate = false;
  if (leadId) {
    if (seenLeadIds.has(leadId)) {
      duplicate = true;
      issues.push({
        source: 'sales', severity: 'warning', code: 'DUPLICATE_RECORD', record_id: recordId,
        message: 'Lead ' + recordId + ' appears more than once in the source. Only the first copy is counted.',
      });
    }
    seenLeadIds.add(leadId);
  }

  // Stamp this record's dates onto every issue it raised. An undated lead
  // gets an empty list, which reads as "affects every period" downstream -
  // correct, because a lead with no date is excluded from all of them.
  for (let i = issueStart; i < issues.length; i++) {
    issues[i].record_dates = date ? [date] : [];
  }

  out.push({
    json: {
      _source: 'sales',
      lead_id: recordId,
      date: date,
      status: status,
      status_raw: rawStatus,
      deal_amount: amount,
      marketing_spend: num(rawSpend),
      spend_month: date ? date.slice(0, 7) : null,
      lead_source: leadSource,
      is_duplicate: duplicate,
      // usable_for_period drives every period filter downstream. No date =
      // no period = cannot be counted, however complete the rest of the row.
      usable_for_period: Boolean(date) && !duplicate,
      record_issues: recIssues,
    },
  });
}

if (out.length === 0) {
  issues.push({
    source: 'sales', severity: 'error', code: 'NO_RECORDS', record_id: null,
    message: 'The Sales source returned no usable rows. Every sales metric in this report is unavailable, not zero.',
  });
}

// Issues ride on the FIRST item so a single Code node output carries both
// the records and the diagnostics without a second branch to merge back in.
if (out.length > 0) out[0].json._source_issues = issues;
else out.push({ json: { _source: 'sales', _empty: true, _source_issues: issues } });

return out;
