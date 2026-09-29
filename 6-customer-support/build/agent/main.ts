import { config } from '../lib/config.ts';
import { startup } from './sdk.ts';
import { claudeRuntime } from './claude-runtime.ts';
import { SessionManager } from './sessions.ts';
import { createAgentServer } from './http.ts';
import { finalizeStale } from '../lib/conversations.ts';

// 1. Misconfiguration fails the boot, not the first caller.
void config.agent.dailyCapUsd; void config.agent.internalToken; void config.vapi.customLlmKey; void config.anthropic.key;

// 2. Fault in the native binary once. A WarmQuery is single-use and bound to one call's options
//    (SPIKE.md), so the real prewarm is per call, on status-update in-progress.
try { const warm = await startup({ options: { model: config.models.agent } }); warm.close(); }
catch (e) { console.warn(JSON.stringify({ level: 'warn', at: 'agent_boot', message: `prewarm failed: ${(e as Error).message}` })); }

// 3. Serve.
const sessions = new SessionManager(claudeRuntime());
const server = createAgentServer({ sessions });
const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => console.log(JSON.stringify({ level: 'info', at: 'agent_boot', port, model: config.models.agent, max: sessions.max })));

// 4. Idle sessions give their subprocess back: calls after 10 minutes, chats after 2 (they rebuild from
//    stored turns). Chats idle for 30 minutes, and calls whose end-of-call-report never came, are finalised.
const tick = async () => {
  await sessions.closeIdle(10 * 60_000, 'voice');
  await sessions.closeIdle(2 * 60_000, 'chat');
  for (const s of await finalizeStale(new Date(), { textIdleMs: 30 * 60_000, voiceMaxMs: 20 * 60_000 })) await sessions.close(s.id);
};
const idle = setInterval(() => { tick().catch((e) => console.error(JSON.stringify({ level: 'error', at: 'agent_tick', message: e.message }))); }, 60_000);
idle.unref();

// 5. On deploy: stop accepting, let running turns record, then close every session.
process.on('SIGTERM', async () => {
  server.close();
  await Promise.race([server.drain(), new Promise((r) => setTimeout(r, 10_000))]);
  await sessions.closeAll();
  process.exit(0);
});
