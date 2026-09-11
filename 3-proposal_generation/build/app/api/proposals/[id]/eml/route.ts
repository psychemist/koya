import { headers } from "next/headers";
import { fileResponse, rawRoute } from "../../../../../lib/api";
import { getProposalOrThrow, getSections } from "../../../../../lib/proposal/repo";
import { ensureShareLink } from "../../../../../lib/proposal/share";
import { buildDocumentModel } from "../../../../../lib/docgen/markdown";
import { buildProposalPdf } from "../../../../../lib/docgen/pdf";
import { buildEml, renderClientEmail } from "../../../../../lib/delivery/message";
import { readEmailOpener } from "../../../../../lib/delivery/opener";
import { config } from "../../../../../lib/config";
import { assertAccess } from "../../../../../lib/proposal/access";
import { AppError, ErrorCode } from "../../../../../lib/errors";
import { humanStatus } from "../../../../../lib/proposal/status";
import { resolveOrigin, shareUrl } from "../../../../../lib/url";

type Params = { id: string };

/**
 * The covering email as a downloadable .eml, with the PDF attached.
 *
 * This is the escape hatch that keeps the system honest. When no provider is
 * configured, or when both delivery lanes fail, the app does not report
 * success and it does not leave the salesperson stuck: it hands over a file
 * that opens pre-addressed in any mail client, with the proposal attached and
 * the link already in the body.
 *
 * Building it here rather than storing one at send time means it always
 * matches the current proposal.
 */
export const GET = rawRoute<Params>({ action: "proposal.eml" }, async ({ params, user }) => {
  const proposal = await getProposalOrThrow(params.id);
  assertAccess(proposal, user, "send");
  const sections = await getSections(proposal.id);

  /**
   * The manual fallback is still a delivery, so it obeys the same gate.
   *
   * This endpoint hands back a .eml addressed to the client with the proposal
   * attached — everything a send is, minus the SMTP. It was reachable at any
   * status, which made it a way around the approval step for anyone who knew
   * the URL. It now refuses exactly what the send endpoint refuses.
   */
  if (
    proposal.status !== "approved" &&
    proposal.status !== "delivery_failed" &&
    proposal.status !== "sent"
  ) {
    throw new AppError({
      code: ErrorCode.NOT_APPROVED,
      userMessage: `This proposal is ${humanStatus(proposal.status)}. Nothing reaches a client before internal approval, including a manually sent copy.`,
      detail: { status: proposal.status },
    });
  }

  const origin = resolveOrigin((await headers()).get("host"));
  const share = await ensureShareLink(proposal.id);
  const proposalLink = share.token
    ? shareUrl(origin.origin, share.token)
    : `${origin.origin}/proposals/${proposal.id}`;

  const drafted = renderClientEmail({
    intake: proposal.intake,
    proposalLink,
    opener: await readEmailOpener(proposal.id, proposal.intake),
  });

  const model = buildDocumentModel({
    ref: proposal.ref,
    intake: proposal.intake,
    sections: sections.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
    forClient: true,
  });

  let pdf: Uint8Array | null = null;
  try {
    pdf = await buildProposalPdf(model);
  } catch {
    // A .eml with the link but no attachment is still useful; refusing to
    // produce one because the PDF failed would be the worse outcome.
  }

  const eml = buildEml({
    from: config.resendFrom,
    to: proposal.intake.client_email || "client@example.com",
    subject: drafted.subject,
    bodyText: drafted.bodyText,
    attachment: pdf
      ? { filename: `${proposal.ref}-proposal.pdf`, mime: "application/pdf", bytes: pdf }
      : null,
  });

  return fileResponse({
    bytes: new TextEncoder().encode(eml),
    filename: `${proposal.ref}-client-email.eml`,
    mime: "message/rfc822",
  });
});
