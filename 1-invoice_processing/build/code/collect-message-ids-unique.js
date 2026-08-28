// n8n Code node: Collect Message IDs (Unique)
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Collect Message IDs (Unique)            (Run Once for ALL Items)
//
// Every terminal branch feeds in here:
//   - Append Invoice Row to Sheet  (processed / warnings / failed)
//   - Ignore Duplicate Invoice     (duplicate_skipped)
//   - Ignore Non-Invoice Email     (not_an_invoice)
//
// Jobs:
//   1. Drop items with blank / missing Gmail message ID
//   2. Deduplicate: 1 Gmail call per message (even if multi-attachment)
//   3. Outcome hierarchy: if any attachment was an invoice, the email
//      is treated as an invoice ('processed' beats 'not_an_invoice')
//   4. Pass `is_invoice: boolean` explicitly so 'Was It an Invoice?' works!
// ============================================================

const RANK = {
  processed: 4,
  processed_with_warnings: 4,
  failed: 4,
  duplicate_skipped: 3,
  not_an_invoice: 1,
};

const best = new Map();

for (const item of $input.all()) {
  const j = item.json || {};
  const id = j._message_id || j['Gmail Message ID'] || j.gmail_message_id || j.message_id || j.id || '';

  if (!id || typeof id !== 'string' || !id.trim()) continue;
  const key = id.trim();

  let outcome = 'processed';
  if (j._is_duplicate === true) {
    outcome = 'duplicate_skipped';
  } else if (j.is_invoice === false && !j['Processing Status']) {
    outcome = 'not_an_invoice';
  } else if (j['Processing Status']) {
    outcome = j['Processing Status'];
  } else if (j.is_invoice === true) {
    outcome = 'processed';
  }

  const rank = RANK[outcome] || 2;
  const prev = best.get(key);
  if (prev && prev.rank >= rank) continue;

  const isInvoice = outcome !== 'not_an_invoice';

  best.set(key, {
    rank: rank,
    json: {
      message_id: key,
      subject: j['Email Subject'] || j.subject || '',
      outcome: outcome,
      is_invoice: isInvoice,
    },
  });
}

return Array.from(best.values()).map(function (e) {
  return { json: e.json };
});
