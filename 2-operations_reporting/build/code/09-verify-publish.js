// n8n Code node: Verify Publish
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Verify Publish                          (Run Once for ALL Items)
//
// The write is now a single transaction, which removes the partial-write
// problem but introduces a quieter one: with nine HTTP calls, nine things
// could visibly fail. With one, a 2xx is the only signal — and a 2xx means
// Postgres accepted the call, not that the rows the workflow built are the
// rows that landed.
//
// publish_report() returns its own count per table. This compares those
// against what was actually sent, and fails the run if they disagree. It is
// cheap, and it is the difference between "the database said OK" and "the
// report is there".
// ============================================================

const sent = $('Build Supabase Payloads').first().json;
const res = $input.first().json || {};

// PostgREST returns a scalar-returning function as the bare value, but some
// versions wrap it. Accept both rather than guessing.
const body = (res && typeof res === 'object' && res.ok === undefined && res.publish_report)
  ? res.publish_report
  : res;

if (body && body.error) {
  throw new Error(
    'publish_report was rejected by Postgres: ' +
    String(body.message || body.error) +
    (body.details ? ' — ' + body.details : '')
  );
}

if (!body || body.ok !== true) {
  throw new Error(
    'publish_report did not confirm success. Response was: ' +
    JSON.stringify(body).slice(0, 400)
  );
}

// The function counts rows it inserted; the payload counts rows it was
// given. report_insights is not in row_counts because it is always exactly
// one, so it is checked separately.
const expected = Object.assign({}, sent.row_counts, { report_insights: 1 });
const actual = body.rows || {};

const mismatches = [];
for (const table of Object.keys(expected)) {
  const want = Number(expected[table] || 0);
  const got = Number(actual[table]);
  if (!Number.isFinite(got)) {
    mismatches.push(table + ': Postgres reported no count');
  } else if (got !== want) {
    mismatches.push(table + ': sent ' + want + ', wrote ' + got);
  }
}

if (mismatches.length) {
  // Rolling back is not an option here — the transaction already committed.
  // Failing loudly is, and it puts the discrepancy in the execution log
  // where it can be read, rather than leaving a quietly wrong dashboard.
  throw new Error(
    'The report published but the row counts do not match what was sent:\n  ' +
    mismatches.join('\n  ') +
    '\nRun ' + sent.run_id + ' is on the dashboard and should be treated as suspect.'
  );
}

const total = Object.keys(actual).reduce(function (a, k) { return a + Number(actual[k] || 0); }, 0);

return [{
  json: {
    ok: true,
    run_id: body.run_id,
    publish_state: body.publish_state,
    rows_written: actual,
    total_rows: total,
    message: 'Published ' + body.run_id + ' — ' + total + ' rows across ' +
             Object.keys(actual).length + ' tables, in one transaction.',
  },
}];
