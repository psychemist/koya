/**
 * The logging boundary.
 *
 * Assemble a log line from a tool input once, and a credential ends up in a
 * screenshot in a demo video. This runs on everything before it is written
 * anywhere: the tool_calls table, stdout, an escalation email.
 */
const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|bearer|credential)/i;
const SECRET_VALUE: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/\bpa-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],                       // Voyage
  [/\bre_[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],                        // Resend
  [/https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g, '[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]'],
  [/(postgres(?:ql)?:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1[REDACTED]@'],    // keep the host, lose the password
];

export function redactString(s: string): string {
  return SECRET_VALUE.reduce((acc, [re, to]) => acc.replace(re, to), s);
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
 * Strips the characters that carry a prompt injection invisibly (zero-width
 * joiners, bidi overrides), so a chat message reads the same to the agent as
 * it does to a reviewer.
 */
export function stripInvisible(s: string): string {
  return s.replace(/[​-‏‪-‮⁠-⁤﻿᠎­]/g, '').normalize('NFKC');
}
