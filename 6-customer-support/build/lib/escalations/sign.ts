import { createHmac } from 'node:crypto';

/** How far out of date a request may be and still be acted on (n8n enforces it). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The signed material is `${timestamp}.${rawBody}`, not the body alone.
 *
 * A signature over the body by itself is valid for ever, so anyone who
 * captures one request could replay it and book the same callback again.
 * Putting the timestamp inside the signed material means the clock cannot be
 * moved without invalidating the signature. Ported from Week 5.
 */
export function signPayload(secret: string, rawBody: string, timestampSeconds: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`, 'utf8').digest('hex')}`;
}
