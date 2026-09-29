/**
 * The only file that imports @modelcontextprotocol/*. MCP v2 shipped on
 * 2026-07-27, so when an import path moves, this file changes and nothing else.
 * Names confirmed by the Task 0 spike (SPIKE.md, Q1 and Q2).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export { McpServer, StdioServerTransport, serveStdio, McpClient };

/** A Node request handler that serves one fresh server per request (stateless, both protocol eras). */
export function createHttpHandler(factory: () => McpServer): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handler = toNodeHandler(createMcpHandler(factory));
  return async (req, res) => { await handler(req, res); };
}

export async function connectHttpClient(url: string, headers: Record<string, string>): Promise<McpClient> {
  const client = new McpClient({ name: 'relaypay-test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}
