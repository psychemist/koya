/**
 * A sliding window per key, in memory. Right for one web instance, which is
 * what this deployment runs; a second instance would need a shared store, and
 * each would then allow its own 20.
 */
export function createLimiter(o: { perWindow: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < o.windowMs);
      if (recent.length >= o.perWindow) { hits.set(key, recent); return false; }
      recent.push(now); hits.set(key, recent);
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < o.windowMs)) hits.delete(k);
      return true;
    },
  };
}
