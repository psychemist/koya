/**
 * Extraction and normalisation of the four kinds of value a proposal must
 * never invent: money, percentages, durations, and dates.
 *
 * This is the free half of the grounding gate. The reasoning for doing it with
 * rules rather than a model:
 *
 * The catastrophic failure mode for a proposal generator is not clumsy prose —
 * a salesperson catches that. It is a figure the client was never quoted:
 * a price divided into instalments that were never agreed, a duration
 * converted into calendar dates, a percentage improvement nobody promised.
 * Those are all *arithmetic on the inputs*, and arithmetic is exactly what a
 * regex can catch for nothing. Asking a model "is this figure supported?"
 * costs a request and answers less reliably.
 *
 * So: every money figure, percentage, duration and date in the output must
 * appear in the input. Anything that does not is surfaced. Prose claims that
 * carry no number are a different problem, and go to the judge in grounding.ts.
 */

export type Money = { currency: string | null; value: number; raw: string };
export type Percent = { value: number; raw: string };
export type Duration = { value: number; unit: DurationUnit; raw: string };
export type DateValue = { iso: string; raw: string };

export type DurationUnit = "day" | "week" | "month" | "quarter" | "year" | "sprint";

/** Symbol and ISO code to a single canonical currency label. */
const CURRENCY_ALIASES: Record<string, string> = {
  "£": "GBP",
  gbp: "GBP",
  $: "USD",
  usd: "USD",
  "us$": "USD",
  "€": "EUR",
  eur: "EUR",
  "₦": "NGN",
  ngn: "NGN",
  "₵": "GHS",
  ghs: "GHS",
  ksh: "KES",
  kes: "KES",
  "R": "ZAR",
  zar: "ZAR",
  "¥": "JPY",
  jpy: "JPY",
  "₹": "INR",
  inr: "INR",
};

function canonicalCurrency(token: string | undefined): string | null {
  if (!token) return null;
  const key = token.trim().toLowerCase();
  return CURRENCY_ALIASES[key] ?? CURRENCY_ALIASES[token.trim()] ?? null;
}

/** k/m/bn multipliers, so 48k and 48,000 compare equal. */
const SCALE: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  mn: 1_000_000,
  bn: 1_000_000_000,
  b: 1_000_000_000,
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  eighteen: 18,
  twenty: 20,
};

function parseAmount(digits: string, scale: string | undefined): number | null {
  // Thousands separators out; decimal point kept.
  const cleaned = digits.replace(/[,\s ]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const mult = scale ? (SCALE[scale.toLowerCase()] ?? 1) : 1;
  return n * mult;
}

/**
 * Money, in the forms people actually write:
 *   £48,000   $12k   NGN 5.5m   40,000 USD   €1 200   $48,000.00
 *
 * A bare number with no currency marker is deliberately NOT money — "3 phases"
 * and "10 weeks" would otherwise flood the results with false positives.
 */
export function extractMoney(text: string): Money[] {
  const out: Money[] = [];

  // Symbol or code before the number.
  const before =
    /(£|\$|€|₦|₵|¥|₹|\b(?:GBP|USD|EUR|NGN|GHS|KES|ZAR|JPY|INR|US\$)\b)\s*([0-9][0-9,.\s ]*)\s*(k|m|mn|bn|b)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = before.exec(text)) !== null) {
    const value = parseAmount(m[2] ?? "", m[3]);
    if (value === null) continue;
    out.push({ currency: canonicalCurrency(m[1]), value, raw: m[0].trim() });
  }

  // Number first, code after: "40,000 USD", "5m NGN".
  const after =
    /([0-9][0-9,.\s ]*)\s*(k|m|mn|bn|b)?\s*\b(GBP|USD|EUR|NGN|GHS|KES|ZAR|JPY|INR)\b/gi;
  while ((m = after.exec(text)) !== null) {
    const value = parseAmount(m[1] ?? "", m[2]);
    if (value === null) continue;
    out.push({ currency: canonicalCurrency(m[3]), value, raw: m[0].trim() });
  }

  return dedupeBy(out, (v) => `${v.currency ?? "?"}:${v.value}`);
}

