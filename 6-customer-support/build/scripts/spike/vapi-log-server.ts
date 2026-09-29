// Task 0, Q8 to Q11. Logs every request Vapi makes and answers any POST with a
// two-chunk OpenAI-style SSE stream. Run: npx tsx scripts/spike/vapi-log-server.ts
// then: cloudflared tunnel --url http://localhost:8789, and point a throwaway
// Vapi assistant's Custom LLM URL at the tunnel. Delete the assistant afterwards.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8789);
createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  let body: any = null; try { body = JSON.parse(raw); } catch { /* not JSON */ }
  const auth = req.headers.authorization ? `${req.headers.authorization.slice(0, 12)}...` : null;
  console.log(JSON.stringify({
    at: new Date().toISOString(), method: req.method, url: req.url,                                   // Q8
    headers: { ...req.headers, authorization: auth },                                                 // Q9 (header?)
    callId: body?.call?.id ?? null, metadata: body?.metadata ?? null, topKeys: body ? Object.keys(body) : null, // Q9
    messages: body?.messages?.map((m: any) => ({ role: m.role, content: String(m.content ?? '').slice(0, 120) })), // Q11
  }, null, 2));
  if (req.method !== 'POST') { res.writeHead(200).end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const frame = (content: string | null, finish: string | null) => `data: ${JSON.stringify({ id: 'spike', object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'spike', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}\n\n`;
  res.write(frame('Spike reply one. ', null));
  await new Promise((r) => setTimeout(r, 600));
  res.write(frame('Spike reply two.', null));                                                         // Q10: are both spoken?
  res.write(frame(null, 'stop'));
  res.end('data: [DONE]\n\n');
}).listen(port, () => console.log(`vapi log server on :${port}`));
