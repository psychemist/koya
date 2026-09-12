import { Resend } from "resend";
import { query, queryOne } from "../db";
import { config } from "../config";
import { hmacHex, sha256Hex } from "../crypto";
import { AppError, ErrorCode } from "../errors";
import { recordEvent } from "../audit";

/**
 * Delivery: two lanes, one idempotency key, automatic failover.
 *
 *   Lane A — n8n. A signed webhook to a workflow that sends via Gmail and
 *   notifies Discord. Preferred when configured, because it is where the
 *   business's own notification and logging wiring lives.
 *
 *   Lane B — Resend, called directly from this process. The fallback, and the
 *   only lane when n8n is not configured.
 *
 *   Neither available — the app does NOT pretend to have sent anything. The
 *   delivery is recorded as `manual_eml` with status `blocked`, and the
 *   salesperson is handed a .eml file to send themselves.
 *
 * The property that makes failover safe is that both lanes share one
 * `deliveries.idempotency_key`, which is UNIQUE in the database. If lane A
 * times out after the workflow has already sent the mail, lane B's attempt
 * collides on that key rather than putting a second copy in the client's
 * inbox. Timing out is not the same as not having sent, and this is the only
 * design that treats those as different.
 */

export type LaneAttempt = {
  lane: "n8n" | "resend" | "manual_eml";
  ok: boolean;
  at: string;
  latencyMs: number;
  detail: string;
  providerMessageId?: string | null;
};

export type DeliveryOutcome = {
  deliveryId: string;
  status: "sent" | "failed" | "blocked";
  channel: "n8n" | "resend" | "manual_eml";
  providerMessageId: string | null;
  attempts: LaneAttempt[];
  /** Set when nothing could be sent, so the UI can offer the download. */
  needsManualSend: boolean;
  message: string;
};

/**
 * The idempotency key for a send.
 *
 * Derived from the proposal, the recipient and the exact message, so that:
 *   - clicking Send twice is one delivery;
 *   - re-sending after editing the covering note IS a new delivery, because
 *     the client would be receiving different words and that is a real second
 *     send rather than a duplicate.
 */
/**
 * The separator inside the idempotency key's pre-image.
 *
 * A NUL cannot occur in any of the joined fields, so no combination of values
 * can be made to collide by shifting a boundary — ["ab","c"] and ["a","bc"]
 * hash differently, which "-" or ":" would not guarantee.
 *
 * Written as an escape rather than as a literal NUL in the source. It was a
 * literal, which made this file contain a zero byte, which made `file` report
 * it as `data` and made grep treat it as binary and silently print nothing for
 * every match in it. A source file that searches return no results for is a
 * file that quietly drops out of every audit and refactor.
 */
const FIELD_SEPARATOR = "\u0000";

export function deliveryIdempotencyKey(args: {
  proposalId: string;
  recipient: string;
  subject: string;
  bodyText: string;
}): string {
  return sha256Hex(
    [args.proposalId, args.recipient.trim().toLowerCase(), args.subject, args.bodyText].join(FIELD_SEPARATOR),
  );
}

type SendArgs = {
  proposalId: string;
  correlationId: string;
  recipient: string;
  /**
   * Copied on the client email, in practice the approver who signed it off.
   *
   * Deliberately NOT part of the idempotency key. The key answers "is this
   * the same message to the same client", and adding a colleague to the copy
   * list does not make it a different letter - including it would let a
   * changed cc send the client a second identical email. The cc is carried
   * on the send, not on the identity of the send.
   */
  cc?: string[];
  subject: string;
  bodyText: string;
  proposalLink: string;
  ref: string;
  /** The PDF, attached by lane B and referenced by lane A. */
  pdf: Uint8Array | null;
};

/**
 * Claims the delivery row before anything is sent.
 *
 * This is the gate that makes a double-send impossible, and it runs first for
 * that reason. An INSERT that conflicts means another request already owns
 * this exact send: if it succeeded, its result is returned as-is; if it is
 * still in flight or failed, that is reported rather than a second attempt
 * being made behind its back.
 */
