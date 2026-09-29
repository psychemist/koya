import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export const CHAT_COOKIE = 'rp_chat';
export const CHAT_MAX_AGE_S = 43_200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Signed, not encrypted: it names a conversation, and only this browser holds it. The prefix keeps it apart from console tokens. */
const sign = (payload: string) => createHmac('sha256', config.web.sessionSecret).update(`chat:${payload}`).digest('base64url');

export function issueChatToken(conversationId: string, nowMs = Date.now()): string {
  const payload = `${conversationId}.${Math.floor(nowMs / 1000) + CHAT_MAX_AGE_S}`;
  return `${payload}.${sign(payload)}`;
}

export function readChatToken(token: string | null | undefined, nowMs = Date.now()): string | null {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const a = Buffer.from(sig), b = Buffer.from(sign(`${id}.${exp}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(exp) * 1000 > nowMs) || !UUID.test(id)) return null;
  return id;
}

export const chatCookie = (token: string, secure: boolean) =>
  `${CHAT_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CHAT_MAX_AGE_S}${secure ? '; Secure' : ''}`;
export const clearChatCookie = (secure: boolean) =>
  `${CHAT_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
