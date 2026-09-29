import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../lib/config.ts';
import { dbHealthy } from '../lib/db.ts';
import { createHttpHandler } from './sdk.ts';
import { buildServer } from './server.ts';
import { withRequestContext, type RequestContext } from './context.ts';
import { TOOLS } from './tools/index.ts';
import type { ToolSpec } from './define.ts';

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

/** Constant time over equal-length buffers, so the comparison leaks nothing about the token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const headerOf = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' && v ? v : null;
};

export function createMcpHttpServer(tools: ToolSpec<any>[] = TOOLS): Server {
  const handler = createHttpHandler(() => buildServer(tools));
  return createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, db: await dbHealthy(), tools: tools.length });
      if (path !== '/mcp') return json(res, 404, { error: 'not_found' });
      // 1. A browser may never drive this server unless its origin is allowlisted (DNS rebinding).
      const origin = headerOf(req, 'origin');
      if (origin && !config.mcp.allowedOrigins.includes(origin)) return json(res, 403, { error: 'origin_not_allowed' });
      // 2. Bearer, before anything is parsed or any server is built.
      if (!bearerMatches(req.headers.authorization, config.mcp.token)) return json(res, 401, { error: 'unauthorized' });
      // 3 and 4. The conversation comes from the transport, never from the model's arguments.
      const fault = config.agent.allowFaults && headerOf(req, 'x-relaypay-fault') === 'n8n_down' ? 'n8n_down' : null;
      const ctx: RequestContext = { conversationId: headerOf(req, 'x-conversation-id'), fault };
      // 5. Serve.
      await withRequestContext(ctx, () => handler(req, res));
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', at: 'mcp_http', message: (e as Error).message }));
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    }
  });
}

export async function startMcpHttp(port: number, tools?: ToolSpec<any>[]): Promise<Server> {
  const server = createMcpHttpServer(tools);
  await new Promise<void>((r) => server.listen(port, r));
  return server;
}
