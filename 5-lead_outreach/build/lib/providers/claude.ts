import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey() });
  return client;
}

/** Published rates per million tokens. Used for the screening loop only; the
 *  agent's own cost comes from the SDK result message. */
const RATES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
};

export function messageCostUsd(model: string, usage?: {
  input_tokens?: number; output_tokens?: number;
}): number {
  const rate = RATES[model] ?? RATES['claude-haiku-4-5'];
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  return (inTok * rate.in + outTok * rate.out) / 1_000_000;
}

/** Pulls the first JSON object out of a text response. Returns null rather
 *  than throwing, because an unparseable screen is a verdict, not a crash. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
