import { FILLERS, type FillerKind } from '../lib/lines.ts';
import { shouldPrefetch } from './prefetch.ts';

const TOOL_KIND: Record<string, FillerKind> = {
  lookup_transaction: 'lookup', lookup_payout: 'lookup', lookup_customer: 'account',
  search_knowledge_base: 'knowledge', create_support_ticket: 'handoff', create_escalation: 'handoff',
};
const UPSET = /\b(frustrat\w*|annoy\w*|angry|upset|ridiculous|unacceptable|urgent\w*|asap|terrible|worst|disappoint\w*|fed up)\b|\bstill (not|waiting|haven)/i;
const REFERENCE = /\b(txn|pay)[\s-]*\d{3,}/i;
const IDENTITY = /\b(my name is|this is|calling from|my email|email is|customer id)\b|\bcus[\s-]*\d{3,}/i;

/**
 * What the turn is doing, from the strongest signal there is: a tool that started says exactly what
 * is happening; before any tool, the caller's own words are the best guess.
 */
export function fillerKind(text: string, tool?: string): FillerKind {
  const t = tool?.replace(/^mcp__relaypay__/, '');
  if (t && TOOL_KIND[t]) return TOOL_KIND[t];
  if (UPSET.test(text)) return 'empathy';
  if (REFERENCE.test(text)) return 'lookup';
  if (IDENTITY.test(text)) return 'account';
  if (shouldPrefetch(text)) return 'knowledge';
  return 'general';
}

/**
 * Remembers the last few lines each conversation heard, so a caller never hears the same filler twice
 * running, and hears sympathy once rather than on every slow turn. Memory is bounded: the oldest
 * conversation is forgotten first.
 */
export class FillerPicker {
  private recent = new Map<string, string[]>();
  constructor(private maxConversations = 1000, private memory = 6) {}

  pick(conversationId: string, kind: FillerKind): string {
    const said = this.recent.get(conversationId) ?? [];
    const k: FillerKind = kind === 'empathy' && said.some((l) => (FILLERS.empathy as readonly string[]).includes(l)) ? 'general' : kind;
    const options: readonly string[] = FILLERS[k];
    const line = options.find((l) => !said.includes(l))
      ?? [...options].sort((a, b) => said.lastIndexOf(a) - said.lastIndexOf(b))[0];
    this.recent.delete(conversationId);
    this.recent.set(conversationId, [...said, line].slice(-this.memory));
    if (this.recent.size > this.maxConversations) this.recent.delete(this.recent.keys().next().value!);
    return line;
  }
}

export const fillers = new FillerPicker();
