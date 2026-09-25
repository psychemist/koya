/**
 * How a run's status reads wherever it is printed.
 *
 * The three tables and the live strip each rendered the raw status text, so a
 * failed run and a finished one looked the same until you read the word. The
 * mapping lives here rather than in each of them: a status that gains a
 * meaning later gains it once.
 *
 * Work still in flight deliberately gets no colour. A run that is merely
 * running has not gone wrong and has not finished, and amber for "still going"
 * is the fastest way to teach somebody to ignore amber.
 */
const RUN_STATE: Record<string, string> = {
  complete: 'state-good',
  partial: 'state-warn',
  failed: 'state-bad',
};

export function runStateClass(status: string): string {
  return RUN_STATE[status] ?? 'state-working';
}
