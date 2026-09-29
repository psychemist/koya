/**
 * Confidence is stored as a fraction and read as a percentage.
 *
 * 0.55 is a number a model returns. A reviewer scanning thirty leads reads
 * 55%, and reads it faster, because a percentage carries its own scale: 0.55
 * has to be measured against a 0.40 threshold the reader has to remember,
 * while 55% against 40% is one comparison with nothing to recall.
 *
 * Rounded rather than truncated, and the surrounding sentence always says
 * which side of the bar the lead falls on, so a value that rounds to the
 * threshold is never the only thing telling a reviewer whether it cleared it.
 */
export function percent(value: string | number | null | undefined): string {
  // Guarded before Number(), which reads null and '' as 0. A lead with no
  // stored confidence would have rendered "0%", which says the agent was sure
  // the fit was hopeless rather than that nobody recorded a number.
  if (value === null || value === undefined || value === '') return 'unknown';
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'unknown';
}
