// n8n Code node: Validate Fields & Check Duplicates
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Validate Fields & Check Duplicates      (Run Once for ALL Items)
//
// Runs over the WHOLE batch in one pass so that two copies of the same
// invoice arriving in the SAME polling window are caught. The previous
// per-item version could only see rows already written to the sheet,
// which is why TP-01 and TP-05 both got logged when they arrived together.
//
// Three duplicate keys, checked in order:
//   1. gmail_message_id + file reference  (the same email re-processed)
//   2. invoice_number + sender_email      (the same invoice, resent)
//   3. vendor + amount + invoice_date     (resent with no invoice number)
// ============================================================

const norm = function (v) { return (v === null || v === undefined) ? '' : String(v).trim().toLowerCase(); };
const money = function (v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? String(n) : '';
};

// ---- 1. seed the sets from rows already in the sheet ---------
const seenMessage = new Set();
const seenInvoice = new Set();
const seenFingerprint = new Set();
const seenAny = new Set();

let existing = [];
try { existing = $('Fetch All Existing Sheet Records').all(); } catch (e) { existing = []; }

for (const it of existing) {
  const r = it.json || {};
  if (r.error) continue;
  const mid = norm(r['Gmail Message ID']);
  const file = norm(r['File Reference']);
  const inv = norm(r['Invoice Number']);
  const snd = norm(r['Sender Email']);
  const ven = norm(r['Vendor Name']);
  const amt = money(r['Total Amount']);
  const dat = norm(r['Invoice Date']);

  if (mid) seenMessage.add(mid + '|' + file);
  if (inv && snd) seenInvoice.add(inv + '|' + snd);
  if (ven && amt && amt !== '0') seenFingerprint.add(ven + '|' + amt + '|' + dat);

  // last-resort key so a failure row with no vendor, no amount and no
  // invoice number still cannot be appended twice
  const kAnySeed = [mid, file, norm(r['Email Subject']), norm(r['Processing Status'])]
    .filter(Boolean).join('|');
  if (kAnySeed) seenAny.add(kAnySeed);
}

// ---- 2. walk this batch in arrival order --------------------
const out = [];

for (const item of $input.all()) {
  const d = item.json || {};

  const vendor = d.vendor_name || '';
  const invoiceNo = d.invoice_number || '';
  const amount = (d.total_amount === null || d.total_amount === undefined || isNaN(d.total_amount))
    ? null : Number(d.total_amount);
  const currency = d.currency || '';
  const invDate = d.invoice_date || '';
  const dueDate = d.due_date || '';

  const notes = [];
  let status;

  if (d.is_unreadable) {
    status = 'failed';
    notes.push(d.extraction_error || 'Attachment could not be read');
    notes.push('No fields extracted - nothing was invented');
  } else {
    const missing = [];
    if (!vendor) missing.push('vendor_name');
    if (amount === null) missing.push('total_amount');
    if (!currency) missing.push('currency');
    if (!invoiceNo) missing.push('invoice_number');
    if (!invDate && !dueDate) missing.push('invoice_date/due_date');

    if (missing.length === 0) {
      status = 'processed';
    } else if (!vendor && amount === null) {
      status = 'failed';
      notes.push('Missing: ' + missing.join(', '));
    } else {
      status = 'processed_with_warnings';
      notes.push('Missing: ' + missing.join(', '));
    }

    // format checks - flag, never rewrite
    if (invDate && !/^\d{4}-\d{2}-\d{2}$/.test(invDate)) notes.push('invoice_date is not ISO YYYY-MM-DD');
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) notes.push('due_date is not ISO YYYY-MM-DD');
    if (currency && !/^[A-Z]{3}$/.test(currency)) notes.push('currency is not a 3-letter ISO code');
    if (amount !== null && amount <= 0) notes.push('total_amount is not positive');
    if (d.is_credit_note) notes.push('Document is a credit note, not a charge');
  }

  // ---- duplicate keys ---------------------------------------
  const mid = norm(d.gmail_message_id);
  const file = norm(d.attachment_filename);
  const kMsg = mid ? mid + '|' + file : '';
  const kInv = (invoiceNo && d.sender_email) ? norm(invoiceNo) + '|' + norm(d.sender_email) : '';
  const amtKey = money(amount);
  const kFp = (vendor && amtKey && amtKey !== '0') ? norm(vendor) + '|' + amtKey + '|' + norm(invDate) : '';

  const kAny = [mid, file, norm(d.subject), status].filter(Boolean).join('|');

  // Stable identity for this invoice. Written to the sheet as Row Key and
  // used by Google Sheets "Append or Update" as the matching column.
  // This is the safety net that makes the write idempotent: a retry after
  // a partial write, a re-run, or n8n splitting a branch into several runs
  // all land on the SAME row instead of adding another one.
  let rowKey;
  if (kInv) rowKey = 'inv:' + kInv;
  else if (kFp) rowKey = 'fp:' + kFp;
  else rowKey = 'msg:' + (mid || norm(d.subject)) + '|' + file;

  let isDup = false;
  let dupReason = '';
  if (kMsg && seenMessage.has(kMsg)) {
    isDup = true; dupReason = 'same Gmail message and file already logged';
  } else if (kInv && seenInvoice.has(kInv)) {
    isDup = true; dupReason = 'invoice ' + invoiceNo + ' from ' + d.sender_email + ' already logged';
  } else if (kFp && seenFingerprint.has(kFp)) {
    isDup = true; dupReason = 'same vendor, amount and date already logged (no invoice number to match on)';
  } else if (kAny && seenAny.has(kAny)) {
    isDup = true; dupReason = 'identical row already logged for this message and file';
  }

  // claim the keys immediately, so the 2nd copy in THIS batch is a duplicate
  if (kMsg) seenMessage.add(kMsg);
  if (kInv) seenInvoice.add(kInv);
  if (kFp) seenFingerprint.add(kFp);
  if (kAny) seenAny.add(kAny);

  out.push({
    json: {
      'Vendor Name': vendor,
      'Sender Email': d.sender_email || '',
      'Invoice Number': invoiceNo,
      'Invoice Date': invDate,
      'Due Date': dueDate,
      'Total Amount': amount === null ? '' : amount,
      'Currency': currency,
      'Description': d.description || '',
      'Source Type': d.source_type || '',
      'File Reference': d.attachment_filename || '',
      'Extraction Method': d.extraction_method || '',
      'Processing Status': status,
      'Error Note': notes.join('; '),
      'Gmail Message ID': d.gmail_message_id || '',
      'Email Subject': d.subject || '',
      'Row Key': rowKey,
      'Processed At': new Date().toISOString(),
      _is_duplicate: isDup,
      _duplicate_reason: dupReason,
      _message_id: d.gmail_message_id || '',
    },
  });
}

return out;
