/**
 * Taking the link out of an X post, because the link is what makes it cost
 * thirteen times as much.
 *
 * X charges $0.015 to post and $0.20 if the post contains a link. Our posts
 * contain links by default, so the difference is not a rounding error: $0.20
 * is roughly 45% of what producing the whole pack costs.
 *
 * Done HERE, at the publish boundary, and not by asking the model for a
 * linkless variant. Three reasons:
 *
 *  1. A second generation is another call, another cost and another thing to
 *     review. The text is already approved; this removes a URL from it.
 *  2. The approval names an exact revision and its evidence hash. Generating
 *     different text would void the approval that was just given, which is the
 *     rule this system will not bend.
 *  3. Tier 0 already proved the post fits in 280 characters WITH the link.
 *     Removing characters cannot break that, so no gate has to run again.
 *
 * What it must not do is leave the post reading as though something is missing.
 * "Full breakdown here: https://…" with the URL cut becomes "Full breakdown
 * here:" which is worse than either version, so a trailing lead-in to a link
 * that is no longer there comes off with it.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]"']+/gi;

export function hasUrl(text: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(text);
}

export function urlsIn(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

export function stripUrls(text: string): string {
  return text
    .replace(URL_RE, '')
    // A lead-in whose link has gone: "Read the full piece here:" or
    // "More below ->". Left alone it reads as a truncated post.
    .replace(/[ \t]*(?:[:\-–]|->|→)[ \t]*$/gm, '')
    // "( )" or "[ ]" left behind where a parenthesised link used to be.
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What X will actually bill for this body, in dollars. */
export const xPostCost = (body: string) => (hasUrl(body) ? 0.2 : 0.015);
