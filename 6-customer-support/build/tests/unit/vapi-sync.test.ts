import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAssistant, syncAssistant } from '../../scripts/vapi-sync.ts';

test('an unset variable fails the render and names it', () => {
  assert.throws(() => renderAssistant({ url: '${AGENT_PUBLIC_URL}/vapi' }, {}), /AGENT_PUBLIC_URL/);
});
test('with no assistant id it POSTs once and returns the new id; with one it PATCHes that id', async () => {
  const calls: any[] = [];
  const f = async (url: string, init: any) => { calls.push([init.method, url]); return new Response(JSON.stringify({ id: 'asst_1' }), { status: 200 }); };
  assert.deepEqual(await syncAssistant(f as any, { privateKey: 'k', body: {} }), { id: 'asst_1', action: 'created' });
  await syncAssistant(f as any, { privateKey: 'k', assistantId: 'asst_1', body: {} });
  assert.deepEqual(calls, [['POST', 'https://api.vapi.ai/assistant'], ['PATCH', 'https://api.vapi.ai/assistant/asst_1']]);
});
test('a 400 from Vapi fails loudly with the response body, never silently', async () => {
  const f = async () => new Response('{"message":["keyterm must be an array"]}', { status: 400 });
  await assert.rejects(() => syncAssistant(f as any, { privateKey: 'k', body: {} }), /keyterm/);
});

test('render substitutes nested strings and leaves non-string values alone', () => {
  assert.deepEqual(renderAssistant({ a: { b: 'x ${V} y' }, n: 600, arr: ['${V}'] }, { V: 'v' }), { a: { b: 'x v y' }, n: 600, arr: ['v'] });
});

test('the private key is sent as a bearer and never appears in a thrown error', async () => {
  const seen: any[] = [];
  const f = async (_u: string, init: any) => { seen.push(init.headers.authorization); return new Response('{"message":"bad"}', { status: 400 }); };
  await assert.rejects(() => syncAssistant(f as any, { privateKey: 'secret-key-123', body: {} }), (e: any) => !String(e.message).includes('secret-key-123'));
  assert.equal(seen[0], 'Bearer secret-key-123');
});
