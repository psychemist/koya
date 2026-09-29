import type { TurnFacts } from './reply.ts';
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const AMOUNT = /(?:[$€£₦]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|ngn|kes|ghs|zar|rwf|dollars|euros|pounds)\b)/gi;
const INTERNAL = /\b(risk scores?|risk model|thresholds?|flagged|kyc status|internal notes?|support notes?)\b/i;
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const grams = (w: string[], n: number) => new Set(w.slice(0, Math.max(0, w.length - n + 1)).map((_, i) => w.slice(i, i + n).join(' ')));
const digits = (s: string) => s.replace(/[^\d]/g, '');

export function findSensitive(text: string, f: TurnFacts): string[] {
  const out: string[] = [];
  const said = f.callerText.toLowerCase();
  for (const e of text.match(EMAIL) ?? [])
    if (!f.knownEmails.includes(e.toLowerCase()) && !said.includes(e.toLowerCase())) out.push(`Reads out an email the caller did not give: ${e}`);
  if (!f.verifiedCustomerId) for (const a of text.match(AMOUNT) ?? [])
    if (!digits(said).includes(digits(a))) out.push(`Names an amount the caller did not say: ${a}`);
  const spoken = grams(words(text), 6);
  for (const note of f.supportNotes) for (const g of grams(words(note), 6))
    if (spoken.has(g)) { out.push('Repeats an internal support note.'); break; }
  const m = text.match(INTERNAL); if (m) out.push(`Uses internal vocabulary: "${m[0]}"`);
  return out;
}
