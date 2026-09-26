/**
 * How a run's objective is composed, and how it is taken apart again.
 *
 * The intake form asks three questions and stores one string, because the
 * objective is also the agent's brief and the agent reads prose rather than
 * columns. That join used to live in the intake route and nothing could undo
 * it, so the run page printed the whole thing as one heading:
 *
 *   automation agencies that are looking for staffing. Geography: united
 *   kingdom and united states. Headcount: 2-15
 *
 * Both halves live here so they cannot drift. A parser that infers a format
 * defined in another file is a parser that breaks the day somebody changes a
 * separator, and nothing would fail until a heading looked wrong in
 * production.
 */

/** The labels the intake form appends, in the order it appends them. */
export const QUALIFIER_LABELS = ['Geography', 'Headcount'] as const;

export type Qualifier = { label: string; value: string };

const SEPARATOR = '. ';

export function composeObjective(
  brief: string, geography?: string, headcount?: string,
): string {
  const parts = [brief.trim()];
  if (geography?.trim()) parts.push(`Geography: ${geography.trim()}`);
  if (headcount?.trim()) parts.push(`Headcount: ${headcount.trim()}`);
  return parts.join(SEPARATOR);
}

/**
 * Splits a stored objective back into the sentence somebody typed and the
 * qualifiers the form appended.
 *
 * Anchored on ". Label:" rather than on every full stop, because a brief is
 * prose and routinely contains its own sentences. Matching on the LAST such
 * anchor would be wrong too: a brief mentioning "Geography:" in passing should
 * lose everything after it only if what follows really is the appended tail,
 * so the first anchor whose tail parses cleanly wins.
 */
export function splitObjective(
  objective: string,
): { brief: string; qualifiers: Qualifier[] } {
  const text = (objective ?? '').trim();
  if (!text) return { brief: '', qualifiers: [] };

  const anchor = new RegExp(`\\.\\s+(?=(?:${QUALIFIER_LABELS.join('|')}):)`);
  const at = text.search(anchor);
  if (at === -1) return { brief: text, qualifiers: [] };

  const brief = text.slice(0, at).trim();
  const tail = text.slice(at + 1).trim();

  const qualifiers: Qualifier[] = [];
  for (const piece of tail.split(SEPARATOR)) {
    const colon = piece.indexOf(':');
    if (colon === -1) continue;
    const label = piece.slice(0, colon).trim();
    const value = piece.slice(colon + 1).trim().replace(/\.$/, '');
    // Only labels this module appends. Anything else is part of the brief
    // that happened to contain a colon, and swallowing it would silently
    // delete what somebody wrote.
    if (value && (QUALIFIER_LABELS as readonly string[]).includes(label)) {
      qualifiers.push({ label, value });
    }
  }

  // Nothing recognised means the anchor was a false positive, so the text is
  // returned whole rather than truncated at it.
  return qualifiers.length ? { brief, qualifiers } : { brief: text, qualifiers: [] };
}
