/**
 * The logging boundary.
 *
 * Assemble a log line from a tool input once, and a credential ends up in a
 * screenshot in a demo video. This runs on everything before it is written
 * anywhere: the tool_calls table, stdout, a Discord payload.
 */
const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|bearer|credential)/i;
const SECRET_VALUE = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /apify_api_[A-Za-z0-9]{8,}/g,
  /sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g,
  /fc-[A-Za-z0-9]{8,}/g,
  /re_[A-Za-z0-9_-]{8,}/g,
  /https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function redactString(s: string): string {
  return SECRET_VALUE.reduce((acc, re) => acc.replace(re, '[REDACTED]'), s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * Strips the characters that carry a prompt injection invisibly.
 *
 * Zero-width joiners, bidi overrides and friends are how an instruction hides
 * inside text that looks innocent to the reviewer reading the same page. This
 * runs before the injection screen, which is what makes the screen's patterns
 * match text that was written to evade them.
 */
export function stripInvisible(s: string): string {
  return s
    .replace(/[​-‏‪-‮⁠-⁤﻿᠎]/g, '')
    .replace(/­/g, '')
    .normalize('NFKC');
}
