const STOP = new Set(['the','a','an','and','or','to','of','for','in','on','with','your',
  'you','we','our','is','are','that','this','it','at','as','be','from','by','their']);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function shingles(s: string, n = 3): Set<string> {
  const toks = tokens(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) {
    const win = toks.slice(i, i + n);
    if (win.every((t) => STOP.has(t))) continue;   // a run of stopwords proves nothing
    out.add(win.join(' '));
  }
  return out;
}

/** At least one substantive 3-gram shared with the stored source text.
 *  This is the line between personalisation and the appearance of it. */
export function isGrounded(body: string, sourceText: string, n = 3): boolean {
  const src = shingles(sourceText, n);
  for (const g of shingles(body, n)) if (src.has(g)) return true;
  return false;
}
