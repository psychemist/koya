export type RefKind = 'TXN' | 'PAY' | 'CUS';
const DIGIT: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const ALIAS: Record<RefKind, string[]> = { TXN: ['t x n', 'transaction'], PAY: ['p a y', 'payout'], CUS: ['c u s', 'customer'] };

/** Turns what a caller or a transcriber produced into a canonical reference, or null. Never guesses digits. */
export function normalizeRef(raw: string, kind: RefKind): string | null {
  const words = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map((w) => DIGIT[w] ?? w);
  // Glued forms like "txn9001" split into letters and digits; prefixes are spaced into single letters.
  const s = ` ${words.join(' ').replace(/([a-z])(\d)/g, '$1 $2').replace(/\b(txn|pay|cus)\b/g, (m) => m.split('').join(' '))} `;
  const prefixes = ALIAS[kind].map((p) => p.replace(/ /g, '\\s+')).join('|');
  const m = s.match(new RegExp(`\\s(?:${prefixes})\\s+((?:\\d\\s*)+?)(?=\\s*$|\\s+[a-z])`));
  if (m) { const d = m[1].replace(/\s/g, ''); return d.length === 4 ? `${kind}-${d}` : null; }
  const bare = s.replace(/\s/g, '');
  return /^\d{4}$/.test(bare) ? `${kind}-${bare}` : null;
}
