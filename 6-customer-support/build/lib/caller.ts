import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

/**
 * Who is on the support page: a customer who signed in with their account
 * email and customer ID, or a guest. The web server and the agent service both
 * hold AGENT_INTERNAL_TOKEN, so the same signature checks out in both places:
 * the browser carries the cookie on a chat, and the call token through Vapi on
 * a web call, and neither can be altered without the key.
 */
export type Caller = { mode: 'customer'; customerId: string } | { mode: 'guest' };

export const CALLER_COOKIE = 'rp_caller';
export const CALLER_MAX_AGE_S = 43_200;
export const CALL_TOKEN_TTL_S = 600;
const CUSTOMER_ID = /^CUS-\d{4,}$/;

type Kind = 'cookie' | 'call';
const sign = (kind: Kind, payload: string) =>
  createHmac('sha256', config.agent.internalToken).update(`caller-${kind}:${payload}`).digest('base64url');

function issue(kind: Kind, c: Caller, ttlS: number, nowMs: number): string {
  const payload = `${c.mode}.${c.mode === 'customer' ? c.customerId : '-'}.${Math.floor(nowMs / 1000) + ttlS}`;
  return `${payload}.${sign(kind, payload)}`;
}

function read(kind: Kind, token: unknown, nowMs: number): Caller | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [mode, id, exp, sig] = parts;
  const a = Buffer.from(sig), b = Buffer.from(sign(kind, `${mode}.${id}.${exp}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(exp) * 1000 > nowMs)) return null;
  if (mode === 'guest' && id === '-') return { mode: 'guest' };
  if (mode === 'customer' && CUSTOMER_ID.test(id)) return { mode: 'customer', customerId: id };
  return null;
}

export const issueCallerCookie = (c: Caller, nowMs = Date.now()) => issue('cookie', c, CALLER_MAX_AGE_S, nowMs);
export const readCallerCookie = (t: unknown, nowMs = Date.now()) => read('cookie', t, nowMs);
/** Handed to the browser for one web call; a separate kind, so a cookie cannot stand in for it or the other way round. */
export const issueCallToken = (c: Caller, nowMs = Date.now()) => issue('call', c, CALL_TOKEN_TTL_S, nowMs);
export const readCallToken = (t: unknown, nowMs = Date.now()) => read('call', t, nowMs);

export const callerCookie = (token: string, secure: boolean) =>
  `${CALLER_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CALLER_MAX_AGE_S}${secure ? '; Secure' : ''}`;
export const clearCallerCookie = (secure: boolean) =>
  `${CALLER_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

/** One cookie out of a Cookie header. */
export function cookieFrom(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
