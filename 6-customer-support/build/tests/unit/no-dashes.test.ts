// Sweeps every user-facing literal source: lib/lines.ts, vapi/assistant.json, lib/escalations/email-fallback.ts,
// and every .tsx under app/. Code comments are stripped before the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = ['lib/lines.ts', 'lib/escalations/email-fallback.ts', 'vapi/assistant.json'].map((f) => join(root, f))
  .concat(existsSync(join(root, 'app')) ? walk(join(root, 'app')).filter((f) => f.endsWith('.tsx')) : []);

test('no user-facing literal contains an em dash or en dash', () => {
  for (const f of files) {
    let src: string; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    assert.ok(!/[\u2014\u2013]/.test(code), `${f} contains an em or en dash`);
  }
});
