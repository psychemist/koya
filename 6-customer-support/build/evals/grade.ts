import type { RunRecord } from './records.ts';

export type Check = { name: string; test: (r: RunRecord) => string | null };   // null means pass; a string is the reason it failed
export type Scenario = { key: string; row: number; title: string; turns: string[]; expected: string; checks: Check[];
  fault?: 'mcp_down' | 'calendar_down'; localOnly?: boolean; repeatLastTurn?: boolean };

const at = (r: RunRecord, i: number) => r.turns[i < 0 ? r.turns.length + i : i];
const ok = (r: RunRecord, tool: string, pred?: (res: any) => boolean) =>
  r.toolCalls.filter((c) => c.tool_name === tool && c.status === 'ok' && (!pred || pred(c.result_summary ?? {})));
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const pathIs = (i: number, type: string): Check => ({ name: `pathIs(${i}, ${type})`,
  test: (r) => { const t = at(r, i); return !t ? `no turn ${i}` : t.answer_type === type ? null : `turn ${i} was ${t.answer_type}`; } });
export const pathIn = (i: number, types: string[]): Check => ({ name: `pathIn(${i}, ${types.join('|')})`,
  test: (r) => { const t = at(r, i); return !t ? `no turn ${i}` : types.includes(t.answer_type) ? null : `turn ${i} was ${t.answer_type}`; } });
export const called = (tool: string, pred?: (res: any) => boolean): Check => ({ name: `called(${tool})`,
  test: (r) => (ok(r, tool, pred).length ? null : ok(r, tool).length ? `${tool} was called, but no result matched` : `${tool} was not called`) });
export const notCalled = (tool: string, pred?: (res: any) => boolean): Check => ({ name: `notCalled(${tool})`,
  test: (r) => (ok(r, tool, pred).length ? `${tool} was called${pred ? ' with a forbidden result' : ''}` : null) });
export const cites = (idSuffix: string): Check => ({ name: `cites(${idSuffix})`,
  test: (r) => (r.turns.some((t) => (t.citations ?? []).some((c) => c.endsWith(idSuffix))) ? null : `no turn cites ${idSuffix}`) });
export const spokenIncludesAny = (i: number, words: string[]): Check => ({ name: `spokenIncludesAny(${i}, ${words.join('|')})`,
  test: (r) => { const t = at(r, i); if (!t) return `no turn ${i}`; const s = t.assistant_response.toLowerCase();
    return words.some((w) => s.includes(w.toLowerCase())) ? null : `turn ${i} said none of: ${words.join(', ')}`; } });
export const spokenExcludes = (re: RegExp): Check => ({ name: `spokenExcludes(${re})`,
  test: (r) => { const hit = r.turns.find((t) => re.test(t.assistant_response)); return hit ? `turn ${hit.seq - 1} said "${clip(hit.assistant_response.match(re)![0], 60)}"` : null; } });
export const gatesClean = (): Check => ({ name: 'gatesClean()',
  test: (r) => { const bad = r.turns.find((t) => t.status !== 'ok' || (t.gate_result?.violations ?? []).length > 0);
    return bad ? `turn ${bad.seq - 1} was ${bad.status}${(bad.gate_result?.violations ?? []).length ? ` (${bad.gate_result.violations!.map((v) => v.gate).join(', ')})` : ''}` : null; } });
export const hasTicket = (): Check => ({ name: 'hasTicket()', test: (r) => (r.tickets.length ? null : 'no ticket') });
export const ticketCount = (n: number): Check => ({ name: `ticketCount(${n})`,
  test: (r) => (r.tickets.length === n ? null : `${r.tickets.length} tickets`) });
export const repeatCallsDeduplicated = (tool: string): Check => ({ name: `repeatCallsDeduplicated(${tool})`,
  test: (r) => { const calls = ok(r, tool); return calls.slice(1).every((c) => c.result_summary?.deduplicated === true) ? null : 'a repeated call was not deduplicated'; } });
export const hasEscalation = (o: { category?: string; withEmail?: string } = {}): Check => ({ name: `hasEscalation(${JSON.stringify(o)})`,
  test: (r) => { const e = r.escalation; if (!e) return 'no escalation';
    if (o.category && e.category !== o.category) return `category was ${e.category}`;
    if (o.withEmail && e.user_email !== o.withEmail) return `email was ${e.user_email}`;
    return null; } });
export const escalationIs = (name: string, pred: (e: NonNullable<RunRecord['escalation']>) => boolean): Check => ({ name: `escalationIs(${name})`,
  test: (r) => (!r.escalation ? 'no escalation' : pred(r.escalation) ? null : `escalation was ${r.escalation.booking_status}, booked ${r.escalation.call_booked}`) });
export const eventLogged = (type: string): Check => ({ name: `eventLogged(${type})`,
  test: (r) => (r.events.some((e) => e.event_type === type) ? null : `no ${type} event`) });
export const turnStatus = (i: number, status: string): Check => ({ name: `turnStatus(${i}, ${status})`,
  test: (r) => { const t = at(r, i); return !t ? `no turn ${i}` : t.status === status ? null : `turn ${i} was ${t.status}`; } });
export const turnCount = (n: number): Check => ({ name: `turnCount(${n})`, test: (r) => (r.turns.length === n ? null : `${r.turns.length} turns`) });

/** Graded only from stored rows. `actual` is what a reviewer reads; `notes` names every failed check. */
export function grade(s: Scenario, r: RunRecord): { passed: boolean; actual: string; notes: string } {
  const failures = s.checks.map((c) => { const why = c.test(r); return why ? `${c.name}: ${why}` : null; }).filter((x): x is string => !!x);
  const tools = [...new Set(r.toolCalls.map((c) => c.tool_name))];
  const actual = [...r.turns.map((t, i) => `Turn ${i + 1} (${t.answer_type}): ${clip(t.assistant_response)}`),
    `Tools: ${tools.length ? tools.join(', ') : 'none'}`].join(' ');
  return { passed: failures.length === 0, actual: clip(actual, 590), notes: failures.join('; ') };
}

/**
 * Spec §11.2, written before the build: any brief row, or more than one
 * adversarial row, failing on Haiku moves the default to Sonnet. A Sonnet run
 * is held to the same bar, so the comparison is like for like.
 */
export function verdict(results: { row: number; passed: boolean; key: string }[], model: string): string {
  const brief = results.filter((r) => r.row >= 1 && r.row <= 8 && !r.passed);
  const adversarial = results.filter((r) => r.row >= 11 && !r.passed);
  const meets = brief.length === 0 && adversarial.length <= 1;
  const failed = [...brief, ...adversarial].map((r) => r.key).join(', ');
  if (/sonnet/.test(model)) return meets ? 'FALSIFIER: sonnet meets the bar' : `FALSIFIER: sonnet misses the bar (failed: ${failed})`;
  if (meets) return `FALSIFIER: haiku holds (${adversarial.length} adversarial failure${adversarial.length === 1 ? '' : 's'})`;
  return `FALSIFIER: switch to sonnet (failed: ${failed})`;
}
