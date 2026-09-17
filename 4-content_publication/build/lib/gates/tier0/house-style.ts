import { flag, type Flag, type AssetKind } from '../types';

/**
 * House style, enforced rather than requested.
 *
 * Every prompt in this system carries a rule against em dashes, because they
 * are the most recognisable tell of machine-written prose and this copy is
 * published under a client's name. A prompt rule is a request: models comply
 * most of the time, which is exactly the failure mode that makes a rule
 * useless, because nobody reads every draft looking for punctuation.
 *
 * So it lives here, with the other rules a JSON schema cannot express. It
 * costs nothing to run, it is impossible to argue with, and the `action` it
 * produces names the offending span so the revision pass can fix it without
 * touching anything else.
 *
 * The double hyphen is included because it is what a model reaches for when
 * told not to use the character.
 */
const EM_DASH = /—|–\s|\s–|(?<![-\w])--(?![-\w])/g;

/** Enough of the sentence around the mark to find it by eye. */
function context(text: string, at: number, radius = 42): string {
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '...' : ''}`;
}

export function checkHouseStyle(body: string, assetKind: AssetKind): Flag[] {
  const hits: string[] = [];
  for (const m of body.matchAll(EM_DASH)) {
    hits.push(context(body, m.index ?? 0));
    if (hits.length === 4) break;     // four is plenty to act on
  }
  if (!hits.length) return [];

  return [flag(
    'house_style_em_dash', assetKind, 'blocking',
    `The ${assetKind} uses an em dash ${hits.length === 1 ? 'once' : `${hits.length} times`}. ` +
    `House style forbids it, because it is the clearest signal that copy was machine-written.`,
    'Remove every em dash and every double hyphen standing in for one. Replace each with a ' +
    'full stop, a comma, a colon or brackets, whichever keeps the sentence closest to what ' +
    `it already says. Change nothing else. The occurrences are: ${hits.map((h) => `"${h}"`).join('; ')}`,
  )];
}
