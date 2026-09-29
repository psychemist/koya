/**
 * RFC 4180 CSV, as a small state machine: a quote toggles quoted mode, `""`
 * inside quotes is a literal quote, and a comma or newline outside quotes ends
 * a field or a row. An empty field is '', never a missing key, so a blank
 * estimated_arrival reaches the loader as '' and becomes null there.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], quoted = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (text[i + 1] !== '\n') endRow(); }
    else field += ch;
  }
  if (field !== '' || row.length) endRow();
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!header) return [];
  return body.map((r, i) => {
    if (r.length !== header.length) throw new Error(`line ${i + 2}: expected ${header.length} fields, got ${r.length}`);
    return Object.fromEntries(header.map((h, j) => [h.trim(), r[j]]));
  });
}
