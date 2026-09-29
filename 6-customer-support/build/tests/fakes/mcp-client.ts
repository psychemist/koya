import { connectHttpClient } from '../../mcp/sdk.ts';

/** A real MCP client over real Streamable HTTP, so the tests exercise the wire and not a shortcut. */
export async function connectTestClient(url: string, headers: Record<string, string>) {
  const client = await connectHttpClient(url, headers);
  return {
    async listTools() { return (await client.listTools()).tools.map((t) => t.name); },
    async call(name: string, args: Record<string, unknown>) {
      const r: any = await client.callTool({ name, arguments: args });
      return { isError: !!r.isError, json: JSON.parse(r.content?.[0]?.text ?? 'null') };
    },
    async close() { await client.close(); },
  };
}
