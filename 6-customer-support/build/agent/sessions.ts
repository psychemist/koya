import { config } from '../lib/config.ts';
import type { AgentRuntime, AgentSession } from './runtime.ts';

export type SessionKind = 'voice' | 'chat';
type OpenOpts = { model?: string; mcpFault?: 'mcp_down' | 'calendar_down' | null; kind?: SessionKind };
type Entry = { session: AgentSession; lastUsed: number; kind: SessionKind };

/**
 * One warm Agent SDK session per live conversation, and one lock per
 * conversation so its turns run strictly in order. The lock is kept apart
 * from the session because a turn must be able to queue before its session
 * exists (a rebuilt chat, a call whose prewarm has not finished).
 */
export class SessionManager {
  private sessions = new Map<string, Entry>();
  private opening = new Map<string, Promise<AgentSession>>();
  private locks = new Map<string, Promise<unknown>>();
  private inFlight = new Map<string, Promise<unknown>>();
  private interrupted = new Set<string>();
  readonly max: number;

  constructor(private runtime: AgentRuntime, opts: { max?: number } = {}) {
    this.max = opts.max ?? config.agent.maxConcurrentCalls;
  }

  get size() { return this.sessions.size + [...this.opening.keys()].filter((k) => !this.sessions.has(k)).length; }
  has(id: string) { return this.sessions.has(id) || this.opening.has(id); }

  /** Concurrent callers for one id share one open: two webhooks racing never start two subprocesses. */
  async getOrOpen(id: string, opts: OpenOpts = {}): Promise<AgentSession> {
    const e = this.sessions.get(id);
    if (e) { e.lastUsed = Date.now(); return e.session; }
    let p = this.opening.get(id);
    if (!p) {
      const { kind = 'voice', ...open } = opts;
      p = this.runtime.open(id, open).then((session) => { this.sessions.set(id, { session, lastUsed: Date.now(), kind }); return session; })
        .finally(() => this.opening.delete(id));
      this.opening.set(id, p);
    }
    return p;
  }

  /** Runs fn after every earlier call for this conversation has settled, and marks it in flight. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => {
      const p = fn();
      this.inFlight.set(id, p);
      return p.finally(() => { if (this.inFlight.get(id) === p) this.inFlight.delete(id); });
    });
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  isInFlight(id: string) { return this.inFlight.has(id); }

  /** A new utterance for a call with a turn running: stop the old one and wait for it to finish recording. */
  async interruptInFlight(id: string): Promise<void> {
    const p = this.inFlight.get(id);
    if (!p) return;
    this.interrupted.add(id);
    await this.sessions.get(id)?.session.interrupt().catch(() => undefined);
    await p.catch(() => undefined);
  }

  /** True once, for the turn that was interrupted. */
  consumeInterrupt(id: string): boolean { return this.interrupted.delete(id); }

  /** Waits for the running turn, but never longer than ms: a hung turn must not hold a hang-up hostage. */
  async settle(id: string, ms: number): Promise<void> {
    const p = this.locks.get(id);
    if (!p) return;
    await Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);
  }

  async close(id: string): Promise<void> {
    const opening = this.opening.get(id);
    if (opening) await opening.catch(() => undefined);
    const e = this.sessions.get(id);
    this.sessions.delete(id);
    await e?.session.close().catch(() => undefined);
  }

  /** Chat sessions idle faster than calls (Task 14b): a slow typist must not hold a subprocess a caller needs. */
  async closeIdle(maxIdleMs: number, kind?: SessionKind): Promise<number> {
    const now = Date.now(); let n = 0;
    for (const [id, e] of [...this.sessions]) {
      if ((!kind || e.kind === kind) && now - e.lastUsed >= maxIdleMs && !this.inFlight.has(id)) { await this.close(id); n++; }
    }
    return n;
  }

  /**
   * When the pool is full, the least recently used idle session of this kind
   * gives its slot up. Its conversation is rebuilt from stored turns on its
   * next message, so nothing is lost but the warm start. A voice session is
   * never evicted this way: a caller is mid-sentence.
   */
  async evictOneIdle(kind: SessionKind): Promise<boolean> {
    let pick: [string, Entry] | null = null;
    for (const [id, e] of this.sessions) {
      if (e.kind !== kind || this.inFlight.has(id)) continue;
      if (!pick || e.lastUsed < pick[1].lastUsed) pick = [id, e];
    }
    if (!pick) return false;
    await this.close(pick[0]);
    return true;
  }

  async closeAll(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.close(id); }
}
