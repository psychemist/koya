import { z } from 'zod/v4';
import { findPromises } from './promises.ts';
import { findSensitive } from './sensitive.ts';
import { checkSpeakable } from './speakable.ts';

export const ReplySchema = z.object({
  answer_type: z.enum(['answer', 'clarify', 'escalate', 'decline']),
  spoken_response: z.string().min(1).max(600),
  citations: z.array(z.string().max(200)).max(6),
  confidence_note: z.string().trim().min(1).max(400),
  escalation_category: z.enum(['compliance', 'account', 'dispute', 'payment', 'other']).nullable(),
});
export type Reply = z.infer<typeof ReplySchema>;
// The CLI refuses zod 4's `$schema: draft 2020-12` stamp (SPIKE.md), so it is dropped.
const { $schema: _dialect, ...replyJsonSchema } = z.toJSONSchema(ReplySchema) as Record<string, unknown>;
export const REPLY_JSON_SCHEMA = replyJsonSchema;
export type TurnFacts = { groundedChunkIds: Set<string>; escalationRequired: boolean; supportNotes: string[];
  callerText: string; knownEmails: string[]; verifiedCustomerId: string | null };
export type Violation = { gate: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6'; detail: string };

export const normalizeSpeech = (s: string) =>
  s.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();

export function checkReply(raw: unknown, facts: TurnFacts) {
  const parsed = ReplySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reply: null,
    violations: [{ gate: 'G1', detail: parsed.error.issues.map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`).join('; ') }] as Violation[] };
  const reply: Reply = { ...parsed.data, spoken_response: normalizeSpeech(parsed.data.spoken_response) };
  const v: Violation[] = [];
  if (reply.answer_type === 'answer') {
    if (reply.citations.length === 0) v.push({ gate: 'G2', detail: 'An answer needs at least one chunk id from a grounded search on this turn.' });
    const bad = reply.citations.filter((c) => !facts.groundedChunkIds.has(c));
    if (bad.length) v.push({ gate: 'G2', detail: `Not retrieved and grounded on this turn: ${bad.join(', ')}. Search again, or decline.` });
  }
  if (facts.escalationRequired && reply.answer_type !== 'escalate')
    v.push({ gate: 'G3', detail: 'A lookup on this turn returned escalation_required: true. The path must be escalate.' });
  for (const p of findPromises(reply.spoken_response)) v.push({ gate: 'G4', detail: `Promises an outcome or time: "${p}"` });
  for (const s of findSensitive(reply.spoken_response, facts)) v.push({ gate: 'G5', detail: s });
  for (const s of checkSpeakable(reply.spoken_response, reply.answer_type)) v.push({ gate: 'G6', detail: s });
  return { ok: v.length === 0, violations: v, reply };
}

export const retryMessage = (v: Violation[]) =>
  `[system check] Your last reply was not spoken. Fix exactly this and reply again in the schema:\n${v.map((x) => `- ${x.gate}: ${x.detail}`).join('\n')}`;
