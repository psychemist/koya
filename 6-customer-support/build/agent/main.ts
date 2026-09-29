import { config } from '../lib/config.ts';
import { startup } from './sdk.ts';
import { claudeRuntime } from './claude-runtime.ts';
import { SessionManager } from './sessions.ts';
import { createAgentServer } from './http.ts';

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

// 4. Idle sessions give their subprocess back.
const idle = setInterval(() => { sessions.closeIdle(10 * 60_000).catch(() => undefined); }, 60_000);
idle.unref();

// 5. On deploy: stop accepting, let running turns record, then close every session.
process.on('SIGTERM', async () => {
  server.close();
  await Promise.race([server.drain(), new Promise((r) => setTimeout(r, 10_000))]);
  await sessions.closeAll();
  process.exit(0);
});
