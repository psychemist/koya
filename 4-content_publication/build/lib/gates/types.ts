export type Severity = 'blocking' | 'advisory';
export type AssetKind = 'article' | 'linkedin' | 'x' | 'newsletter';

/**
 * Every gate returns Flag[], never a boolean.
 *
 * A gate that says "fail" without saying WHICH SPAN and WHAT TO DO cannot
 * drive a targeted revision, and a revision instruction of "improve it" is a
 * coin flip. `action` is written to be handed straight to the model.
 */
export type Flag = {
  code: string;
  severity: Severity;
  assetKind: AssetKind;
  message: string;
  /** Handed verbatim to the reviser. Must name the fix, not the failure. */
  action: string;
  spanStart?: number;
  spanEnd?: number;
};

export const flag = (
  code: string, assetKind: AssetKind, severity: Severity,
  message: string, action: string, span?: [number, number],
): Flag => ({
  code, assetKind, severity, message, action,
  spanStart: span?.[0], spanEnd: span?.[1],
});
