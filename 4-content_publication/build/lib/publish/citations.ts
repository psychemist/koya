/**
 * Citation markers, and why they must not survive to a published post.
 *
 * The drafting prompt requires every figure, date, percentage and quotation to
 * carry the label of the excerpt it came from, inline, like `[S1d20P1]`. That
 * contract is the reason the grounding check can work at all: it is what turns
 * "the model says this is sourced" into a span a person can follow back to the
 * bytes we stored.
 *
 * It is also editorial scaffolding. `S1d20P1` is a source row's uuid prefix and
 * an ordinal. It means nothing to a reader, and it was on its way onto a
 * client's LinkedIn feed, because the approve route queued `asset.body`
 * verbatim and nothing between the writer and the connector had ever looked at
 * it. The reviewer sees the markers on the review screen and reads them as
 * normal, which is exactly how they become invisible.
 *
 * So they are stripped HERE, at the boundary where text stops being a draft
 * and becomes a post, rather than by asking the model not to produce them:
 *  - the gates need them, so they have to exist up to this point;
 *  - a prompt instruction is a request, and this has to be a guarantee.
 *
 * `[NEEDS SOURCE: …]` is deliberately NOT stripped. It marks a fact the
 * sources did not carry, which is the correct output when they do not, and
 * removing it would silently publish a sentence with a hole where its evidence
 * should be. It blocks approval instead. See lib/gates/tier0/citations.ts.
 */

/**
 * `S` + the first four characters of a source uuid + `P` + an ordinal, which
 * is what lib/pipeline/research.ts writes into `excerpts.label`. Bounded
 * rather than greedy: `[Some Product P1]` in ordinary prose is not a citation,
 * and a loose pattern that ate it would quietly damage the copy it was meant
 * to be cleaning.
 */
const MARKER = /\[\s*S[0-9a-f]{1,8}P\d{1,4}(?:\s*[,;]\s*S[0-9a-f]{1,8}P\d{1,4})*\s*\]/gi;

export function hasCitationMarkers(text: string): boolean {
  MARKER.lastIndex = 0;
  return MARKER.test(text);
}

export function citationMarkers(text: string): string[] {
  return [...(text.match(MARKER) ?? [])];
}

/**
 * Strip the markers and close the hole they leave.
 *
 * The tidying is the half that is easy to skip and immediately visible if you
 * do: deleting the marker from `revenue grew 14% [S1a2bP3]. The next` leaves
 * two spaces before `The`, and from `…grew 14% [S1a2bP3].` leaves a space
 * before the full stop. Both read as a typo in a published post, which is the
 * thing this function exists to prevent.
 */
export function stripCitations(text: string): string {
  return text
    .replace(MARKER, '')
    // A space now sitting in front of punctuation that closed the sentence.
    .replace(/[ \t]+([.,;:!?)\]])/g, '$1')
    // Two spaces where the marker used to be.
    .replace(/[ \t]{2,}/g, ' ')
    // A line that is now nothing but trailing whitespace.
    .replace(/[ \t]+$/gm, '')
    // Three or more newlines, which is a paragraph break that lost its content.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
