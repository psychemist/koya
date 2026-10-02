import { before, after } from 'node:test';
import { escalationTool } from '../../mcp/tools/create-escalation.ts';
import { withRequestContext } from '../../mcp/context.ts';
import { startStub, type Stub, type StubCall } from './http-stub.ts';

type Answer = { status: number; json: unknown };
/** Every slot asked about is free, and every booking asked for is made. */
export const calFree = {
  slots: (call: StubCall): Answer => ({ status: 200, json: { status: 'success', data: { day: [{ start: call.query.get('start') }] } } }),
  create: (body: any): Answer => ({ status: 201, json: { status: 'success', data: { id: 1, uid: 'bk_1', start: body.start } } }),
  list: (): Answer => ({ status: 200, json: { status: 'success', data: [] } }),
};

/**
 * Shared by tool-escalation.test.ts and dispatch.test.ts: a Cal.com, the two
 * Discord channels (success and error) and a Resend that accept everything. A
 * test swaps `lanes.calAnswers` or a stub's answer to make a lane fail, and
 * puts it back after.
 */
export const lanes = { calAnswers: { ...calFree }, discordStatus: 204, resendStatus: 200 } as {
  cal: Stub; discord: Stub; discordErrors: Stub; resend: Stub; calAnswers: typeof calFree; discordStatus: number; resendStatus: number };

export const bookings = () => lanes.cal.calls.filter((c) => c.method === 'POST' && c.path === '/v2/bookings');

export function useEscalationStubs() {
  before(async () => {
    lanes.cal = await startStub(async (body, call) => call.path === '/v2/slots' ? lanes.calAnswers.slots(call)
      : call.method === 'POST' ? lanes.calAnswers.create(body) : lanes.calAnswers.list());
    lanes.discord = await startStub(async () => ({ status: lanes.discordStatus, json: {} }));
    lanes.discordErrors = await startStub(async () => ({ status: lanes.discordStatus, json: {} }));
    lanes.resend = await startStub(async () => ({ status: lanes.resendStatus, json: { id: 'em_1' } }));
    Object.assign(process.env, { CAL_API_URL: lanes.cal.url, CAL_API_KEY: 'cal_test', CAL_EVENT_TYPE_ID: '42',
      DISCORD_SUCCESS_WEBHOOK_URL: lanes.discord.url, DISCORD_ERROR_WEBHOOK_URL: lanes.discordErrors.url, RESEND_API_KEY: 're_test', RESEND_API_URL: lanes.resend.url,
      SUPPORT_INBOX: 'support@example.com', ESCALATION_STEP_TIMEOUT_MS: '2000' });
  });
  after(async () => { await lanes.cal.close(); await lanes.discord.close(); await lanes.discordErrors.close(); await lanes.resend.close(); });
}

/** Restores every lane to healthy, so one test's outage never leaks into the next. */
export function healLanes() { Object.assign(lanes, { calAnswers: { ...calFree }, discordStatus: 204, resendStatus: 200 }); }

export const monday9 = new Date('2026-10-05T09:00:00Z');
// A fresh address per run: one booked callback per customer is gated, so an escalation left open by an earlier,
// crashed run must not make this run's caller look like they already have a callback.
const runTag = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
export const efuaEmail = `efua.${runTag}@accrastack.example`;
export const base = { user_name: 'Efua Mensah', user_email: `efua dot ${runTag} at accrastack dot example`, category: 'account',
  reason: 'Account restricted and caller says nobody is helping.' };
export const esc = (conv: string, a: object, fault: 'calendar_down' | null = null) => withRequestContext({ conversationId: conv, fault },
  async () => (await escalationTool.run({ ...base, ...a } as any, conv, { now: monday9 })).result as any);
