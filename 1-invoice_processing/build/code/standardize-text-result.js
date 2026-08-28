// n8n Code node: Standardize Text Result
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Standardize Text Result                 (Run Once for ALL Items)
//
// Accepts three response shapes so the extractor is swappable:
//   - n8n Information Extractor -> $json.output
//   - OpenAI-compatible API     -> $json.choices[0].message.content
//   - already-flat JSON         -> $json
// All are 1:1 and order-preserving with Prepare Claude Input.
// ============================================================
const metas = $('Prepare Claude Input').all();

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
    source_type: meta.source_type || 'email_body',
    attachment_filename: meta.attachment_filename || '',
    extraction_method: meta.source_type === 'pdf_attachment' ? 'pdf_text_layer' : 'email_body',
  };

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

  if (r.error && r.output === undefined && r.choices === undefined) {
    fail('Extraction failed: ' + String(r.error.message || r.error).slice(0, 250));
    continue;
  }

  // BYPASS GUARD.
  // This item still carries the Prepare Claude Input payload and has no
  // model response on it at all - no output, no choices, no error. It never
  // reached the extractor. That happens when a wire runs from an upstream
  // node directly into this one; n8n creates exactly such a wire on its own
  // when you delete a node from the middle of a chain, because it joins the
  // two neighbours together.
  //
  // The same email is already being handled correctly on the real path, so
  // this is a phantom, not a second invoice. Drop it instead of writing a
  // bogus "no fields extracted" row.
  if (r.output === undefined && r.choices === undefined && !r.error &&
      (r.claude_input !== undefined || r.invoice_text !== undefined ||
       r.extraction_system_prompt !== undefined)) {
    continue;
  }

  let x = null;
  if (r.output !== undefined) {
    x = r.output;
  } else if (Array.isArray(r.choices) && r.choices.length) {
    try {
      x = parseLoose(r.choices[0].message && r.choices[0].message.content);
    } catch (e) {
      fail('Model returned unparseable JSON: ' + String(e.message).slice(0, 200));
      continue;
    }
  } else {
    x = r;
  }

  if (!x || typeof x !== 'object') { fail('Extractor returned no structured output'); continue; }

  const f = mapFields(x);
  const explicitFlag = typeof x.is_invoice === 'boolean';
  const anyField = Boolean(f.vendor_name || f.invoice_number || f.total_amount !== null || f.invoice_date);

  // An extractor that returns NOTHING - no flag and no fields - has
  // malfunctioned. That is not the same as "this is not an invoice",
  // and silently dropping it would hide every invoice in the batch.
  // Surface it as a failed row instead.
  if (!explicitFlag && !anyField) {
    fail('Extractor returned no fields and no is_invoice flag - check the node Text and System Prompt Template fields');
    continue;
  }

  const isInvoice = explicitFlag
    ? x.is_invoice
    : Boolean(f.vendor_name && (f.invoice_number || f.total_amount !== null));

  out.push({
    json: Object.assign({}, base, f, {
      is_invoice: isInvoice,
      not_invoice_reason: isInvoice ? '' : str(x.not_invoice_reason),
      is_unreadable: false,
      extraction_error: '',
    }),
  });
}

return out;
