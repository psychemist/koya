// n8n Code node: Re-attach PDF Binary
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Re-attach PDF Binary                    (Run Once for ALL Items)
//
// All Items mode because .all() is not available per-item.
//
// Extract From File drops the binary, so pull the original PDF back
// off the Unroll node, matched deterministically on
// gmail_message_id + attachment_key.
// Also carries the OCR system prompt so BOTH OCR HTTP nodes
// (Claude and Nemotron) read their instructions from one place.
// ============================================================
const OCR_SYSTEM_PROMPT = "You are reading a scanned invoice for Novus Realty, a property management company. The PDF has no text layer, so you must read the page visually.\n\nOUTPUT CONTRACT - this overrides any habit you have of describing a document in your own structure.\n\nReturn ONE flat JSON object and nothing else. No prose. No markdown fence. It must contain EXACTLY these twelve keys and no others:\n\nreadable, unreadable_reason, is_invoice, not_invoice_reason, vendor_name, invoice_number, invoice_date, due_date, total_amount, currency, description, is_credit_note\n\nDo NOT nest objects. Do NOT add keys such as from, bill_to, ship_to, line_items, subtotal, sales_tax, amount_paid, balance_due, payment_instructions or notes. Anything outside the twelve keys is discarded.\n\nExample of a correct reply:\n{\"readable\": true, \"unreadable_reason\": null, \"is_invoice\": true, \"not_invoice_reason\": null, \"vendor_name\": \"Fairway Commissions\", \"invoice_number\": \"FC-99120\", \"invoice_date\": \"2026-08-15\", \"due_date\": \"2026-09-15\", \"total_amount\": 3450.00, \"currency\": \"USD\", \"description\": \"Commission statement for Q3 property settlements\", \"is_credit_note\": false}\n\nField rules:\n- readable: false if the page is too blurry, cropped, blank or damaged to read with confidence. Then give a short unreadable_reason and leave every other field null. Do not guess at a damaged page.\n- is_invoice: false for anything that is not an actual demand for payment. Then give a short not_invoice_reason.\n- vendor_name: the party ISSUING the invoice, the one to be paid. This is the letterhead or \"From\" party. It is never the \"Bill To\", \"Ship To\" or customer party, and never Novus Realty.\n- invoice_number: exactly as printed on the page. BLANK BEATS INVENTED - if the page carries no invoice number, return null. Never take it from a filename, a heading, a PO number or an account number.\n- invoice_date / due_date: ISO YYYY-MM-DD.\n- total_amount: the single final amount payable, as a plain number with no currency symbol and no thousands separator. Read it from the line labelled Total, Total Due, Amount Due or Balance Due. Never return a line-item rate or a subtotal here.\n- currency: 3-letter ISO code.\n- description: ONE short line summarising what is being billed. Not a list, not an object.\n- Any field you cannot clearly read on the page must be null.";

const src = $('Unroll Attachments & Normalize').all();
const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const j = items[i].json || {};

  let hit = src.find(function (it) {
    return it.json.gmail_message_id === j.gmail_message_id &&
           it.json.attachment_key === j.attachment_key;
  });

  if (!hit) {
    try { hit = $('Unroll Attachments & Normalize').itemMatching(i); } catch (e) { hit = null; }
  }

  if (!hit || !hit.binary || !hit.binary.data) {
    // never throw - route it to the clean-failure path instead
    out.push({
      json: Object.assign({}, j, {
        route: 'unreadable',
        failure_reason: 'binary_lost',
        extraction_error: 'Could not recover the PDF binary for OCR',
        ocr_system_prompt: OCR_SYSTEM_PROMPT,
        ocr_skipped: true,
      }),
    });
    continue;
  }

  out.push({
    json: Object.assign({}, j, { ocr_system_prompt: OCR_SYSTEM_PROMPT, ocr_skipped: false }),
    binary: { data: hit.binary.data },
  });
}

return out;
