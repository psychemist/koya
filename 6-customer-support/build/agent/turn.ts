import { config } from '../lib/config.ts';
import { one, query } from '../lib/db.ts';
import { recordSpend, SPENT_TODAY_SQL } from '../lib/ledger.ts';
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

type Preflight = { now: Date; spent_today: string; conv_cost: number | null; latest_id: string | null; user_transcript: string | null;
  assistant_response: string | null; answer_type: AnswerType | null; fresh: boolean | null };

/** Everything a turn checks before the model, in one round trip: each query is a full trip to the database. */
const preflight = (conversationId: string) => one<Preflight>(
  `select now() as now, ${SPENT_TODAY_SQL} as spent_today,
     (select cost_usd::float8 from public.conversations where id = $1) as conv_cost,
     l.id as latest_id, l.user_transcript, l.assistant_response, l.answer_type, l.fresh
   from (select 1) one_row left join lateral (
     select id, user_transcript, assistant_response, answer_type, created_at > now() - interval '5 seconds' as fresh
     from public.conversation_turns where conversation_id = $1 order by seq desc limit 1) l on true`, [conversationId]);

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function recordTurn(r: { conversationId: string; text: string; spoken: string; answerType: AnswerType; confidence: string | null;
  citations: string[]; status: string; attempts: number; violations: Violation[]; retriedFor?: Violation[]; latencyMs: number; costUsd: number; model: string | null }): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into public.conversation_turns (conversation_id, seq, user_transcript, assistant_response, answer_type, confidence_note,
       citations, status, gate_result, latency_ms, cost_usd, model)
     select $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 from public.conversation_turns where conversation_id = $1
     returning id`,
    [r.conversationId, r.text, r.spoken, r.answerType, r.confidence, r.citations, r.status,
     // violations: the final attempt's (what the grader reads). retried_for: what the first attempt failed, for the reviewer.
     JSON.stringify({ attempts: r.attempts, violations: r.violations, ...(r.retriedFor?.length ? { retried_for: r.retriedFor } : {}) }), r.latencyMs, r.costUsd, r.model]);
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
    // A caller who hears nothing for a second thinks the line dropped: the filler fills a slow turn, and never follows the reply.
    let fillerSaid = false, replied = false;
    const filler = () => { if (!fillerSaid && !replied) { fillerSaid = true; sink.say(LINES.filler, 'filler'); } };
    const timer = config.agent.fillerAfterMs > 0 ? setTimeout(filler, config.agent.fillerAfterMs) : null;
    const speak = (line: string) => { replied = true; if (timer) clearTimeout(timer); sink.say(line); };
    try { return await turnBody(); } finally { if (timer) clearTimeout(timer); }

  async function turnBody(): Promise<TurnOutcome> {
    const t0 = Date.now();
    const id = input.conversationId;
    const pre = (await preflight(id))!;

    // Replay: Vapi re-posts the last utterance on reconnect. Answer from the stored turn, never re-run it.
    if (pre.latest_id && pre.fresh && normalise(pre.user_transcript ?? '') === normalise(text)) {
      speak(pre.assistant_response ?? '');
      return { status: 'replayed', answerType: pre.answer_type, spoken: pre.assistant_response ?? '', turnId: pre.latest_id };
    }

    const base = { conversationId: id, text, confidence: null, citations: [] as string[], attempts: 0, violations: [] as Violation[], model: null as string | null };
    if (Number(pre.spent_today) >= config.agent.dailyCapUsd) {
      const spoken = `${LINES.capacity} ${channel === 'chat' ? LINES.chatGoodbye : LINES.goodbye}`;
      speak(spoken);
      const turnId = await recordTurn({ ...base, spoken, answerType: 'decline', status: 'capacity', latencyMs: Date.now() - t0, costUsd: 0 });
      return { status: 'capacity', answerType: 'decline', spoken, turnId };
    }

    // The per-call budget belongs to the conversation, not the session: a session rebuilt from history
    // would otherwise start a fresh maxBudgetUsd (spec §4.5).
    if ((pre.conv_cost ?? 0) >= config.agent.maxBudgetUsd) {
      speak(LINES.limitReached);
      const turnId = await recordTurn({ ...base, spoken: LINES.limitReached, answerType: 'decline', status: 'capacity', latencyMs: Date.now() - t0, costUsd: 0 });
      return { status: 'capacity', answerType: 'decline', spoken: LINES.limitReached, turnId };
    }

    const since = pre.now;
    const now = deps.now?.() ?? new Date();
    const session = await sessions.getOrOpen(id);
    let cost = 0, attempts = 0, violations: Violation[] = [], retriedFor: Violation[] = [], intended: AnswerType | undefined;
    let facts = null as Awaited<ReturnType<typeof loadTurnFacts>> | null;
    let approved = null as ReturnType<typeof checkReply>['reply'];

    for (attempts = 1; attempts <= 2; attempts++) {
      const prompt = attempts === 1 ? frameCallerText(text, now, input.prior, channel) : retryMessage(violations);
      let result: Extract<RuntimeEvent, { kind: 'result' }> | null = null;
      try {
        for await (const e of session.turn(prompt)) {
          if (e.kind === 'tool_start') filler();
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
        speak(LINES.failure);
        const turnId = await recordTurn({ ...base, spoken: LINES.failure, answerType: 'decline', status: 'failed', attempts, violations,
          latencyMs: Date.now() - t0, costUsd: cost, model: session.model });
        return { status: 'failed', answerType: 'decline', spoken: LINES.failure, turnId };
      }
      facts = await loadTurnFacts(id, since, text);
      const gate = checkReply(result.output, facts);
      if (gate.reply) intended = gate.reply.answer_type;
      if (gate.ok) { approved = gate.reply; violations = []; break; }
      violations = gate.violations;
      if (attempts === 1) retriedFor = gate.violations;
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
    speak(spoken);
    const turnId = await recordTurn({ ...base, spoken, answerType, confidence: approved?.confidence_note ?? null, citations: approved?.citations ?? [],
      status, attempts, violations, retriedFor, latencyMs: Date.now() - t0, costUsd: cost, model: session.model });
    return { status, answerType, spoken, turnId };
  }
  });
}
