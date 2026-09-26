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

/**
 * The same rule one level down, for a single tool call.
 *
 * `started` is the call in flight, which is the newest row in the activity
 * feed and therefore the one most often on screen. Painting it red said the
 * run was failing whenever it was merely working, which is the exact mistake
 * the note above warns about.
 *
 * `denied` is amber rather than red on purpose: a budget refusal is the cage
 * doing its job, not something that went wrong.
 */
const TOOL_CALL_STATE: Record<string, string> = {
  ok: 'state-good',
  started: 'state-working',
  denied: 'state-degraded',
  error: 'state-bad',
};

export function toolCallStateClass(status: string): string {
  return TOOL_CALL_STATE[status] ?? 'state-working';
}
