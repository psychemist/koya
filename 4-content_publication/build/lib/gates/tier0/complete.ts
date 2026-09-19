import { flag, type Flag, type AssetKind } from '../types';

/**
 * Completeness. Boring, and it is the one that stops a half-finished pack
 * reaching a reviewer who then approves what is not there.
 */
export function checkComplete(
  requested: AssetKind[],
  assets: { kind: AssetKind; body: string; subjectLine?: string | null }[],
): Flag[] {
  const flags: Flag[] = [];
  for (const kind of requested) {
    const a = assets.find((x) => x.kind === kind);
    if (!a || !a.body?.trim()) {
      flags.push(flag('incomplete_missing_asset', kind, 'blocking',
        `The ${kind} asset is missing or empty.`,
        `Generate the ${kind} asset.`));
    }
  }
  return flags;
}
