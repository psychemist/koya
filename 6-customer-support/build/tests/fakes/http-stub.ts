import { createServer, type IncomingHttpHeaders } from 'node:http';

export type StubCall = { path: string; query: URLSearchParams; method: string; headers: IncomingHttpHeaders; raw: string; body: any };
export type Stub = { url: string; calls: StubCall[]; close(): Promise<void> };

/** A local HTTP server standing in for Cal.com, Discord, Resend or the agent. Records every call it receives. */
export async function startStub(handler: (body: any, call: StubCall) => Promise<{ status: number; json: unknown }>): Promise<Stub> {
  const calls: StubCall[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const u = new URL(req.url ?? '/', 'http://stub.local');
    const call = { path: u.pathname, query: u.searchParams, method: req.method ?? 'GET', headers: req.headers, raw, body };
    calls.push(call);
    const r = await handler(body, call);
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
