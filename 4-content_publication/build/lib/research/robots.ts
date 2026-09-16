/**
 * robots.txt is not law, but respecting it is treated as evidence of good
 * faith, and the EU AI Act now requires documented provenance for source
 * material. Cheap to check, and the alternative is an argument we would lose.
 *
 * A disallowed URL is REFUSED WITH A STATED REASON, never silently skipped.
 * A source that quietly vanishes is worse than one that visibly failed,
 * because the reviewer cannot tell the difference between "we did not use it"
 * and "we could not".
 */
const cache = new Map<string, { rules: string[]; at: number }>();
const TTL = 15 * 60 * 1000;

export async function robotsAllows(url: string, ua = 'KoyaContentDesk'): Promise<boolean> {
  try {
    const u = new URL(url);
    const key = u.origin;
    let entry = cache.get(key);

    if (!entry || Date.now() - entry.at > TTL) {
      const res = await fetch(`${u.origin}/robots.txt`, { signal: AbortSignal.timeout(5000) });
      // No robots.txt, or an error serving it, is not a prohibition.
      const txt = res.ok ? await res.text() : '';
      entry = { rules: disallowsFor(txt, ua), at: Date.now() };
      cache.set(key, entry);
    }
    return !entry.rules.some((p) => p && u.pathname.startsWith(p));
  } catch {
    // Failing open on a network error is deliberate: an unreachable robots.txt
    // should not silently block research, and the fetch itself will fail
    // visibly if the site is genuinely refusing us.
    return true;
  }
}

function disallowsFor(txt: string, ua: string): string[] {
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const groups: { agents: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const mine = groups.find((g) => g.agents.includes(ua.toLowerCase()));
  const star = groups.find((g) => g.agents.includes('*'));
  return (mine ?? star)?.disallow ?? [];
}
