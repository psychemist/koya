import { before, after } from 'node:test';
import { escalationTool } from '../../mcp/tools/create-escalation.ts';
import { withRequestContext } from '../../mcp/context.ts';
import { startStub, type Stub } from './http-stub.ts';

/** Shared by tool-escalation.test.ts and dispatch.test.ts: an n8n that books whatever it is asked, and a Resend that accepts. */
export const lanes = {} as { n8n: Stub; resend: Stub };

export function useEscalationStubs() {
  before(async () => {
    lanes.n8n = await startStub(async (body) => ({ status: 200, json: { booked: true, event_id: 'evt_1', appointment_at: body.requested_slot_utc } }));
    lanes.resend = await startStub(async () => ({ status: 200, json: { id: 'em_1' } }));
    Object.assign(process.env, { N8N_ESCALATION_URL: lanes.n8n.url, N8N_ESCALATION_SECRET: 's', RESEND_API_KEY: 're_test',
      RESEND_API_URL: lanes.resend.url, SUPPORT_INBOX: 'support@example.com' });
  });
  after(async () => { await lanes.n8n.close(); await lanes.resend.close(); });
}

export const monday9 = new Date('2026-10-05T09:00:00Z');
export const base = { user_name: 'Efua Mensah', user_email: 'efua at accrastack dot example', category: 'account',
  reason: 'Account restricted and caller says nobody is helping.' };
export const esc = (conv: string, a: object) => withRequestContext({ conversationId: conv, fault: null },
  async () => (await escalationTool.run({ ...base, ...a } as any, conv, { now: monday9 })).result as any);