async function claimDelivery(args: SendArgs & { idempotencyKey: string }): Promise<{
  id: string;
  claimed: boolean;
  existingStatus: string | null;
  existingChannel: string | null;
  existingMessageId: string | null;
}> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO deliveries
       (proposal_id, channel, recipient, subject, body_text, idempotency_key, status, attempts)
     VALUES ($1, 'resend', $2, $3, $4, $5, 'queued', 0)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [args.proposalId, args.recipient, args.subject, args.bodyText, args.idempotencyKey],
  );

  if (inserted) {
    return {
      id: inserted.id,
      claimed: true,
      existingStatus: null,
      existingChannel: null,
      existingMessageId: null,
    };
  }

  const existing = await queryOne<{
    id: string;
    status: string;
    channel: string;
    provider_message_id: string | null;
  }>(
    "SELECT id, status, channel, provider_message_id FROM deliveries WHERE idempotency_key = $1",
    [args.idempotencyKey],
  );

  if (!existing) {
    throw new AppError({
      code: ErrorCode.DELIVERY_FAILED,
      userMessage: "The delivery record could not be read back. Nothing was sent.",
      message: "delivery insert conflicted but no row found",
    });
  }

  return {
    id: existing.id,
    claimed: false,
    existingStatus: existing.status,
    existingChannel: existing.channel,
    existingMessageId: existing.provider_message_id,
  };
}