export function extractPercent(text: string): Percent[] {
  const out: Percent[] = [];
  // No `\b` after `%`: a percent sign followed by a space is not a word
  // boundary, so `%\b` silently matches nothing at all. The word forms keep
  // their boundary so "percent" does not fire inside "percentage".
  const re = /([0-9]+(?:\.[0-9]+)?)\s*(?:%|per\s?cent\b|percent\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) out.push({ value, raw: m[0].trim() });
  }
  return dedupeBy(out, (v) => String(v.value));
}

const UNIT_CANON: Record<string, DurationUnit> = {
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  wk: "week",
  wks: "week",
  month: "month",
  months: "month",
  mo: "month",
  mos: "month",
  quarter: "quarter",
  quarters: "quarter",
  year: "year",
  years: "year",
  yr: "year",
  yrs: "year",
  sprint: "sprint",
  sprints: "sprint",
};

/**
 * Durations, digits or words: "10 weeks", "six weeks", "3-month".
 *
 * Normalised to a canonical unit so "10 weeks" and "10-week" match, but NOT
 * converted between units: 10 weeks and 2.5 months are deliberately different
 * values here, because converting one into the other is precisely the
 * unsupported inference the gate exists to catch.
 */
export function extractDuration(text: string): Duration[] {
  const out: Duration[] = [];
  const re =
    /\b([0-9]+(?:\.[0-9]+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty)[\s-]*(days?|weeks?|wks?|months?|mos?|quarters?|years?|yrs?|sprints?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = (m[1] ?? "").toLowerCase();
    const value = WORD_NUMBERS[token] ?? Number(token);
    const unit = UNIT_CANON[(m[2] ?? "").toLowerCase()];
    if (!Number.isFinite(value) || !unit) continue;
    out.push({ value, unit, raw: m[0].trim() });
  }
  return dedupeBy(out, (v) => `${v.value}:${v.unit}`);
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Calendar dates, normalised to ISO so "14 August 2026", "14/08/2026" and
 * "2026-08-14" all compare equal. Quarters are kept as "2026-Q3".
 *
 * A bare month name with no year is ignored: "we will start in March" is a
 * vague commitment, not a fabricated date, and flagging it would bury the real
 * findings.
 */
export function extractDates(text: string): DateValue[] {
  const out: DateValue[] = [];
  let m: RegExpExecArray | null;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text)) !== null) {
    out.push({ iso: `${m[1]}-${m[2]}-${m[3]}`, raw: m[0] });
  }

  const dmy = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/g;
  while ((m = dmy.exec(text)) !== null) {
    const d = String(Number(m[1])).padStart(2, "0");
    const mo = String(Number(m[2])).padStart(2, "0");
    out.push({ iso: `${m[3]}-${mo}-${d}`, raw: m[0] });
  }

  // "14 August 2026" and "14th Aug 2026"
  const dMonthY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
  while ((m = dMonthY.exec(text)) !== null) {
    const mo = MONTHS[(m[2] ?? "").toLowerCase()];
    if (!mo) continue;
    out.push({
      iso: `${m[3]}-${String(mo).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`,
      raw: m[0],
    });
  }

  // "August 14, 2026"
  const monthDY = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
  while ((m = monthDY.exec(text)) !== null) {
    const mo = MONTHS[(m[1] ?? "").toLowerCase()];
    if (!mo) continue;
    out.push({
      iso: `${m[3]}-${String(mo).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`,
      raw: m[0],
    });
  }

  // "Q3 2026" / "2026 Q3"
  const q1 = /\bQ([1-4])\s+(\d{4})\b/gi;
  while ((m = q1.exec(text)) !== null) out.push({ iso: `${m[2]}-Q${m[1]}`, raw: m[0] });
  const q2 = /\b(\d{4})\s+Q([1-4])\b/gi;
  while ((m = q2.exec(text)) !== null) out.push({ iso: `${m[1]}-Q${m[2]}`, raw: m[0] });

  return dedupeBy(out, (v) => v.iso);
}

