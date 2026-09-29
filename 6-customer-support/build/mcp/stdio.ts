import { serveStdio } from './sdk.ts';
import { buildServer } from './server.ts';
import { withRequestContext } from './context.ts';

/**
 * For MCP Inspector and Claude Desktop. There is no transport header on stdio,
 * so MCP_CONVERSATION_ID names one, or each tool call creates an mcp_direct
 * conversation and direct use is still logged. Logs go to stderr: stdout is
 * the protocol.
 */
const ctx = { conversationId: process.env.MCP_CONVERSATION_ID ?? null, fault: null };
await withRequestContext(ctx, () => serveStdio(() => buildServer()));
console.error('relaypay MCP server on stdio');
