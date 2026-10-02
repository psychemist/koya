/**
 * Nine checks against a running stack, deployed or local. Exits non-zero on
 * the first failure and names it. Spends two chat turns (a few cents).
 *
 *   SMOKE_WEB_URL=https://relaypay-web.onrender.com SMOKE_AGENT_URL=https://relaypay-agent.onrender.com \
 *   SMOKE_MCP_URL=https://relaypay-mcp.onrender.com npm run smoke
 *
 * Defaults: APP_BASE_URL, AGENT_URL, and MCP_URL without its /mcp suffix.
 */
export {};

const strip = (u: string | undefined) => (u ?? '').replace(/\/(mcp)?$/, '').replace(/\/$/, '');
const WEB = strip(process.env.SMOKE_WEB_URL ?? process.env.APP_BASE_URL);
const AGENT = strip(process.env.SMOKE_AGENT_URL ?? process.env.AGENT_URL);
const MCP = strip(process.env.SMOKE_MCP_URL ?? process.env.MCP_URL);
if (!WEB || !AGENT || !MCP) { console.error('Set SMOKE_WEB_URL, SMOKE_AGENT_URL and SMOKE_MCP_URL (or APP_BASE_URL, AGENT_URL, MCP_URL).'); process.exit(1); }

const bodies: string[] = [];
const get = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await res.text(); bodies.push(text);
  return { res, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
let n = 0;
async function check(name: string, fn: () => Promise<string | null>) {
  n++;
  let why: string | null;
  try { why = await fn(); } catch (e) { why = (e as Error).message; }
  if (why) { console.error(`FAIL ${n}. ${name}: ${why}`); process.exit(1); }
  console.log(`ok   ${n}. ${name}`);
}

await check('the support page answers and names RelayPay Support', async () => {
  const r = await get(`${WEB}/`); return r.res.status === 200 && r.text.includes('RelayPay Support') ? null : `status ${r.res.status}`;
});
await check('voice is available', async () => {
  const r = await get(`${WEB}/api/voice/availability`); return r.json?.available === true ? null : JSON.stringify(r.json);
});
await check('the agent is healthy, with the database and the MCP server', async () => {
  const r = await get(`${AGENT}/health`); return r.json?.db === true && r.json?.mcp === true ? null : JSON.stringify(r.json);
});
await check('the MCP server is healthy and serves seven tools', async () => {
  const r = await get(`${MCP}/health`); return r.json?.db === true && r.json?.tools === 7 ? null : JSON.stringify(r.json);
});
await check('the MCP server refuses a request without its token', async () => {
  const r = await get(`${MCP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return r.res.status === 401 ? null : `status ${r.res.status}`;
});
await check('the agent webhook refuses a request without the Vapi secret', async () => {
  const r = await get(`${AGENT}/vapi/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return r.res.status === 401 ? null : `status ${r.res.status}`;
});
let cookie = '';
await check('a chat fees question is answered, with an httpOnly SameSite=Lax cookie and no conversation id in the body', async () => {
  const r = await get(`${WEB}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'What fees does RelayPay charge for international payments?' }) });
  const set = r.res.headers.get('set-cookie') ?? '';
  cookie = set.match(/rp_chat=[^;]+/)?.[0] ?? '';
  if (r.json?.answer_type !== 'answer') return `answer_type ${r.json?.answer_type}: ${r.text.slice(0, 160)}`;
  if (!/HttpOnly/i.test(set) || !/SameSite=Lax/i.test(set) || !cookie) return `cookie was "${set}"`;
  return 'conversation_id' in (r.json ?? {}) ? 'the body carried conversation_id' : null;
});
await check('a second message on that cookie continues the same chat', async () => {
  await get(`${WEB}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message: 'Thanks. Are fees shown before I confirm?' }) });
  const t = await get(`${WEB}/api/chat`, { headers: { cookie } });
  return t.json?.turns?.length === 2 ? null : `${t.json?.turns?.length} turns restored`;
});
await check('no response carried a key', async () => {
  const leak = bodies.join('\n').match(/sk-ant-[A-Za-z0-9_-]{8,}|\bpa-[A-Za-z0-9_-]{16,}|\bre_[A-Za-z0-9_-]{8,}/);
  return leak ? `found ${leak[0].slice(0, 8)}...` : null;
});
console.log(`\nAll ${n} smoke checks passed against ${WEB}.`);
