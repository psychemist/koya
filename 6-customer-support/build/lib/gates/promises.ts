const NEGATION = /\b(can(?:no|')t|cannot|not|never|no|unable to|won't be able to)\b/i;
const PATTERNS = [
  /\bguarantee(?:d|s)?\b/i, /\bdefinitely\b/i, /\bpromise\b/i, /\bcertainly will\b/i,
  /\bwill (?:arrive|land|clear|reach|be (?:resolved|approved|completed|lifted|refunded|processed|paid|released))\b.*\b(?:by|before|within|today|tomorrow|on)\b/i,
  /\b(?:arrive|land|clear|resolved|processed|lifted|refunded)\b.*\b(?:by|before) (?:\d{1,2}(?::\d{2})?\s?(?:am|pm)|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
];
export function findPromises(text: string): string[] {
  const clauses = text.split(/(?<=[.!?])\s+|,|;|\bbut\b/i).map((c) => c.trim()).filter(Boolean);
  return clauses.filter((c) => PATTERNS.some((p) => p.test(c)) && !NEGATION.test(c));
}
