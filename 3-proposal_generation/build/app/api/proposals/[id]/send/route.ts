import { z } from "zod";
import { headers } from "next/headers";
import { readJson, route } from "../../../../../lib/api";
import { queryOne } from "../../../../../lib/db";
import { errors } from "../../../../../lib/errors";
import { recordEvent } from "../../../../../lib/audit";
import { isValidEmail, validateIntake } from "../../../../../lib/proposal/intake";
import {
  openBlockingGaps,
  getProposalOrThrow,
  getSections,
  transitionStatus,
} from "../../../../../lib/proposal/repo";
import { assertCanSend } from "../../../../../lib/proposal/state";
import { ensureShareLink, getShareLinks, rotateShareLink } from "../../../../../lib/proposal/share";
import { resolveOrigin, shareUrl } from "../../../../../lib/url";
import { buildDocumentModel } from "../../../../../lib/docgen/markdown";
import { buildProposalPdf } from "../../../../../lib/docgen/pdf";
import {
  LINK_PLACEHOLDER,
  applyProposalLink,
  renderClientEmail,
} from "../../../../../lib/delivery/message";
import { readEmailOpener } from "../../../../../lib/delivery/opener";
import { deliverProposal } from "../../../../../lib/delivery/send";
import { syncGaps } from "../../../../../lib/proposal/repo";
import type { Role } from "../../../../../lib/auth";
import { assertAccess } from "../../../../../lib/proposal/access";

type Params = { id: string };

const body = z.object({
  subject: z.string().trim().min(3).max(300).optional(),
  bodyText: z.string().trim().min(20).max(20_000).optional(),
  recipient: z.string().trim().max(320).optional(),
});

/**
 * Sending the proposal to the client.
 *
 * This is the endpoint the PRD's fifth test scenario is about, and the order of
 * operations is the answer to it:
 *
 *   1. Re-validate the intake for delivery. `client_email` is advisory while
 *      drafting and BLOCKING at this point, so a missing address becomes a real
 *      gap here rather than a silent failure later.
 *   2. Re-count blocking gaps. Approval already checked, but a gap can be
 *      reopened afterwards, and this is the last moment before a client sees
 *      anything.
 *   3. `assertCanSend`. Refuses anything not `approved` (or a retry of a failed
 *      delivery). A proposal in `review` cannot be sent however the request is
 *      shaped.
 *   4. Only then is a share link issued and the email dispatched.
 *
 * The state change to `sent` happens AFTER delivery succeeds, not before. A
 * proposal marked sent that never left the building is worse than one marked
 * approved that did — the first is a lie the salesperson acts on.
 */
