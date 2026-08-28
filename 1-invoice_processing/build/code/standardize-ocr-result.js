// n8n Code node: Standardize OCR Result
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Standardize OCR Result                  (Run Once for ALL Items)
//
// Metadata comes from Re-attach PDF Binary, NOT from PDF to Base64.
// Extract From File (Move File to Base64 String) REPLACES the item json
// with a fresh object holding only the base64, so reading metadata off
// it produced blank gmail_message_id / sender / filename - which in turn
// left the row with no duplicate key and no id to mark read.
// Re-attach PDF Binary is 1:1 and order-preserving with PDF to Base64.
// ============================================================
const metas = $('Re-attach PDF Binary').all();

const num = function (v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const str = function (v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return (s === '' || /^(null|n\/a|none|unknown|not specified|not stated|not provided)$/i.test(s)) ? '' : s;
};
const parseLoose = function (t) {
  const fenced = String(t).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : String(t);
  const a = candidate.indexOf('{');
  const b = candidate.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('no JSON object in the reply');
  return JSON.parse(candidate.slice(a, b + 1));
};


// --- tolerant field mapper ------------------------------------
// A vision model handed a raw invoice will often answer in its own
// natural document shape ({from:{name}, line_items:[], total, ...})
// instead of the requested keys. Rather than trust the prompt alone,
// map the shapes we actually see. Only issuer-side keys are ever
// consulted for vendor_name - bill_to / ship_to / customer are the
// PAYER and must never be picked up as the vendor.
const dig = function (o, path) {
  return path.split('.').reduce(function (a, k) {
    return (a && typeof a === 'object') ? a[k] : undefined;
  }, o);
};
const pickStr = function (o, paths) {
  for (const p of paths) {
    const v = dig(o, p);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};
const pickNum = function (o, paths) {
  for (const p of paths) {
    const n = num(dig(o, p));
    if (n !== null) return n;
  }
  return null;
};
const VENDOR_PATHS = ['vendor_name', 'vendor', 'from.name', 'from.company', 'seller.name',
                      'supplier.name', 'issuer.name', 'company.name', 'from'];
const NUMBER_PATHS = ['invoice_number', 'invoice_no', 'invoiceNumber', 'invoice_id',
                      'invoice.number', 'number'];
const IDATE_PATHS  = ['invoice_date', 'issue_date', 'issued_date', 'issued', 'date'];
const DDATE_PATHS  = ['due_date', 'dueDate', 'payment_due', 'due'];
const TOTAL_PATHS  = ['total_amount', 'balance_due', 'amount_due', 'total_due',
                      'grand_total', 'total'];
const CURR_PATHS   = ['currency', 'currency_code'];

const mapFields = function (x) {
  let desc = pickStr(x, ['description', 'summary', 'notes']);
  if (!desc && Array.isArray(x.line_items)) {
    desc = x.line_items
      .map(function (li) { return li && (li.description || li.name || li.item); })
      .filter(Boolean).join('; ');
  }
  return {
    vendor_name: str(pickStr(x, VENDOR_PATHS)),
    invoice_number: str(pickStr(x, NUMBER_PATHS)),
    invoice_date: str(pickStr(x, IDATE_PATHS)),
    due_date: str(pickStr(x, DDATE_PATHS)),
    total_amount: pickNum(x, TOTAL_PATHS),
    currency: str(pickStr(x, CURR_PATHS)).toUpperCase(),
    description: str(desc).slice(0, 500),
    is_credit_note: x.is_credit_note === true,
  };
};

const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const r = items[i].json || {};
  const meta = (metas[i] && metas[i].json) || {};

  const base = {
    gmail_message_id: meta.gmail_message_id || '',
    sender_email: meta.sender_email || '',
    subject: meta.subject || '',
    source_type: 'pdf_attachment',
    attachment_filename: meta.attachment_filename || '',
    extraction_method: 'vision_ocr',
  };

  // A failure is NOT an invoice. It is still logged, but it reaches the
  // sheet through is_unreadable, never by pretending to be an invoice.
  const fail = function (why) {
    out.push({
      json: Object.assign({}, base, {
        is_invoice: false,
        not_invoice_reason: '',
        is_unreadable: true,
        extraction_error: why,
        vendor_name: '', invoice_number: '', invoice_date: '', due_date: '',
        total_amount: null, currency: '', description: '', is_credit_note: false,
      }),
    });
  };

  if (meta.ocr_skipped === true) {
    fail(meta.extraction_error || 'PDF binary was not available for OCR');
    continue;
  }

  // BYPASS GUARD - see the matching comment in Standardize Text Result.
  // An item still carrying the base64 payload, with no model response on it,
  // never reached the OCR call. Drop it rather than logging a phantom row.
  if (r.content === undefined && r.choices === undefined && !r.error && !r.type &&
      (r.pdf_base64 !== undefined || r.ocr_system_prompt !== undefined)) {
    continue;
  }

  // Two error shapes reach here: the Anthropic error body, and - now that
  // neverError is off - n8n's own error item after the retries are spent.
  if (r.type === 'error' || r.error) {
    const e = r.error;
    const detail = (typeof e === 'string')
      ? e
      : String((e && (e.message || e.description)) || JSON.stringify(e || {}));
    const kind = (e && (e.type || e.code)) || 'error';
    fail('Vision OCR failed: ' + kind + ' - ' + detail.slice(0, 250));
    continue;
  }

  // --- normalise the two response shapes -----------------------
  let text = '';
  if (Array.isArray(r.content)) {                                  // Anthropic
    text = r.content.filter(function (b) { return b && b.type === 'text'; })
                    .map(function (b) { return b.text; }).join('\n');
  } else if (Array.isArray(r.choices) && r.choices.length) {       // OpenAI-compatible
    text = (r.choices[0].message && r.choices[0].message.content) || '';
  }

  if (!String(text).trim()) { fail('Vision OCR returned no readable content for this file'); continue; }

  let parsed = null;
  try {
    parsed = parseLoose(text);
  } catch (err) {
    fail('Vision OCR returned unparseable output: ' + String(err.message).slice(0, 200));
    continue;
  }

  if (parsed.readable === false) {
    fail('Scan is not legible enough to extract: ' + (parsed.unreadable_reason || 'illegible page'));
    continue;
  }

  const f = mapFields(parsed);

  // The model may answer in its own document shape with no is_invoice
  // flag at all. Absent flag is not the same as "false" - infer it from
  // whether an actual charge was read off the page.
  const explicitFlag = typeof parsed.is_invoice === 'boolean';
  const anyField = Boolean(f.vendor_name || f.invoice_number || f.total_amount !== null || f.invoice_date);

  if (!explicitFlag && !anyField) {
    fail('Vision OCR returned no usable invoice fields');
    continue;
  }

  const isInvoice = explicitFlag
    ? parsed.is_invoice
    : Boolean(f.vendor_name && (f.invoice_number || f.total_amount !== null));

  out.push({
    json: Object.assign({}, base, f, {
      is_invoice: isInvoice,
      not_invoice_reason: isInvoice ? '' : str(parsed.not_invoice_reason),
      is_unreadable: false,
      extraction_error: explicitFlag ? '' : 'Model answered in a non-schema shape; fields were mapped',
    }),
  });
}

return out;
