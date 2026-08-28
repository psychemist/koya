// n8n Code node: Build Unreadable Record
// Mode: RUN ONCE FOR EACH ITEM

// ============================================================
// Build Unreadable Record                 (Run Once for Each Item)
//
// Corrupt PDFs, unsupported attachments and empty bodies land here.
// No model call is made - that is the cost-aware choice and also the
// only honest one: there is nothing to read. The record is still
// LOGGED so the failure is visible in the sheet instead of vanishing.
//
// is_invoice is FALSE. These are failures, not invoices. They reach
// the sheet on the is_unreadable flag.
// ============================================================
return {
  json: {
    gmail_message_id: $json.gmail_message_id || '',
    sender_email: $json.sender_email || '',
    subject: $json.subject || '',
    source_type: $json.source_type || 'pdf_attachment',
    attachment_filename: $json.attachment_filename || '',
    extraction_method: 'none',

    is_invoice: false,
    not_invoice_reason: '',
    is_unreadable: true,
    extraction_error: $json.extraction_error || 'Attachment could not be read',
    failure_reason: $json.failure_reason || 'unreadable',

    vendor_name: '',
    invoice_number: '',
    invoice_date: '',
    due_date: '',
    total_amount: null,
    currency: '',
    description: '',
    is_credit_note: false,
  },
};