export const POST = route<Params>(
  { action: "proposal.send", roles: ["salesperson", "approver"] },
  async ({ params, request, user, correlationId }) => {
    const parsed = body.parse(await readJson(request));
    const proposal = await getProposalOrThrow(params.id);
    assertAccess(proposal, user, "send");

    // 1. Delivery-time validation.
    const deliveryGaps = validateIntake(proposal.intake, { forDelivery: true });
    await syncGaps({
      proposalId: proposal.id,
      detectedBy: "validator",
      candidates: deliveryGaps,
    });

    const recipient = (parsed.recipient ?? proposal.intake.client_email).trim();

    // 2 and 3.
    // The gaps, not just the count, so a refusal can name what is missing.
    const blocking = await openBlockingGaps(proposal.id);
    assertCanSend({
      status: proposal.status,
      actorRole: user.role as Role,
      openBlockingGaps: blocking.length,
      blockingGapSummaries: blocking,
      hasValidRecipient: isValidEmail(recipient),
    });

    const sections = await getSections(proposal.id);
    if (sections.every((s) => s.body_md.trim().length === 0)) {
      throw errors.validation("There is nothing written to send.");
    }

    // 4. Issue the link. Rotation is used when the existing token cannot be
    // recovered — the raw value is deliberately unrecoverable, so a send that
    // needs a URL gets a fresh one and the old one is revoked.
    const existing = await ensureShareLink(proposal.id);
    const token = existing.token ?? (await rotateShareLink(proposal.id)).token;

    // The origin is NOT taken from the request host unless that host is one
    // this deployment is configured to answer to. See lib/url.ts: this link is
    // emailed to a client, so a forged Host header here is a phishing link
    // sent by us, carrying a real token.
    const origin = resolveOrigin((await headers()).get("host"));
    const proposalLink = shareUrl(origin.origin, token);

    if (origin.source === "fallback") {
      /**
       * The send is REFUSED, not merely logged.
       *
       * This used to record the event and carry on, which meant a client
       * received an email whose only call to action was a link to localhost.
       * An email nobody can act on is worse than no email: the salesperson
       * believes the proposal is with the client, the client sees a dead
       * link, and the delivery row says `sent`. Every part of the system then
       * disagrees with reality, and the idempotency key makes the obvious fix
       * (press send again) a no-op.
       *
       * The condition is always a missing `APP_BASE_URL` on a deployment
       * reached at a host nobody allow-listed, so the message names the
       * variable. It is a configuration error, not something the salesperson
       * did, and it is fixed in one place by somebody who can reach the
       * deployment settings.
       */
      await recordEvent({
        correlationId,
        action: "proposal.send.origin_unresolved",
        outcome: "error",
        actorId: user.id,
        proposalId: proposal.id,
        errorCode: "VALIDATION_FAILED",
        detail: { rejectedHost: origin.rejectedHost, note: "set APP_BASE_URL" },
      });

      throw errors.validation(
        `This deployment does not know its own address, so the client link would point at localhost and would not open. Nothing was sent. Set APP_BASE_URL to the public origin${
          origin.rejectedHost ? ` (this request arrived at ${origin.rejectedHost})` : ""
        } and try again.`,
      );
    }

    const drafted = renderClientEmail({
      intake: proposal.intake,
      proposalLink,
      opener: await readEmailOpener(proposal.id, proposal.intake),
    });
    const subject = parsed.subject ?? drafted.subject;
    /**
     * The link goes in here, on the server, after it exists.
     *
     * The body arrives from the browser, where it was drafted before any
     * link had been minted. Sending it verbatim, which is what happened
     * before, put the draft's stand-in text in front of the client instead
     * of a URL they could open. Substituting here means it does not matter
     * what the page displayed or how the salesperson edited around it: the
     * body that leaves carries the link that was actually issued.
     */
    const bodyText = applyProposalLink(parsed.bodyText ?? drafted.bodyText, proposalLink);

    const model = buildDocumentModel({
      ref: proposal.ref,
      intake: proposal.intake,
      sections: sections.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
      forClient: true,
    });

    // If the PDF cannot be built, the email still goes with the link. A missing
    // attachment is a degradation; a blocked send is an outage.
    let pdf: Uint8Array | null = null;
    try {
      pdf = await buildProposalPdf(model);
    } catch (err) {
      await recordEvent({
        correlationId,
        action: "proposal.send.pdf_failed",
        outcome: "error",
        actorId: user.id,
        proposalId: proposal.id,
        errorCode: "DOCGEN_FAILED",
        detail: { message: err instanceof Error ? err.message : String(err) },
      });
    }

    /**
     * The approver is copied on the client email.
     *
     * Whoever actually signed it off, from `approver_id`, not whoever was
     * assigned: the point of the copy is that the person who put their name
     * to it sees what went out. Falls back to the assigned approver only when
     * the proposal reached `sent` without an approval recorded, which should
     * not happen and is cheap to survive.
     *
     * Silently empty when the address cannot be resolved. A send must not
     * fail because a colleague's copy could not be addressed - the client is
     * the point, and the audit trail already records the approval.
     */
    const cc = await approverCopyList(proposal.approver_id ?? proposal.assigned_approver_id);

    const outcome = await deliverProposal({
      proposalId: proposal.id,
      correlationId,
      recipient,
      cc,
      subject,
      bodyText,
      proposalLink,
      ref: proposal.ref,
      pdf,
    });

    // The state change follows the delivery, and only on success.
    if (outcome.status === "sent") {
      const fresh = await getProposalOrThrow(proposal.id);
      if (fresh.status !== "sent") {
        await transitionStatus({
          proposalId: proposal.id,
          from: fresh.status,
          to: "sent",
          expectedVersion: fresh.version,
        });
      }
    } else {
      const fresh = await getProposalOrThrow(proposal.id);
      if (fresh.status === "approved") {
        await transitionStatus({
          proposalId: proposal.id,
          from: "approved",
          to: "delivery_failed",
          expectedVersion: fresh.version,
        });
      }
    }

    return {
      proposalId: proposal.id,
      delivery: {
        id: outcome.deliveryId,
        status: outcome.status,
        channel: outcome.channel,
        message: outcome.message,
        needsManualSend: outcome.needsManualSend,
        attempts: outcome.attempts,
      },
      proposalLink,
      status: outcome.status === "sent" ? "sent" : "delivery_failed",
    };
  },
);

/**
 * The email as a downloadable .eml.
 *
 * The honest fallback. When no provider is configured, or both lanes failed,
 * the salesperson gets a file that opens pre-addressed and pre-written in any
 * mail client. The alternative — a success message for something that never
 * left the building — is the failure this whole design is arranged against.
 */
export const GET = route<Params>({ action: "proposal.send.preview" }, async ({ params, user }) => {
  const proposal = await getProposalOrThrow(params.id);
  assertAccess(proposal, user, "send");

  /**
   * A PREVIEW MINTS NOTHING.
   *
   * This handler used to call `ensureShareLink`, which creates a live,
   * client-openable token as a side effect of looking at the draft email. The
   * deliver page then displayed that URL. So a salesperson could open the
   * preview while the proposal was still in `review`, copy the link out of the
   * page, and hand a client the document — with the approval step, the entire
   * point of the system, walked straight past. Not maliciously; the URL was on
   * screen and looked like the thing to send.
   *
   * A read-only endpoint that quietly creates a credential is the bug. The
   * preview now describes the link it WILL issue, and the token comes into
   * existence in the POST handler, after `assertCanSend` has agreed.
   */
  const origin = resolveOrigin((await headers()).get("host"));
  const links = await getShareLinks(proposal.id);
  const live = links.find((l) => !l.revoked_at && (!l.expires_at || l.expires_at > new Date()));
  const proposalLink = LINK_PLACEHOLDER;

  const drafted = renderClientEmail({
    intake: proposal.intake,
    proposalLink,
    opener: await readEmailOpener(proposal.id, proposal.intake),
  });

  return {
    proposalId: proposal.id,
    recipient: proposal.intake.client_email,
    subject: drafted.subject,
    bodyText: drafted.bodyText,
    proposalLink,
    // The preview never holds a usable token, so it never claims to. The flag
    // says only whether a link already exists for this proposal.
    linkIsFinal: false,
    linkAlreadyIssued: Boolean(live),
  };
});

/**
 * The approver's email address, as a cc list.
 *
 * Returns an empty list rather than throwing for every reason it might fail:
 * no approver recorded, the account deactivated, the row gone. None of those
 * is a reason to stop a client receiving an approved proposal.
 */
async function approverCopyList(approverId: string | null): Promise<string[]> {
  if (!approverId) return [];
  try {
    const row = await queryOne<{ email: string }>(
      "SELECT email FROM users WHERE id = $1 AND is_active",
      [approverId],
    );
    return row?.email ? [row.email] : [];
  } catch {
    return [];
  }
}
