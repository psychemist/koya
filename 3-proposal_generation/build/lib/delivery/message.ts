import type { Intake } from "../proposal/intake";

/**
 * The client email, adapted from assets/client-email-template.md.
 *
 * Deterministic on purpose. This is a five-line covering note with three
 * substitutions, and asking Opus 5 to write it would cost output tokens on
 * every send to produce text a template already gets right. Spending model
 * budget where it is visible (the proposal) and not where it is not (the
 * envelope) is the whole cost argument in miniature.
 *
 * The salesperson can still edit the subject and body before sending: this
 * is the starting point, not a locked template.
 *
 * WHY THE WORDING DIFFERS FROM THE SUPPLIED TEMPLATE. The brief offers that
 * file as a reference, and the reference is written in exactly the register
 * the house rules exist to prevent. It opens by thanking the reader, it
 * describes the attachment instead of the work ("this document outlines the
 * project scope, timeline, pricing details, and recommended approach"), and
 * it closes on "looking forward to hearing your thoughts". Running the
 * project's own style gate over it raises findings, which is the plainest
 * possible argument: a system that flags a salesperson for writing like this
 * cannot send it under their name. Same structure, same substitutions, same
 * information; a person's voice.
 */

export type EmailDraft = {
  subject: string;
  bodyText: string;
};

/**
 * Stands in for the client link until one exists.
 *
 * The deliver page is shown before a link has been minted, deliberately:
 * creating a live client-openable URL as a side effect of opening a page
 * would be a way around the approval gate. So the draft email has to carry
 * something in the link's place, and what it carried was
 * `https://host/p/… (issued on send)`.
 *
 * That was not a placeholder, it was a broken URL, and it was live text in
 * an editable field that the browser posts back on send. The server took
 * the submitted body verbatim, so a first send would have emailed the
 * client a link they could not click. It looked like a cosmetic string and
 * it was the delivery path failing.
 *
 * A token that cannot be mistaken for a URL fixes both halves: a person
 * reading the draft can see something will be substituted, and the server
 * has an unambiguous thing to substitute.
 */
export const LINK_PLACEHOLDER = "{{proposal_link}}";

/**
 * Puts the real link into a body that was drafted without one.
 *
 * Also the last line of defence for a body that has neither the placeholder
 * nor a link, which is reachable by a salesperson editing the draft and
 * deleting the URL. An email inviting somebody to read a proposal, with no
 * way to read it, is worse than a slightly awkward one, so the link is
 * appended rather than omitted.
 */
export function applyProposalLink(bodyText: string, proposalLink: string): string {
  const replaced = bodyText.split(LINK_PLACEHOLDER).join(proposalLink);
  if (replaced.includes(proposalLink)) return replaced;
  return `${replaced.trimEnd()}\n\n${proposalLink}\n`;
}

/**
 * The default first line, used whenever no generated one is supplied.
 *
 * Kept here rather than only in opener.ts so that `renderClientEmail` has a
 * complete answer on its own and every caller keeps working without knowing
 * the generated line exists.
 */
const TEMPLATED_OPENER = "Here is the proposal, written around what you told us on the call.";

export function renderClientEmail(args: {
  intake: Intake;
  proposalLink: string;
  /**
   * One sentence, generated from the intake, replacing the templated opener.
   *
   * Optional, and the fallback is the line every proposal used before it
   * existed. That is deliberate: the opener is generated at approval time, so
   * a proposal approved before this shipped, or one whose generation failed,
   * has none - and neither case should stop an email going out. See
   * lib/delivery/opener.ts.
   *
   * ONLY the first line varies. Everything below it is identical on every
   * proposal, which is what keeps the style gate able to check it.
   */
  opener?: string | null;
}): EmailDraft {
  const { intake, proposalLink } = args;
  const firstName = firstNameOf(intake.client_name);
  const opener = args.opener?.trim() || TEMPLATED_OPENER;

  const subject = `Proposal for ${intake.company_name}`;

  const bodyText = `Hi ${firstName},

${opener}

${proposalLink}

It covers what we would do, in what order, what you get at the end and what it costs. Start with the scope and the pricing. Those are the two people usually want to move, and it is easier to move them now than after an agreement exists.

Reply with your decision. If it looks right we will send the agreement over.

${intake.salesperson_name}
Koya Talent`;

  return { subject, bodyText };
}

/**
 * A first name for the greeting. "Amara Diallo" becomes "Amara"; a single
 * name is used whole; a name with a title keeps the title and surname, since
 * "Hi Dr" would be worse than "Hi Dr Raman".
 */
export function firstNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "there";
  const first = parts[0]!;
  if (/^(dr|prof|professor|mr|mrs|ms|miss|mx|sir|dame)\.?$/i.test(first)) {
    return parts.length > 1 ? `${first.replace(/\.$/, "")} ${parts[parts.length - 1]}` : first;
  }
  return first;
}

/**
 * Builds an RFC 5322 message for download.
 *
 * This is the honest fallback when no email provider is configured: rather
 * than claiming to have sent something, the app hands over a file that opens
 * in any mail client, pre-addressed and pre-written, so the salesperson can
 * send it themselves. The delivery record says `manual_eml` and the audit
 * trail says why.
 */
export function buildEml(args: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  attachment?: { filename: string; mime: string; bytes: Uint8Array } | null;
}): string {
  const boundary = `koya-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const date = new Date().toUTCString();

  const headers = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(args.subject)}`,
    `Date: ${date}`,
    "MIME-Version: 1.0",
  ];

  if (!args.attachment) {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: quoted-printable");
    return `${headers.join("\r\n")}\r\n\r\n${quotedPrintable(args.bodyText)}\r\n`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(args.bodyText),
    "",
    `--${boundary}`,
    `Content-Type: ${args.attachment.mime}; name="${args.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${args.attachment.filename}"`,
    "",
    // Base64 in a MIME part must be wrapped at 76 characters; a single long
    // line is rejected or silently mangled by some mail clients.
    wrap76(Buffer.from(args.attachment.bytes).toString("base64")),
    "",
    `--${boundary}--`,
    "",
  ];

  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

/** RFC 2047 encoding, applied only when the header is not plain ASCII. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Quoted-printable encoding for the body.
 *
 * Needed because proposals contain £, €, en dashes and curly quotes, and a raw
 * 8-bit body is not valid in a 7-bit-safe message — the symptom is a client
 * receiving "Â£48,000".
 */
function quotedPrintable(text: string): string {
  const bytes = Buffer.from(text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"), "utf8");
  let out = "";
  let lineLength = 0;

  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!;

    // Preserve CRLF as a hard line break.
    if (byte === 0x0d && bytes[i + 1] === 0x0a) {
      out += "\r\n";
      lineLength = 0;
      i += 1;
      continue;
    }

    const printable =
      (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d) || byte === 0x20 || byte === 0x09;
    const encoded = printable ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;

    // Soft line break before exceeding 76 characters.
    if (lineLength + encoded.length > 75) {
      out += "=\r\n";
      lineLength = 0;
    }
    out += encoded;
    lineLength += encoded.length;
  }

  return out;
}

function wrap76(value: string): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += 76) lines.push(value.slice(i, i + 76));
  return lines.join("\r\n");
}
