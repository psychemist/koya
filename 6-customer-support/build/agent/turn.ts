import { config } from '../lib/config.ts';
import { one, query } from '../lib/db.ts';
import { recordSpend, spentToday } from '../lib/ledger.ts';
import { LINES, fallbackFor, type AnswerType } from '../lib/lines.ts';
import { checkReply, retryMessage, type Violation } from '../lib/gates/reply.ts';
import { loadTurnFacts } from './facts.ts';
import type { SessionManager } from './sessions.ts';
import type { RuntimeEvent } from './runtime.ts';

/** Voice speaks both kinds; chat shows only replies, because a filler line is a pause, not a message. */
export interface SpeechSink { say(text: string, kind?: 'filler' | 'reply'): void }
export type TurnChannel = 'voice' | 'chat';

export function collectSink(): SpeechSink & { reply(): string } {
  const lines: string[] = [];
  return { say(text, kind = 'reply') { if (kind === 'reply') lines.push(text); }, reply: () => lines.join(' ') };
}
export type TurnStatus = 'ok' | 'fallback' | 'failed' | 'capacity' | 'noise' | 'replayed' | 'interrupted';
export type TurnOutcome = { status: TurnStatus; answerType: AnswerType | null; spoken: string; turnId: string | null };

const FILLERS = new Set(['uh', 'uhh', 'um', 'umm', 'erm', 'er', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mmhmm', 'mhm', 'ah', 'ahh', 'eh', 'oh']);

/** Review Focus 3: background noise and hesitation get no model call and no turn row. A real one-word answer is not noise. */
export function isNoise(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return t === '' || FILLERS.has(t);
}

/** The per-turn facts the cached system prompt cannot hold: the time, and on recovery, what was said before. */
export function frameCallerText(text: string, now: Date, prior?: string, channel: TurnChannel = 'voice'): string {
  const lines = [`[Current time: ${now.toISOString()} UTC]`, `[Channel: ${channel === 'chat' ? 'web chat' : 'voice call'}]`];
  if (prior) lines.push('[Prior transcript, for context only]', prior, '[End of prior transcript]');
  lines.push(`Caller said: ${text}`);
  return lines.join('\n');
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function recordTurn(r: { conversationId: string; text: string; spoken: string; answerType: AnswerType; confidence: string | null;
  citations: string[]; status: string; attempts: number; violations: Violation[]; latencyMs: number; costUsd: number; model: string | null }): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into public.conversation_turns (conversation_id, seq, user_transcript, assistant_response, answer_type, confidence_note,
       citations, status, gate_result, latency_ms, cost_usd, model)
     select $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 from public.conversation_turns where conversation_id = $1
     returning id`,
    [r.conversationId, r.text, r.spoken, r.answerType, r.confidence, r.citations, r.status,
     JSON.stringify({ attempts: r.attempts, violations: r.violations }), r.latencyMs, r.costUsd, r.model]);
  await recordSpend('anthropic', r.costUsd, r.conversationId, 'turn');
  await query(`update public.conversations set turn_count = turn_count + 1, cost_usd = cost_usd + $2, model = coalesce(model, $3) where id = $1`,
    [r.conversationId, r.costUsd, r.model]);
  return row!.id;
}

/**
 * One caller utterance in, one approved reply out, one turn row written.
 * Nothing reaches the sink that the gates have not passed, except the fixed
 * lines, which are reviewed copy. Turns for one conversation run in order.
 */
export function runTurn(deps: { sessions: SessionManager; now?: () => Date },
  input: { conversationId: string; text: string; prior?: string; channel?: TurnChannel }, sink: SpeechSink): Promise<TurnOutcome> {
  const { sessions } = deps;
  const text = input.text.trim();
  const channel = input.channel ?? 'voice';
  if (isNoise(text)) { sink.say(LINES.didntCatch); return Promise.resolve({ status: 'noise', answerType: null, spoken: LINES.didntCatch, turnId: null }); }

  return sessions.withLock(input.conversationId, async (): Promise<TurnOutcome> => {
    const t0 = Date.now();
    const id = input.conversationId;

    // Replay: Vapi re-posts the last utterance on reconnect. Answer from the stored turn, never re-run it.
    const latest = await one<{ user_transcript: string; assistant_response: string; answer_type: AnswerType; id: string; fresh: boolean }>(
      `select id, user_transcript, assistant_response, answer_type, created_at > now() - interval '5 seconds' as fresh
       from public.conversation_turns where conversation_id = $1 order by seq desc limit 1`, [id]);
    if (latest?.fresh && normalise(latest.user_transcript) === normalise(text)) {
      sink.say(latest.assistant_response);
      return { status: 'replayed', answerType: latest.answer_type, spoken: latest.assistant_response, turnId: latest.id };
    }

    const base = { conversationId: id, text, confidence: null, citations: [] as string[], attempts: 0, violations: [] as Violation[], model: null as string | null };
    if ((await spentToday('anthropic')) >= config.agent.dailyCapUsd) {
      const spoken = `${LINES.capacity} ${channel === 'chat' ? LINES.chatGoodbye : LINES.goodbye}`;
      sink.say(spoken);
      const turnId = await recordTurn({ ...base, spoken, answerType: 'decline', status: 'capacity', latencyMs: Date.now() - t0, costUsd: 0 });
      return { status: 'capacity', answerType: 'decline', spoken, turnId };
    }

    // The per-call budget belongs to the conversation, not the session: a session rebuilt from history
    // would otherwise start a fresh maxBudgetUsd (spec §4.5).
    const spent = await one<{ cost: number }>('select cost_usd::float8 as cost from public.conversations where id = $1', [id]);
    if ((spent?.cost ?? 0) >= config.agent.maxBudgetUsd) {
      sink.say(LINES.limitReached);
      const turnId = await recordTurn({ ...base, spoken: LINES.limitReached, answerType: 'decline', status: 'capacity', latencyMs: Date.now() - t0, costUsd: 0 });
      return { status: 'capacity', answerType: 'decline', spoken: LINES.limitReached, turnId };
    }

    const since = (await one<{ now: Date }>('select now() as now'))!.now;
    const now = deps.now?.() ?? new Date();
    const session = await sessions.getOrOpen(id);
    let cost = 0, attempts = 0, fillerSaid = false, violations: Violation[] = [], intended: AnswerType | undefined;
    let facts = null as Awaited<ReturnType<typeof loadTurnFacts>> | null;
    let approved = null as ReturnType<typeof checkReply>['reply'];

    for (attempts = 1; attempts <= 2; attempts++) {
      const prompt = attempts === 1 ? frameCallerText(text, now, input.prior, channel) : retryMessage(violations);
      let result: Extract<RuntimeEvent, { kind: 'result' }> | null = null;
      try {
        for await (const e of session.turn(prompt)) {
          if (e.kind === 'tool_start' && !fillerSaid) { fillerSaid = true; sink.say(LINES.filler, 'filler'); }
          if (e.kind === 'result') result = e;
        }
      } catch { result = null; }
      if (result) cost += result.costUsd;
      if (sessions.consumeInterrupt(id)) {
        const turnId = await recordTurn({ ...base, spoken: '', answerType: 'decline', status: 'interrupted', attempts, violations,
          latencyMs: Date.now() - t0, costUsd: cost, model: session.model });
        return { status: 'interrupted', answerType: null, spoken: '', turnId };
      }
      if (!result || !result.ok) {
        sink.say(LINES.failure);
        const turnId = await recordTurn({ ...base, spoken: LINES.failure, answerType: 'decline', status: 'failed', attempts, violations,
          latencyMs: Date.now() - t0, costUsd: cost, model: session.model });
        return { status: 'failed', answerType: 'decline', spoken: LINES.failure, turnId };
      }
      facts = await loadTurnFacts(id, since, text);
      const gate = checkReply(result.output, facts);
      if (gate.reply) intended = gate.reply.answer_type;
      if (gate.ok) { approved = gate.reply; violations = []; break; }
      violations = gate.violations;
    }
    attempts = Math.min(attempts, 2);

    let status: TurnStatus = 'ok', spoken: string, answerType: AnswerType;
    if (approved) { spoken = approved.spoken_response; answerType = approved.answer_type; }
    else {
      const path: AnswerType | undefined = facts?.escalationRequired ? 'escalate' : intended;
      spoken = fallbackFor(path);
      answerType = path === 'escalate' ? 'escalate' : 'decline';
      status = 'fallback';
    }
    sink.say(spoken);
    const turnId = await recordTurn({ ...base, spoken, answerType, confidence: approved?.confidence_note ?? null, citations: approved?.citations ?? [],
      status, attempts, violations, latencyMs: Date.now() - t0, costUsd: cost, model: session.model });
    return { status, answerType, spoken, turnId };
  });
}
