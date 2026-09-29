import { createHash, randomUUID } from 'node:crypto';

export const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');
export const correlationId = () => randomUUID();

/**
 * A stable hash of an object, independent of key order.
 *
 * Key order matters more than it looks: an unstable hash silently defeats
 * every cache keyed on it, and you only find out from the bill.
 */
export function stableHash(value: unknown): string {
  return sha256(canonical(value));
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`;
}