/**
 * Money-like bare numbers, used ONLY when reading the allowed inputs.
 *
 * The asymmetry is deliberate and is the crux of keeping the gate usable. When
 * reading the model's output we refuse to treat a bare number as money,
 * because "three phases" and "10 weeks" would then generate constant false
 * alarms. When reading the intake we must be more generous: a salesperson
 * types "40,000 fixed fee" without a currency symbol all the time, and
 * treating that as "no price given" would flag the correct price as invented.
 *
 * So: strict about what we emit, lenient about what we accept as a source.
 *
 * The >= 100-or-separated test keeps small counts out. "10 weeks" contributes
 * nothing; "40,000" and "1,200.50" do.
 */
export function extractBareAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\b([0-9]+(?:[,\s][0-9]{3})*(?:\.[0-9]+)?)\s*(k|m|mn|bn|b)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? "";
    const value = parseAmount(raw, m[2]);
    if (value === null) continue;
    const separated = /[,.]/.test(raw) || Boolean(m[2]);
    if (value >= 100 || separated) out.push(value);
  }
  return [...new Set(out)];
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export type UngroundedValue = {
  kind: "money" | "percent" | "duration" | "date";
  raw: string;
  /** Why this is a problem, in a sentence a salesperson can act on. */
  reason: string;
};

/**
 * The check itself: every value in `generated` must appear in `allowed`.
 *
 * Currency comparison is deliberately lenient in one direction only. A figure
 * written without a currency marker in the intake ("48,000 fixed fee") matches
 * an output that names one, because the salesperson's shorthand is not the
 * model's invention. A figure whose currency *differs* does not match — quoting
 * dollars for a pound price is a real and serious error.
 */
export function findUngrounded(generated: string, allowed: string): UngroundedValue[] {
  const findings: UngroundedValue[] = [];

  const allowedMoney = extractMoney(allowed);
  const allowedBare = extractBareAmounts(allowed);
  for (const v of extractMoney(generated)) {
    // Order matters here. The currency-tagged figures are consulted first, so
    // that quoting £48,000 as $48,000 is reported as a currency error rather
    // than being waved through by the bare-amount fallback — which would
    // otherwise match the digits and lose the mistake entirely.
    const sameValueTagged = allowedMoney.filter((a) => a.value === v.value);
    const compatible = sameValueTagged.some(
      (a) => a.currency === null || v.currency === null || a.currency === v.currency,
    );

    if (compatible) continue;

    if (sameValueTagged.length > 0) {
      findings.push({
        kind: "money",
        raw: v.raw,
        reason: `${v.raw} states the right amount in the wrong currency.`,
      });
      continue;
    }

    // No tagged figure of this value at all: fall back to the salesperson's
    // untagged shorthand before calling it invented.
    if (allowedBare.includes(v.value)) continue;

    findings.push({
      kind: "money",
      raw: v.raw,
      reason: `${v.raw} does not appear anywhere in the intake or the supporting material. A figure the client was never quoted must not reach them.`,
    });
  }

  const allowedPercent = extractPercent(allowed);
  for (const v of extractPercent(generated)) {
    if (!allowedPercent.some((a) => a.value === v.value)) {
      findings.push({
        kind: "percent",
        raw: v.raw,
        reason: `${v.raw} is a performance claim that was never provided. Remove it or supply the source.`,
      });
    }
  }

  const allowedDuration = extractDuration(allowed);
  for (const v of extractDuration(generated)) {
    if (!allowedDuration.some((a) => a.value === v.value && a.unit === v.unit)) {
      const converted = allowedDuration.length > 0;
      findings.push({
        kind: "duration",
        raw: v.raw,
        reason: converted
          ? `${v.raw} is not the duration that was given. Durations must be stated as supplied, not converted.`
          : `${v.raw} is a timeline commitment that does not appear in the intake.`,
      });
    }
  }

  const allowedDates = extractDates(allowed);
  for (const v of extractDates(generated)) {
    if (!allowedDates.some((a) => a.iso === v.iso)) {
      findings.push({
        kind: "date",
        raw: v.raw,
        reason: `${v.raw} is a specific date that was never agreed. A duration is not a calendar date.`,
      });
    }
  }

  return findings;
}
