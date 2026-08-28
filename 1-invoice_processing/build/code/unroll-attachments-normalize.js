// n8n Code node: Unroll Attachments & Normalize
// Mode: RUN ONCE FOR ALL ITEMS

// ============================================================
// Unroll Attachments & Normalize          (Run Once for All Items)
//
// One output item per processable unit:
//   - one item per PDF attachment, OR
//   - one item per unsupported attachment (when the mail has no PDF), OR
//   - one item for the email body (when nothing is attached)
//
// Every piece of metadata a later node needs is carried ON THE ITEM.
// ============================================================

const PDF_EXT = /\.pdf$/i;
const DOC_EXT = /\.(docx?|xlsx?|pptx?|csv|txt|rtf|odt|ods|pages|numbers|zip|rar|7z|eml|msg|html?)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|tiff?|bmp|webp|heic|avif)$/i;

function senderOf(email) {
  const raw = email.From || email.from || '';
  if (typeof raw === 'string' && raw.trim()) {
    const m = raw.match(/<([^>]+)>/);
    return (m ? m[1] : raw).trim().toLowerCase();
  }
  if (raw && Array.isArray(raw.value) && raw.value[0]) {
    return String(raw.value[0].address || '').trim().toLowerCase();
  }
  if (raw && raw.text) {
    const m = String(raw.text).match(/<([^>]+)>/);
    return (m ? m[1] : raw.text).trim().toLowerCase();
  }
  return '';
}

const out = [];
const emails = $input.all();

for (let i = 0; i < emails.length; i++) {
  const email = emails[i].json || {};
  const binaries = emails[i].binary || {};

  // Guard against empty dummy items produced on repeat runs when 0 emails exist
  const hasId = Boolean(email.id || email.messageId);
  const hasBody = Boolean(email.textPlain || email.text || email.snippet || email.Snippet);
  const hasSubject = Boolean(email.Subject || email.subject);
  const hasBinaries = Object.keys(binaries).length > 0;

  if (!hasId && !hasBody && !hasSubject && !hasBinaries) {
    continue;
  }

  const base = {
    gmail_message_id: email.id || email.messageId || '',
    gmail_thread_id: email.threadId || '',
    sender_email: senderOf(email) || 'unknown@unknown',
    subject: String(email.Subject || email.subject || ''),
    plain_text_body: String(email.textPlain || email.text || email.snippet || email.Snippet || ''),
    received_at: email.internalDate
      ? new Date(Number(email.internalDate)).toISOString()
      : String(email.date || email.Date || ''),
  };

  // ---- classify every binary on this email ------------------
  const pdfs = [];
  const unsupported = [];

  for (const key of Object.keys(binaries)) {
    const f = binaries[key] || {};
    const name = String(f.fileName || '');
    const mime = String(f.mimeType || '').toLowerCase();

    if (mime.includes('pdf') || PDF_EXT.test(name)) {
      pdfs.push({ key: key, f: f, name: name || key + '.pdf', mime: mime });
    } else if (DOC_EXT.test(name) || (name && IMG_EXT.test(name))) {
      unsupported.push({ key: key, f: f, name: name, mime: mime });
    }
    // inline images with no filename (signature logos) are ignored on purpose
  }

  // ---- emit --------------------------------------------------
  if (pdfs.length > 0) {
    pdfs.forEach(function (p, idx) {
      out.push({
        json: Object.assign({}, base, {
          has_attachment: true,
          attachment_key: p.key,
          attachment_index: idx,
          total_attachments: pdfs.length,
          attachment_filename: p.name,
          attachment_mime: p.mime || 'application/pdf',
          source_type: 'pdf_attachment',
          route_source: 'pdf',
          extraction_error: '',
        }),
        binary: { data: p.f },
        pairedItem: i,
      });
    });
  } else if (unsupported.length > 0) {
    unsupported.forEach(function (u, idx) {
      out.push({
        json: Object.assign({}, base, {
          has_attachment: true,
          attachment_key: u.key,
          attachment_index: idx,
          total_attachments: unsupported.length,
          attachment_filename: u.name,
          attachment_mime: u.mime,
          source_type: 'pdf_attachment',
          route_source: 'unsupported',
          extraction_error: 'Unsupported attachment type (' + (u.mime || 'unknown type') + '): ' + u.name,
        }),
        binary: { data: u.f },
        pairedItem: i,
      });
    });
  } else {
    out.push({
      json: Object.assign({}, base, {
        has_attachment: false,
        attachment_key: null,
        attachment_index: 0,
        total_attachments: 0,
        attachment_filename: '',
        attachment_mime: '',
        source_type: 'email_body',
        route_source: 'email_body',
        extraction_error: '',
      }),
      pairedItem: i,
    });
  }
}

return out;
