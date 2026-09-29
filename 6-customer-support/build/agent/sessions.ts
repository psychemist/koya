import { config } from '../lib/config.ts';
import type { AgentRuntime, AgentSession } from './runtime.ts';

type OpenOpts = { model?: string; mcpFault?: 'mcp_down' | 'n8n_down' | null };
type Entry = { session: AgentSession; lastUsed: number };

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
      p = this.runtime.open(id, opts).then((session) => { this.sessions.set(id, { session, lastUsed: Date.now() }); return session; })
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

  async closeIdle(maxIdleMs: number): Promise<number> {
    const now = Date.now(); let n = 0;
    for (const [id, e] of [...this.sessions]) {
      if (now - e.lastUsed >= maxIdleMs && !this.inFlight.has(id)) { await this.close(id); n++; }
    }
    return n;
  }

  async closeAll(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.close(id); }
}
