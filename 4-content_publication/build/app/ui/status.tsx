/**
 * One vocabulary for state, defined once.
 *
 * The statuses in the database are engineering words: `needs_human`,
 * `angles_ready`, `queued_manual`. Rendering them raw with the underscores
 * swapped for spaces asks the reader to work out what the system wants from
 * them. Each one gets the sentence a person would actually say, plus the
 * colour that matches what it means, so "waiting on you" never looks like
 * "went wrong", and `queued_manual` is not mistaken for a failure when it is
 * a finished post somebody copies out by hand.
 *
 * Colour carries meaning here and only here. Red blocks, amber waits on a
 * person, blue is in flight, green is done.
 */
type Tone = 'blocking' | 'advisory' | 'waiting' | 'ok' | 'idle';

const TONE_CLASS: Record<Tone, string> = {
  blocking: 'bg-blocking-bg text-blocking',
  advisory: 'bg-advisory-bg text-advisory',
  waiting:  'bg-waiting-bg text-waiting',
  ok:       'bg-ok-bg text-ok',
  idle:     'bg-sunk text-ink-70',
};

const REQUEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft:             { label: 'Draft',             tone: 'idle' },
  researching:       { label: 'Researching',       tone: 'waiting' },
  research_failed:   { label: 'Research failed',   tone: 'blocking' },
  planning:          { label: 'Planning angles',   tone: 'waiting' },
  angles_ready:      { label: 'Pick an angle',     tone: 'advisory' },
  drafting:          { label: 'Writing',           tone: 'waiting' },
  evaluating:        { label: 'Checking',          tone: 'waiting' },
  revising:          { label: 'Revising',          tone: 'waiting' },
  needs_review:      { label: 'Ready for review',  tone: 'advisory' },
  needs_human:       { label: 'Needs a person',    tone: 'blocking' },
  changes_requested: { label: 'Changes requested', tone: 'advisory' },
  rejected:          { label: 'Rejected',          tone: 'blocking' },
  scheduled:         { label: 'Queued to publish', tone: 'waiting' },
  published:         { label: 'Published',         tone: 'ok' },
  publish_failed:    { label: 'Publishing failed', tone: 'blocking' },
};

const QUEUE_STATE: Record<string, { label: string; tone: Tone }> = {
  queued:  { label: 'Queued',  tone: 'waiting' },
  claimed: { label: 'Sending', tone: 'waiting' },
  sent:    { label: 'Sent',    tone: 'ok' },
  // Not a failure. The post was researched, written, checked and approved;
  // nobody opted into paying X for the API, so a person copies it out.
  queued_manual: { label: 'Post by hand', tone: 'advisory' },
  blocked: { label: 'Blocked', tone: 'advisory' },
  failed:  { label: 'Failed',  tone: 'blocking' },
  // A NAMED PERSON'S claim, not a provider's. Green because the post did go
  // out, but the label never says "Sent" unqualified: that word is reserved
  // for the one thing that means a provider actually confirmed it.
  sent_manually: { label: 'Posted by hand', tone: 'ok' },
};

function pill(map: Record<string, { label: string; tone: Tone }>, key: string) {
  const it = map[key] ?? { label: key.replace(/_/g, ' '), tone: 'idle' as Tone };
  return (
    <span className={`pill ${TONE_CLASS[it.tone]}`}>
      <span className="pill-dot" />
      {it.label}
    </span>
  );
}

export const RequestStatus = ({ status }: { status: string }) => pill(REQUEST_STATUS, status);
export const QueueState = ({ state }: { state: string }) => pill(QUEUE_STATE, state);

/** A count that needs the same red as everything else that blocks. */
export function BlockingCount({ n }: { n: number }) {
  if (!n) return null;
  return <span className="pill bg-blocking-bg text-blocking">{n} blocking</span>;
}
