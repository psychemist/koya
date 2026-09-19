import { flag, type Flag } from '../types';

/**
 * Channel gates, from the exported formatting_checklist.md.
 *
 * Note which of these come from where, because a future reader will look for
 * the 280 in the brief and not find it:
 *   - LinkedIn: max 2-3 lines per paragraph, 3-5 emojis MAX, a clear CTA  [doc]
 *   - X:        max 1-2 hashtags, one core idea                            [doc]
 *   - X:        <= 280 characters                                          [OURS]
 *   - Newsletter: 250-600 words, subject line, CTA, sign-off               [doc]
 *
 * The 280 is a platform constraint we add. It is labelled so nobody hunts for
 * it in a document that never mentions it.
 */
export const X_MAX_CHARS = 280;           // ours, not the brief's
/**
 * Ours too, not the brief's. LinkedIn's own composer is filled in through a
 * URL query parameter rather than a real API call when someone posts by
 * hand, and that parameter does not reliably carry long text — it can cut
 * off well short of the post's actual length, silently, before anything is
 * posted. Capping length here means that failure mode never has a chance to
 * happen, instead of warning about it after the fact.
 */
/**
 * LinkedIn's own hard limit on a post, and nothing tighter.
 *
 * This was 1000, and 1000 was fighting the writer on every single request.
 * Eleven of the twelve posts the generator has ever produced came out between
 * 1008 and 1771 characters, so `linkedin_too_long` fired as a BLOCKING flag
 * almost every time and the revision loop spent a pass cutting prose that was
 * never too long for LinkedIn. Posts that survived lost 15-25% of themselves
 * (1008 to 788, 1086 to 934, 1211 to 949 by hand), and three requests could
 * not get under the bar in two passes and ended at `needs_human` carrying a
 * blocking flag about a limit that did not exist.
 *
 * The 1000 came from the MANUAL path — LinkedIn's composer not reliably
 * carrying a long prefill — which was true and was the wrong place to fix it.
 * That path now copies to the clipboard instead of stuffing the post into a
 * URL, so nothing is left needing the low ceiling.
 *
 * A blocking gate should mean the provider will refuse this, and the provider
 * refuses above 3000: the Posts API returns 400 FIELD_LENGTH_TOO_LONG on an
 * over-length `commentary`. Anything below that is an editorial opinion, so
 * it is an advisory and says so.
 */
export const LINKEDIN_MAX_CHARS = 3000;

/**
 * Where a post stops reading well, which is a different question from where
 * LinkedIn refuses it. The feed folds a post behind "see more" after roughly
 * 210 characters, so length past this point is read by progressively fewer
 * people rather than rejected. Advisory: worth knowing, stops nothing.
 */
export const LINKEDIN_LONG_CHARS = 2200;
export const LINKEDIN_MAX_EMOJI = 5;      // doc: "3-5 relevant emojis max"
export const NEWSLETTER_WORDS: [number, number] = [250, 600];

const EMOJI = /\p{Extended_Pictographic}/gu;
/**
 * A call to action, as the worked examples actually write them.
 *
 * This started as /\?\s*$/ — a question mark at the very END of the post — and
 * the fixture suite caught that it rejects the source document's OWN example,
 * "What's one ritual you swear by? ☀️", because the emoji comes after the
 * question mark. A gate that fails the brief's own worked example is a gate
 * that trains people to waive it, so the question mark is now looked for
 * anywhere in the closing lines.
 */
const CTA = /\?|comment|share|reply|download|read more|sign up|subscribe|let me know|tell me|try (it|this)|get (the|your)|follow|dm me|drop a/i;

