// n8n Code node: Prepare Non-PDF Source
// Mode: RUN ONCE FOR EACH ITEM

// ============================================================
// Prepare Non-PDF Source                  (Run Once for Each Item)
//
// Handles both remaining source types:
//   route_source = 'email_body'  -> read the body
//   route_source = 'unsupported' -> a .docx/.xlsx/.jpg was attached;
//                                   fail cleanly, do not call Claude
// Metadata is already on the item, so nothing has to be looked up.
// ============================================================
const meta = $json;

if (meta.route_source === 'unsupported') {
  return {
    json: Object.assign({}, meta, {
      invoice_text: '',
      extracted_chars: 0,
      route: 'unreadable',
      failure_reason: 'unsupported_attachment',
      extraction_error: meta.extraction_error || 'Unsupported attachment type',
    }),
  };
}

const body = String(meta.plain_text_body || '').trim();
const meaningful = body.replace(/[^a-zA-Z0-9]/g, '').length;

if (meaningful < 25) {
  return {
    json: Object.assign({}, meta, {
      source_type: 'email_body',
      invoice_text: '',
      extracted_chars: body.length,
      route: 'unreadable',
      failure_reason: 'empty_email_body',
      extraction_error: 'Email has no attachment and no readable body text',
    }),
  };
}

return {
  json: Object.assign({}, meta, {
    source_type: 'email_body',
    invoice_text: body,
    extracted_chars: body.length,
    meaningful_chars: meaningful,
    route: 'text',
    failure_reason: '',
    extraction_error: '',
  }),
};
