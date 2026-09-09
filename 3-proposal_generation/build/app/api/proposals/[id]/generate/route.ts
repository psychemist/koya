import { requireRole } from "../../../../../lib/auth";
import { newCorrelationId, toAppError } from "../../../../../lib/errors";
import { recordEvent } from "../../../../../lib/audit";
import { generateDraft, type GenerationEvent } from "../../../../../lib/proposal/service";
import { LIMITS, enforce } from "../../../../../lib/ratelimit";

/**
 * Generation, streamed to the browser over Server-Sent Events.
 *
 * Streaming is not decoration. A full draft is seven sections of prose at high
 * effort and takes long enough that a spinner would read as a hang; watching
 * the sections fill in is also how a salesperson decides early that the tone
 * is wrong and stops it.
 *
 * SSE rather than a WebSocket because the traffic is one-directional and SSE
 * needs no extra infrastructure — it is an HTTP response that stays open, and
 * it reconnects on its own.
 *
 * This route does NOT use the shared `route()` wrapper: that wrapper returns
 * JSON and writes its audit row after the handler resolves, whereas here the
 * response has to start before the work does. Correlation and auditing are
 * therefore done explicitly below, to the same standard.
 */

export const runtime = "nodejs";
/** Generation regularly runs past the default; a truncated stream is a failed draft. */
export const maxDuration = 300;

function sse(event: GenerationEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(
  request: Request,
  segment: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = newCorrelationId();
  const { id } = await segment.params;

  // Authorisation happens BEFORE the stream opens. A 403 delivered as an SSE
  // message inside a 200 response is much harder for a client to handle than
  // a plain HTTP status.
  let user;
  try {
    user = await requireRole("salesperson", "approver");
  } catch (err) {
    const app = toAppError(err);
    await recordEvent({
      correlationId,
      action: "proposal.generate",
      outcome: "denied",
      proposalId: id,
      errorCode: app.code,
      detail: { message: app.message },
    });
    return Response.json(
      {
        ok: false,
        error: { code: app.code, message: app.userMessage, correlationId },
      },
      { status: app.httpStatus, headers: { "X-Correlation-Id": correlationId } },
    );
  }

  // Cost ceiling, enforced before the stream opens for the same reason the
  // role check is: a 429 delivered as an SSE message inside a 200 is far
  // harder for the client to act on than a real status code. This is the most
  // expensive call in the application — a full Opus draft — so it is the one
  // that most needs a bound that does not depend on the UI disabling a button.
  try {
    await enforce(LIMITS.generate, user.id, "You have generated a lot of drafts in the last hour.");
  } catch (err) {
    const app = toAppError(err);
    await recordEvent({
      correlationId,
      action: "proposal.generate",
      outcome: "denied",
      actorId: user.id,
      proposalId: id,
      errorCode: app.code,
      detail: { message: app.message },
    });
    return Response.json(
      { ok: false, error: { code: app.code, message: app.userMessage, retryable: true, correlationId } },
      { status: app.httpStatus, headers: { "X-Correlation-Id": correlationId } },
    );
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: GenerationEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event)));
        } catch {
          // The client navigated away mid-generation. Generation itself
          // continues to completion so the work is not wasted — the sections
          // are still written and the gates still run.
          closed = true;
        }
      };

      try {
        await generateDraft({
          proposalId: id,
          actor: user,
          correlationId,
          force,
          onEvent: send,
        });

        await recordEvent({
          correlationId,
          action: "proposal.generate",
          outcome: "ok",
          actorId: user.id,
          proposalId: id,
          latencyMs: Date.now() - started,
          detail: { force },
        });
      } catch (err) {
        const app = toAppError(err);
        // generateDraft already emitted an `error` event and returned the
        // proposal to `draft`. This is the belt-and-braces case where
        // something threw before it could.
        send({
          type: "error",
          code: app.code,
          message: app.userMessage,
          correlationId,
        });
        await recordEvent({
          correlationId,
          action: "proposal.generate",
          outcome: "error",
          actorId: user.id,
          proposalId: id,
          latencyMs: Date.now() - started,
          errorCode: app.code,
          detail: { ...app.detail, message: app.message },
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells nginx and similar not to buffer the response, which would
      // deliver the whole stream at once and defeat the point.
      "X-Accel-Buffering": "no",
      "X-Correlation-Id": correlationId,
    },
  });
}