export function checkX(body: string): Flag[] {
  const flags: Flag[] = [];
  const len = [...body].length; // count code points: an emoji is not 4 characters

  if (len > X_MAX_CHARS) {
    flags.push(flag('x_too_long', 'x', 'blocking',
      `The X post is ${len} characters; the limit is ${X_MAX_CHARS}.`,
      `Cut the X post to ${X_MAX_CHARS} characters or fewer without losing the hook ` +
      `in the first line. Remove the closing flourish before you touch the opening.`));
  }
  const tags = body.match(/#\w+/g) ?? [];
  if (tags.length > 2) {
    flags.push(flag('x_too_many_hashtags', 'x', 'blocking',
      `The X post has ${tags.length} hashtags; the limit is 2.`,
      `Keep the 2 most relevant hashtags and delete the rest.`));
  }
  if (!body.trim()) {
    flags.push(flag('x_empty', 'x', 'blocking', 'The X post is empty.', 'Write the X post.'));
  }
  return flags;
}

export function checkLinkedIn(body: string): Flag[] {
  const flags: Flag[] = [];
  if (!body.trim()) {
    return [flag('linkedin_empty', 'linkedin', 'blocking', 'The LinkedIn post is empty.',
      'Write the LinkedIn post.')];
  }

  const len = [...body].length; // count code points: an emoji is not 4 characters
  if (len > LINKEDIN_MAX_CHARS) {
    flags.push(flag('linkedin_too_long', 'linkedin', 'blocking',
      `The LinkedIn post is ${len} characters; LinkedIn refuses anything over ${LINKEDIN_MAX_CHARS}.`,
      `Cut the LinkedIn post to ${LINKEDIN_MAX_CHARS} characters or fewer. Keep the opening ` +
      `hook and the closing call to action; trim from the middle.`));
  } else if (len > LINKEDIN_LONG_CHARS) {
    // Advisory, not blocking. The post will publish exactly as written; this
    // is about how much of it anybody reads.
    flags.push(flag('linkedin_long', 'linkedin', 'advisory',
      `The LinkedIn post is ${len} characters. It will publish, but the feed folds a post ` +
      `behind "see more" after roughly 210, so the tail is read by fewer people.`,
      `Consider trimming towards ${LINKEDIN_LONG_CHARS} characters, front-loading the hook. ` +
      `Nothing is blocked either way.`));
  }

  // Doc says "max 2-3 lines" per paragraph — lines, not sentences.
  const longParas = body.split(/\n{2,}/)
    .filter((p) => p.trim().split(/\n/).length > 3).length;
  if (longParas > 0) {
    flags.push(flag('linkedin_long_paragraphs', 'linkedin', 'advisory',
      `${longParas} paragraph(s) run to more than 3 lines.`,
      'Break the long paragraphs so none exceeds 3 lines. Short blocks are the format.'));
  }

  const emoji = (body.match(EMOJI) ?? []).length;
  if (emoji > LINKEDIN_MAX_EMOJI) {
    flags.push(flag('linkedin_too_many_emoji', 'linkedin', 'blocking',
      `${emoji} emojis; the ceiling is ${LINKEDIN_MAX_EMOJI}.`,
      `Reduce to at most ${LINKEDIN_MAX_EMOJI} emojis. The worked example uses one.`));
  }

  const tail = body.trim().split(/\n/).slice(-3).join(' ');
  if (!CTA.test(tail)) {
    flags.push(flag('linkedin_no_cta', 'linkedin', 'blocking',
      'The LinkedIn post does not end with a clear call to action.',
      'End with a clear CTA: a question to the reader, or an explicit ask.'));
  }
  return flags;
}

export function checkNewsletter(body: string, subject?: string | null): Flag[] {
  const flags: Flag[] = [];
  if (!subject?.trim()) {
    flags.push(flag('newsletter_no_subject', 'newsletter', 'blocking',
      'The newsletter has no subject line.',
      'Write a subject line carrying a clear benefit or a point of intrigue.'));
  }
  const words = body.replace(/[#*_>`]/g, ' ').split(/\s+/).filter(Boolean).length;
  const [lo, hi] = NEWSLETTER_WORDS;
  if (words < lo || words > hi) {
    flags.push(flag('newsletter_length', 'newsletter', 'blocking',
      `The newsletter is ${words} words; the range is ${lo}-${hi}.`,
      words < lo
        ? `Expand the newsletter to at least ${lo} words using material already in the article.`
        : `Cut the newsletter to at most ${hi} words. Drop the secondary item first.`));
  }
  const tail = body.trim().split(/\n/).slice(-4).join(' ');
  if (!CTA.test(tail)) {
    flags.push(flag('newsletter_no_cta', 'newsletter', 'blocking',
      'The newsletter has no clear call to action near the end.',
      'Add a clear CTA before the sign-off: read, download, reply or share.'));
  }
  return flags;
}