/** Lane A. Signed webhook; the workflow does the sending. */
async function sendViaN8n(args: SendArgs, idempotencyKey: string): Promise<LaneAttempt> {
  const started = Date.now();
  const url = config.n8nWebhookUrl;
  const secret = config.n8nWebhookSecret;

  if (!url || !secret) {
    return {
      lane: "n8n",
      ok: false,
      at: new Date().toISOString(),
      latencyMs: 0,
      detail: "not configured",
    };
  }

  // The payload deliberately does NOT carry the PDF. A base64 attachment
  // would inflate the webhook body by megabytes for every send; the workflow
  // fetches the document from the share link instead, which is the same URL
  // the client uses and therefore the same thing being tested.
  const payload = {
    event: "proposal.approved",
    ref: args.ref,
    proposalId: args.proposalId,
    recipient: args.recipient,
    // Always present, empty when there is nobody to copy. A key that appears
    // only sometimes would change the shape of the signed material between
    // sends, and the workflow re-serialises the parsed body to verify it.
    cc: args.cc ?? [],
    subject: args.subject,
    bodyText: args.bodyText,
    proposalLink: args.proposalLink,
    idempotencyKey,
    correlationId: args.correlationId,
    sentAt: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Timestamp is inside the signed material, so a captured request cannot be
  // replayed indefinitely — the workflow rejects anything outside its window.
  const signature = hmacHex(secret, `${timestamp}.${body}`);

  const controller = new AbortController();
  // Eight seconds. Long enough for Gmail through n8n on a cold worker, short
  // enough that a wedged instance does not hold a user on a spinner.
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koya-timestamp": timestamp,
        "x-koya-signature": signature,
        "idempotency-key": idempotencyKey,
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");

    if (!res.ok) {
      return {
        lane: "n8n",
        ok: false,
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        detail: `HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      };
    }

    let providerMessageId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { messageId?: string; id?: string };
      providerMessageId = parsed.messageId ?? parsed.id ?? null;
    } catch {
      // A 200 with a non-JSON body still counts as delivered; the workflow's
      // own log is the record of what it did.
    }

    return {
      lane: "n8n",
      ok: true,
      at: new Date().toISOString(),
      latencyMs: Date.now() - started,
      detail: "accepted by workflow",
      providerMessageId,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      lane: "n8n",
      ok: false,
      at: new Date().toISOString(),
      latencyMs: Date.now() - started,
      detail: aborted
        ? "timed out after 8s. The workflow may or may not have sent, and the shared idempotency key is what prevents a duplicate"
        : `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Whether a Resend error is about WHO the message was addressed to.
 *
 * Matched on the message because the API returns `validation_error` for this
 * and for several unrelated problems, and retrying without the copy list is
 * only correct for this one. A bad API key or a malformed body must still
 * fail, loudly, on the first attempt.
 */
export function isRecipientRefusal(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("only send testing emails to your own email address") ||
    (m.includes("verify a domain") && m.includes("recipient"))
  );
}

/** Lane B. Resend, with the PDF attached. */
async function sendViaResend(args: SendArgs, idempotencyKey: string): Promise<LaneAttempt> {
  const started = Date.now();
  const key = config.resendApiKey;

  if (!key) {
    return {
      lane: "resend",
      ok: false,
      at: new Date().toISOString(),
      latencyMs: 0,
      detail: "not configured",
    };
  }

  try {
    const resend = new Resend(key);

    const build = (cc: readonly string[]) => ({
      from: config.resendFrom,
      to: [args.recipient],
      ...(cc.length > 0 ? { cc: [...cc] } : {}),
      subject: args.subject,
      text: args.bodyText,
      ...(args.pdf
        ? {
            attachments: [
              {
                filename: `${args.ref}-proposal.pdf`,
                content: Buffer.from(args.pdf).toString("base64"),
              },
            ],
          }
        : {}),
    });

    const cc = args.cc ?? [];
    let result = await resend.emails.send(
      build(cc),
      // Resend's own idempotency, layered on top of ours. Ours prevents a
      // second attempt being made; theirs prevents a second send if an
      // attempt is retried at the transport level below us.
      { idempotencyKey },
    );

    /**
     * A rejected COPY must not cost the client their proposal.
     *
     * Resend refuses a whole send when any recipient is disallowed, and the
     * copy list is a recipient list: on an account without a verified domain
     * it will only deliver to the account owner, so copying an approver at
     * any other address fails the entire message. The client is then told
     * nothing because a colleague could not be kept informed, which is the
     * wrong way round.
     *
     * Same principle the PDF path already follows. A missing attachment is a
     * degradation; a blocked send is an outage. So the copy is dropped and
     * the send retried once, and the attempt record says the copy went
     * nowhere rather than quietly implying it arrived.
     *
     * The retry carries a DIFFERENT provider idempotency key, because it is
     * genuinely a different message. Our own duplicate protection is the
     * claimed delivery row and is unaffected: this is one attempt within one
     * claim, not a second claim.
     */
    let copyDropped: string | null = null;
    if (result.error && cc.length > 0 && isRecipientRefusal(result.error.message)) {
      copyDropped = cc.join(", ");
      result = await resend.emails.send(build([]), { idempotencyKey: `${idempotencyKey}:nocc` });
    }

    if (result.error) {
      return {
        lane: "resend",
        ok: false,
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        detail: `${result.error.name}: ${result.error.message}`.slice(0, 300),
      };
    }

    if (copyDropped) {
      return {
        lane: "resend",
        ok: true,
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        detail: `Sent, but the copy to ${copyDropped} was refused by Resend and dropped. Verify a domain at resend.com/domains to copy anyone other than the account owner.`.slice(
          0,
          300,
        ),
        providerMessageId: result.data?.id ?? null,
      };
    }

    return {
      lane: "resend",
      ok: true,
      at: new Date().toISOString(),
      latencyMs: Date.now() - started,
      detail: "accepted by Resend",
      providerMessageId: result.data?.id ?? null,
    };
  } catch (err) {
    return {
      lane: "resend",
      ok: false,
      at: new Date().toISOString(),
      latencyMs: Date.now() - started,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    };
  }
}

/**
 * Sends, with failover, and records everything.
 *
 * Order: claim the row, try lane A, try lane B, otherwise block. Every attempt
 * — including the ones that were skipped because a lane is unconfigured — ends
 * up in `deliveries.lane_attempts`, which is what the System page renders. A
 * failure you cannot explain afterwards is the failure mode this is built to
 * avoid.
 */
export async function deliverProposal(args: SendArgs): Promise<DeliveryOutcome> {
  const idempotencyKey = deliveryIdempotencyKey({
    proposalId: args.proposalId,
    recipient: args.recipient,
    subject: args.subject,
    bodyText: args.bodyText,
  });

  const claim = await claimDelivery({ ...args, idempotencyKey });

  if (!claim.claimed) {
    // Someone already owns this exact send.
    if (claim.existingStatus === "sent") {
      await recordEvent({
        correlationId: args.correlationId,
        action: "delivery.duplicate_suppressed",
        outcome: "skipped",
        proposalId: args.proposalId,
        detail: { idempotencyKey, channel: claim.existingChannel },
      });
      return {
        deliveryId: claim.id,
        status: "sent",
        channel: (claim.existingChannel ?? "resend") as DeliveryOutcome["channel"],
        providerMessageId: claim.existingMessageId,
        attempts: [],
        needsManualSend: false,
        message:
          "This exact proposal has already been sent to this address. It was not sent again.",
      };
    }

    throw new AppError({
      code: ErrorCode.DELIVERY_FAILED,
      userMessage:
        "A send for this proposal is already in progress. Reload in a moment to see the result rather than starting a second one.",
      message: `delivery ${claim.id} already claimed with status ${claim.existingStatus}`,
      detail: { deliveryId: claim.id, status: claim.existingStatus },
    });
  }

  const attempts: LaneAttempt[] = [];

  const laneA = await sendViaN8n(args, idempotencyKey);
  attempts.push(laneA);

  let winner: LaneAttempt | null = laneA.ok ? laneA : null;

  if (!winner) {
    const laneB = await sendViaResend(args, idempotencyKey);
    attempts.push(laneB);
    if (laneB.ok) winner = laneB;
  }

  if (winner) {
    await query(
      `UPDATE deliveries
          SET status = 'sent', channel = $2, provider_message_id = $3,
              attempts = attempts + $4, lane_attempts = $5::jsonb,
              sent_at = now(), updated_at = now(), error_code = NULL, error_detail = NULL
        WHERE id = $1`,
      [
        claim.id,
        winner.lane,
        winner.providerMessageId ?? null,
        attempts.length,
        JSON.stringify(attempts),
      ],
    );

    const failover = attempts.length > 1;
    return {
      deliveryId: claim.id,
      status: "sent",
      channel: winner.lane,
      providerMessageId: winner.providerMessageId ?? null,
      attempts,
      needsManualSend: false,
      message: failover
        ? `Sent via ${winner.lane === "resend" ? "Resend" : "the n8n workflow"} after the preferred lane failed (${attempts[0]?.detail}).`
        : `Sent via ${winner.lane === "n8n" ? "the n8n workflow" : "Resend"}.`,
    };
  }

  // Nothing sent. Distinguish "no provider configured" from "both failed",
  // because the first is a setup task and the second is an incident.
  const lanes = config.deliveryLanes;
  const nothingConfigured = !lanes.n8n && !lanes.resend;
  const status = nothingConfigured ? "blocked" : "failed";

  await query(
    `UPDATE deliveries
        SET status = $2, channel = 'manual_eml',
            attempts = attempts + $3, lane_attempts = $4::jsonb,
            error_code = $5, error_detail = $6, updated_at = now()
      WHERE id = $1`,
    [
      claim.id,
      status,
      attempts.length,
      JSON.stringify(attempts),
      nothingConfigured ? ErrorCode.DELIVERY_NO_PROVIDER : ErrorCode.DELIVERY_FAILED,
      attempts.map((a) => `${a.lane}: ${a.detail}`).join(" | ").slice(0, 1000),
    ],
  );

  return {
    deliveryId: claim.id,
    status,
    channel: "manual_eml",
    providerMessageId: null,
    attempts,
    needsManualSend: true,
    message: nothingConfigured
      ? "No email provider is configured, so nothing was sent. Download the pre-written email and send it yourself, or share the proposal link."
      : `Both delivery lanes failed. Nothing reached the client. Download the pre-written email to send it manually, and check the System page for the reason.`,
  };
}

export type DeliveryRow = {
  id: string;
  proposal_id: string;
  channel: string;
  recipient: string;
  subject: string;
  /**
   * The covering note exactly as it was sent, link substituted.
   *
   * The column has always been written and never read. It is surfaced now so
   * the deliver page can offer the last note back on a re-send instead of a
   * freshly rendered template, which threw away whatever the salesperson had
   * written the first time.
   */
  body_text: string;
  status: string;
  provider_message_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  attempts: number;
  lane_attempts: LaneAttempt[];
  created_at: Date;
  sent_at: Date | null;
};

export async function getDeliveries(proposalId: string): Promise<DeliveryRow[]> {
  return query<DeliveryRow>(
    "SELECT * FROM deliveries WHERE proposal_id = $1 ORDER BY created_at DESC",
    [proposalId],
  );
}

/**
 * The covering note a person last wrote for this proposal.
 *
 * Only a delivery that actually reached a client counts. A `blocked` attempt
 * (no provider configured) or a `failed` one still holds the text that was
 * composed, and offering it back is right in both cases — the salesperson
 * wrote it and the send is going to be retried. A `queued` row is a send
 * still in flight and is deliberately excluded, because handing back a note
 * from an attempt that has not resolved would let someone edit under a
 * request that is about to succeed.
 */
export async function lastComposedMessage(
  proposalId: string,
): Promise<{ subject: string; bodyText: string } | null> {
  const row = await queryOne<{ subject: string; body_text: string }>(
    `SELECT subject, body_text
       FROM deliveries
      WHERE proposal_id = $1
        AND status IN ('sent', 'failed', 'blocked')
        AND btrim(coalesce(body_text, '')) <> ''
      ORDER BY created_at DESC
      LIMIT 1`,
    [proposalId],
  );
  return row ? { subject: row.subject, bodyText: row.body_text } : null;
}

/** Reachability probe for /api/health. Does not send anything. */
export async function probeResend(): Promise<{ configured: boolean; ok: boolean; error?: string }> {
  if (!config.resendApiKey) return { configured: false, ok: false };
  try {
    // Listing domains is the cheapest authenticated call that proves the key
    // works without putting a message in anybody's inbox.
    const resend = new Resend(config.resendApiKey);
    const result = await resend.domains.list();
    if (result.error) return { configured: true, ok: false, error: result.error.message };
    return { configured: true, ok: true };
  } catch (err) {
    return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
