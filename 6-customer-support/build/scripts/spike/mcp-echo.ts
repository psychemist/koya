// Task 0, Q1 and Q2. An MCP v2 server with one tool that reports the X-Conversation-Id
// header it saw, two ways: from the tool context, and from AsyncLocalStorage set by
// the Node HTTP wrapper. Then a v2 client calls it. Run by hand: npx tsx scripts/spike/mcp-echo.ts [--serve]
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod/v4';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const als = new AsyncLocalStorage<{ conversationId: string | null }>();
const handler = toNodeHandler(createMcpHandler(() => {
  const s = new McpServer({ name: 'relaypay-spike', version: '0.0.0' });
  s.registerTool('echo_header', { description: 'Echo the conversation header', inputSchema: z.object({}) }, async (_args: any, ctx: any) => {
    const fromCtx = ctx?.http?.req?.headers?.get?.('x-conversation-id') ?? null;
    const fromAls = als.getStore()?.conversationId ?? null;
    const out = { fromCtx, fromAls, ctxKeys: Object.keys(ctx ?? {}) };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  });
  s.registerTool('slow_lookup', { description: 'A lookup that takes four seconds. Use only when asked to run the slow lookup.', inputSchema: z.object({}) }, async () => {
    await new Promise((r) => setTimeout(r, 4000));
    return { content: [{ type: 'text', text: '{"done":true}' }] };
  });
  return s;
}));

const port = Number(process.env.PORT ?? 8788);
const http = createServer((req, res) => {
  if (req.url?.startsWith('/mcp')) {
    const h = req.headers['x-conversation-id'];
    return als.run({ conversationId: typeof h === 'string' ? h : null }, () => handler(req, res));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => http.listen(port, r));
console.log(`spike MCP on http://localhost:${port}/mcp`);

if (!process.argv.includes('--serve')) {
  const client = new Client({ name: 'spike-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`),
    { requestInit: { headers: { 'x-conversation-id': 'spike-1' } } }));
  console.log('tools:', (await client.listTools()).tools.map((t) => t.name));
  const r: any = await client.callTool({ name: 'echo_header', arguments: {} });
  console.log('result:', r.content[0].text);
  await client.close();
  http.close();
}
