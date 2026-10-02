/** One sentence per line: a short instruction reads better as its two steps than as one wrapped paragraph. */
export function Lines({ text }: { text: string }) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z+])/);
  return <>{parts.map((p, i) => <span key={i} className="rp-line">{p}</span>)}</>;
}
