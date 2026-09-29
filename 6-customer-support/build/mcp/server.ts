import { McpServer } from './sdk.ts';
import { register, type ToolSpec } from './define.ts';
import { TOOLS } from './tools/index.ts';

/** A fresh server per request: the transport is stateless, so no state can leak between callers. */
export function buildServer(tools: ToolSpec<any>[] = TOOLS): McpServer {
  const server = new McpServer({ name: 'relaypay', version: '1.0.0' });
  for (const t of tools) register(server, t);
  return server;
}
