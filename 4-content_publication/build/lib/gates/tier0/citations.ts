import { flag, type Flag, type AssetKind } from '../types';

/**
 * An unfilled source gap must not reach a reviewer as ordinary prose.
 *
 * The drafting prompt tells the model that when a fact it wants is not in any
 * excerpt, it should write `[NEEDS SOURCE: what is missing]` and move on.
 * Blank beats invented, and that instruction is one of the load-bearing parts
 * of the whole design.
 *
 * Nothing checked that the marker was gone before publishing. A draft carrying
 * one is a draft that is knowingly incomplete, and it was free to be approved
 * and queued, at which point the placeholder goes out on a client's feed. The
 * model did exactly what it was told; the failure would have been ours.
 *
 * Blocking, and it has to be: the correct fix is to find the source or cut the
 * sentence, and both are decisions a person makes.
 */
const NEEDS_SOURCE = /\[NEEDS SOURCE:([^\]]*)\]/gi;

export function checkCitationPlaceholders(draft: string, assetKind: AssetKind): Flag[] {
  const flags: Flag[] = [];
  const seen = new Set<string>();

  for (const m of draft.matchAll(NEEDS_SOURCE)) {
    const missing = (m[1] ?? '').trim() || 'unspecified';
    if (seen.has(missing)) continue;
    seen.add(missing);

    flags.push(flag(
      'citation_needs_source', assetKind, 'blocking',
      `The draft still asks for a source it does not have: "${missing}".`,
      `Either find the fact in a source excerpt and cite it, or cut the sentence. ` +
      `Leaving the marker in place publishes a visible hole; deleting only the marker ` +
      `publishes an unsupported claim, which is worse because nothing downstream can ` +
      `tell it apart from a checked one.`,
      [m.index ?? 0, (m.index ?? 0) + m[0].length],
    ));
  }
  return flags;
}
