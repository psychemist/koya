// n8n Code node: Inspect Text Layer & Classify
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Inspect Text Layer & Classify           (Run Once for ALL Items)
//
// Runs in All Items mode because .all() and .itemMatching() do not
// exist in Run Once for Each Item mode.
//
// Sets $json.route to exactly one of:
//   'text'       - a real text layer we can hand to the extractor
//   'ocr'        - extraction "succeeded" but returned nothing usable
//                  (image-only page, browser print furniture, ...)
//   'unreadable' - Extract From File threw (corrupt / encrypted / not a PDF)
// ============================================================

// Only route_source === 'pdf' items were sent into Extract From PDF File,
// and the node preserves order 1:1, so index i here IS pdfMetas[i].
const pdfMetas = $('Unroll Attachments & Normalize')
  .all()
  .filter(function (it) { return it.json.route_source === 'pdf'; });

// --- strip everything that is page furniture, not invoice content ---
// This is the fix for the "scanned PDF that still returns a line of text"
// case. A page exported from a browser image viewer yields e.g.
//   7/28/25, 4:53 PM  real-estate-commission-invoice-template.webp (620x877)
//   https://.../real-estate-commission-invoice-template.webp   1/1
// Every token there is furniture. Once it is removed nothing remains,
// so the page has no text layer and must go to OCR.
const ARTEFACTS = [
  /https?:\/\/\S+/gi,                                                      // URLs
  /\b[\w.\-]+\.(webp|png|jpe?g|gif|tiff?|bmp|svg|heic|avif)\b/gi,          // image filenames
  /\(\s*\d{2,5}\s*[×✕xX]\s*\d{2,5}\s*\)/g,                       // (620x877)
  /\b\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, // print timestamp
  /\bpage\s*\d+\s*(of\s*\d+)?\b/gi,                                        // Page 1 of 1
  /^\s*\d{1,3}\s*\/\s*\d{1,3}\s*$/gm,                                      // 1/1 page marker
  /[\uFFFD\u0000-\u001F]/g,                                                // replacement / control chars
];

const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const j = items[i].json || {};

  // --- recover the metadata that entered Extract From PDF File ---
  let meta = (pdfMetas[i] && pdfMetas[i].json) || null;
  if (!meta) {
    try { meta = $('Unroll Attachments & Normalize').itemMatching(i).json; } catch (e) { meta = {}; }
  }

  // --- did the extractor fail? (On Error = Continue keeps the item) ---
  let errMsg = '';
  if (j.error) {
    errMsg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
  } else if (j.errorMessage) {
    errMsg = String(j.errorMessage);
  } else if (typeof j.text !== 'string' && j.message) {
    errMsg = String(j.message);
  }

  const rawText = typeof j.text === 'string' ? j.text : '';

  if (errMsg && !rawText.trim()) {
    out.push({
      json: Object.assign({}, meta, {
        source_type: 'pdf_attachment',
        invoice_text: '',
        extracted_chars: 0,
        route: 'unreadable',
        failure_reason: 'corrupt_pdf',
        extraction_error: 'PDF could not be parsed: ' + errMsg.slice(0, 250),
      }),
    });
    continue;
  }

  let stripped = rawText.replace(/\r/g, ' ');
  for (const p of ARTEFACTS) stripped = stripped.replace(p, ' ');
  stripped = stripped.replace(/\s+/g, ' ').trim();

  const meaningfulChars = stripped.replace(/[^a-zA-Z0-9]/g, '').length;
  const letters = stripped.replace(/[^a-zA-Z]/g, '').length;
  const hasDigits = /\d/.test(stripped);
  const invoiceSignal = /(invoice|factuur|facture|rechnung|fattura|factura|bill|statement|fee note|amount due|total|subtotal|balance|vat|tax|due date|payment|remit|quantity|qty)/i.test(stripped);

  const needsOcr =
    meaningfulChars < 60 ||
    letters < 30 ||
    !hasDigits ||
    (!invoiceSignal && meaningfulChars < 250);

  if (needsOcr) {
    const why = meaningfulChars < 60
      ? 'no usable text layer after stripping page artefacts (' + meaningfulChars + ' meaningful characters left)'
      : (!hasDigits ? 'text layer contains no numeric data'
                    : 'text layer contains no invoice vocabulary');
    out.push({
      json: Object.assign({}, meta, {
        source_type: 'pdf_attachment',
        invoice_text: '',
        raw_text_preview: rawText.slice(0, 300),
        extracted_chars: rawText.trim().length,
        meaningful_chars: meaningfulChars,
        route: 'ocr',
        failure_reason: 'no_text_layer',
        extraction_error: 'Image-only PDF: ' + why,
      }),
    });
    continue;
  }

  out.push({
    json: Object.assign({}, meta, {
      source_type: 'pdf_attachment',
      invoice_text: rawText.trim(),
      extracted_chars: rawText.trim().length,
      meaningful_chars: meaningfulChars,
      pdf_page_count: j.numpages || null,
      route: 'text',
      failure_reason: '',
      extraction_error: '',
    }),
  });
}

return out;
