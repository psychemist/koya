import { NextResponse } from 'next/server';
import { correlationId } from './hash';
import { AppError, toResponseBody } from './errors';
import { event } from './audit';

/**
 * Every route handler goes through here.
 *
 * Three things it guarantees:
 *  - a correlation ID on every response, in a header and in every error body,
 *    so "the button went red" leads to the exact events row;
 *  - internal detail never reaches the browser;
 *  - a failure is always recorded, even when the handler forgot to.
 */
export function route<T>(
  stage: string,
  handler: (ctx: { correlationId: string }) => Promise<T>,
) {
  return async (): Promise<NextResponse> => {
    const cid = correlationId();
    try {
      const data = await handler({ correlationId: cid });
      return NextResponse.json(
        { data, correlationId: cid },
        { headers: { 'x-correlation-id': cid } },
      );
    } catch (e) {
      const { body, status } = toResponseBody(e, cid);
      await event({
        correlationId: cid, stage, outcome: 'failed',
        detail: { error: e instanceof Error ? e.message : String(e) },
      });
      return NextResponse.json(body, { status, headers: { 'x-correlation-id': cid } });
    }
  };
}

export async function handle<T>(
  stage: string,
  fn: (cid: string) => Promise<T>,
): Promise<NextResponse> {
  const cid = correlationId();
  try {
    const data = await fn(cid);
    return NextResponse.json({ data, correlationId: cid }, {
      headers: { 'x-correlation-id': cid },
    });
  } catch (e) {
    const { body, status } = toResponseBody(e, cid);
    await event({
      correlationId: cid, stage, outcome: 'failed',
      detail: {
        error: e instanceof Error ? e.message : String(e),
        // AppError.detail is the half deliberately kept OUT of the response,
        // which is why it has to go somewhere. Dropping it here meant the
        // audit log recorded the sentence shown to the user and nothing more,
        // so a truncation said "ran out of output space" without naming the
        // model or the ceiling that ran out.
        ...(e instanceof AppError ? { code: e.code, detail: e.detail } : {}),
      },
    });
    return NextResponse.json(body, { status, headers: { 'x-correlation-id': cid } });
  }
}
