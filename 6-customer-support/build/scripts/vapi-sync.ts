import { readFile } from 'node:fs/promises';
import { redactString } from '../lib/sanitise.ts';

/**
 * The assistant is SAVED in Vapi, not sent inline per call: orgs created from
 * 2026-09-23 do not attach credentials to inline server URLs, and a saved
 * assistant is the one the phone number points at. vapi/assistant.json is the
 * source of truth; this pushes it.
 *
 *   npm run vapi:sync          create or update, prints NEXT_PUBLIC_VAPI_ASSISTANT_ID
 *   npm run vapi:sync -- --dry print the rendered body with credential ids masked
 */
const API = 'https://api.vapi.ai';

/** Substitutes ${VAR} in every string, and throws naming the first unset variable. */
export function renderAssistant<T>(template: T, env: Record<string, string | undefined>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
      const x = env[k]; if (!x) throw new Error(`${k} is not set; vapi/assistant.json needs it`); return x;
    });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(template) as T;
}

export async function syncAssistant(fetchFn: typeof fetch, o: { privateKey: string; assistantId?: string; body: object }):
  Promise<{ id: string; action: 'created' | 'updated' }> {
  const url = o.assistantId ? `${API}/assistant/${o.assistantId}` : `${API}/assistant`;
  const res = await fetchFn(url, { method: o.assistantId ? 'PATCH' : 'POST',
    headers: { authorization: `Bearer ${o.privateKey}`, 'content-type': 'application/json' }, body: JSON.stringify(o.body) });
  const text = await res.text();
  // Loud, with Vapi's own message: a field it rejects must be fixed in the file, never silently dropped.
  if (!res.ok) {
    // Scrub the key if Vapi echoes it. Only a key-length string: replacing a short one would mangle the message.
    const scrubbed = o.privateKey.length >= 8 ? redactString(text).replaceAll(o.privateKey, '[REDACTED]') : redactString(text);
    throw new Error(`Vapi answered ${res.status}: ${scrubbed.slice(0, 800)}`);
  }
  return { id: (JSON.parse(text) as { id: string }).id, action: o.assistantId ? 'updated' : 'created' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const template = JSON.parse(await readFile(new URL('../vapi/assistant.json', import.meta.url), 'utf8'));
  let body: object;
  try { body = renderAssistant(template, process.env); } catch (e) { console.error((e as Error).message); process.exit(1); }
  if (process.argv.includes('--dry')) {
    console.log(JSON.stringify(body, (k, v) => (/credentialId$/.test(k) ? '[masked]' : v), 2));
    process.exit(0);
  }
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) { console.error('VAPI_PRIVATE_KEY is not set. It is a scripts-only key: never put it on a service.'); process.exit(1); }
  try {
    const r = await syncAssistant(fetch, { privateKey: key, assistantId: process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID || undefined, body });
    console.log(`${r.action} assistant\nNEXT_PUBLIC_VAPI_ASSISTANT_ID=${r.id}`);
  } catch (e) { console.error((e as Error).message); process.exit(1); }
}
