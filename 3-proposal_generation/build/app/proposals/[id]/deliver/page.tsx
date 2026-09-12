import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "../../../../lib/auth";
import { config } from "../../../../lib/config";
import { getProposalOrThrow } from "../../../../lib/proposal/repo";
import { assertAccess } from "../../../../lib/proposal/access";
import { ensureShareLink } from "../../../../lib/proposal/share";
import {
  firstNameOf,
  LINK_PLACEHOLDER,
  renderClientEmail,
} from "../../../../lib/delivery/message";
import { readEmailOpener } from "../../../../lib/delivery/opener";
import { getDeliveries, lastComposedMessage, type LaneAttempt } from "../../../../lib/delivery/send";
import { draftIsStale } from "../../../../lib/proposal/service";
import { openBlockingGaps } from "../../../../lib/proposal/repo";
import { queryOne } from "../../../../lib/db";
import { AppShell, PageHeader } from "../../../../components/AppShell";
import { Caret, InfoNote, StatusBadge, TimeAgo } from "../../../../components/ui";
import { DeliverPanel } from "./DeliverPanel";
import { resolveOrigin, shareUrl } from "../../../../lib/url";

export const metadata: Metadata = { title: "Deliver" };
export const dynamic = "force-dynamic";

export default async function DeliverPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  let proposal;
  try {
    proposal = await getProposalOrThrow(id);
    assertAccess(proposal, user, "send");
  } catch {
    notFound();
  }

  // Delivery is only reachable once approved. Rather than 404, the page
  // explains why — a salesperson who followed a stale link needs to know it is
  // the approval that is missing, not the page.
  const deliverable =
    proposal.status === "approved" ||
    proposal.status === "delivery_failed" ||
    proposal.status === "sent";

  /**
   * A token is minted here only once the proposal is actually deliverable.
   *
   * Previously this page called `ensureShareLink` on every render, so merely
   * opening the deliver screen for a proposal still in review created a live,
   * client-openable URL and printed it on the page. The approval gate is only
   * as strong as the number of ways to obtain a working link without passing
   * it, and this was one.
   */
  const origin = resolveOrigin((await headers()).get("host"));
  const share = deliverable ? await ensureShareLink(proposal.id) : null;
  const proposalLink = share?.token
    ? shareUrl(origin.origin, share.token)
    : LINK_PLACEHOLDER;

  // Reads the sentence generated at approval; never generates one, because
  // this is a GET and a GET must not spend money.
  const opener = await readEmailOpener(proposal.id, proposal.intake);
  /**
   * The DRAFT body always carries the placeholder, never a real URL.
   *
   * It used to carry whichever link `ensureShareLink` had just minted, and
   * that link was dead by the time the client read it. The raw token is
   * unrecoverable by design - only the hash is stored - so `ensureShareLink`
   * cannot hand back an existing one, and the send path therefore calls
   * `rotateShareLink`, which mints a fresh token AND REVOKES the previous
   * one. The previous one being, precisely, the link already sitting in the
   * body the browser posted back.
   *
   * `applyProposalLink` then could not find its own link in the text, so it
   * appended it at the bottom. The client received two URLs: a dead one where
   * the sentence points at it, and a live one stranded under the signature.
   *
   * Substituting server-side at send is what the placeholder exists for, and
   * it is the only point at which the link that will actually be live is
   * known. `proposalLink` below is still used to show the reader what the URL
   * will look like, and to fold a restored note's baked-in link back.
   */
  const drafted = renderClientEmail({
    intake: proposal.intake,
    proposalLink: LINK_PLACEHOLDER,
    opener,
  });
  /**
   * The approver who signed this off, for the copy line.
   *
   * Resolved here so the confirmation dialog can name them before the send
   * rather than after. Null when nobody has approved yet, when the account is
   * deactivated, or when the lookup fails - none of which is worth failing a
   * page render over.
   */
  const approverEmail = await approverAddress(
    proposal.approver_id ?? proposal.assigned_approver_id,
  );

  const [deliveries, composed, staleDraft, blockingGaps] = await Promise.all([
    getDeliveries(proposal.id),
    lastComposedMessage(proposal.id),
    draftIsStale(proposal.id),
    openBlockingGaps(proposal.id),
  ]);

  /**
   * What the editor opens with.
   *
   * The template was rendered fresh on every visit, which meant editing the
   * note, sending, and coming back to send again handed you the pristine
   * template and your words were gone. That matters more now that a second
   * send with a changed note is a supported thing to do rather than a refused
   * one: the feature existed and the page quietly undid the work it needed.
   *
   * The previously sent note wins when there is one. The link inside it is
   * swapped back out for the placeholder first — the stored copy has a real
   * URL baked in from the send that used it, and a re-send mints its own. See
   * `applyProposalLink` on the send path, which puts the current link in
   * wherever the placeholder ends up.
   */
  const reusable = composed !== null && stillAddressesTheSameClient(composed, proposal.intake);

  const restored = reusable
    ? {
        subject: composed!.subject,
        bodyText: restorePlaceholder(composed!.bodyText, proposalLink),
      }
    : null;

  /**
   * A note that was written before the client details changed is discarded.
   *
   * This is the case that was reported: approve, recall, correct the client's
   * email address or name, re-approve, and the deliver page still offered the
   * note composed against the old details. Bringing the last note back is
   * right when it is still the same letter to the same person; it is exactly
   * wrong when the reason for the recall was that those details were wrong.
   *
   * Detected rather than recorded, because the alternative was stamping an
   * intake hash on every delivery row and the check below answers the real
   * question directly: does this note still greet the right person at the
   * right company. A salesperson who rewrote the greeting themselves loses
   * the restore and gets the template, which is the safe direction to fail.
   */
  const restoreWasDropped = composed !== null && !reusable;

  return (
    <AppShell user={user}>
      <PageHeader
        title={`Deliver ${proposal.ref}`}
        back={{ href: `/proposals/${proposal.id}`, label: "Workspace" }}
        description={`${proposal.intake.company_name} · ${proposal.intake.client_name}`}
        actions={<StatusBadge status={proposal.status} />}
      />

      {!deliverable ? (
        <div className="panel p-5">
          <h2 className="panel-title">Not approved yet</h2>
          <p className="hint mt-1.5 max-w-[60ch]">
            This proposal is {proposal.status.replace(/_/g, " ")}. Nothing reaches a client
            before internal approval, and that is the send endpoint refusing it rather than
            this page hiding a button. Submit it from the workspace and an approver who did
            not write it can sign it off.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="panel p-5">
            {/*
              The deployment does not know its own address.

              Said here, before the send button, because the send now refuses
              in this state and a refusal a person could have seen coming is a
              better experience than one that arrives after they commit. It is
              also the one error on this page that a salesperson cannot fix,
              so it is worded for whoever can.
            */}
            {origin.source === "fallback" ? (
              <div className="mb-4">
                <InfoNote tone="attention">
                  <strong>This deployment does not know its own public address.</strong> The
                  client link below would point at <code>localhost</code> and would not open,
                  so sending is refused until that is fixed. Set <code>APP_BASE_URL</code> to
                  the public origin in the deployment&rsquo;s environment.
                  {origin.rejectedHost ? (
                    <>
                      {" "}
                      This request arrived at <code>{origin.rejectedHost}</code>, which is not
                      allow-listed; adding it to <code>APP_ALLOWED_HOSTS</code> also works.
                    </>
                  ) : null}
                </InfoNote>
              </div>
            ) : null}
            {/*
              The document and the intake have diverged.

              Reported here because this is the last moment before a client
              reads it, and because the attached PDF is rendered from the
              sections rather than from the intake - so a corrected company
              name shows up in the covering email and NOT in the document
              underneath it, which is the confusing half.
            */}
            {/*
              Something it needs is missing, said before the send button.

              An approved proposal can acquire a blocking gap afterwards: a
              field emptied in the workspace reopens one. The send refuses in
              that state, and this page does not show the gap panel, so the
              refusal used to arrive with no way to find out which gap. The
              list is here now, with the workspace one click away.
            */}
            {blockingGaps.length > 0 ? (
              <div className="mb-4">
                <InfoNote tone="attention">
                  <strong>
                    This cannot be sent yet: {blockingGaps.length} thing
                    {blockingGaps.length === 1 ? "" : "s"} it needs {blockingGaps.length === 1 ? "is" : "are"} missing.
                  </strong>
                  <ul className="mt-1.5 mb-0 list-disc pl-5">
                    {blockingGaps.map((g, i) => (
                      <li key={`${g.field ?? "gap"}-${i}`}>{g.message}</li>
                    ))}
                  </ul>
                  <div className="mt-1.5">
                    <Link href={`/proposals/${proposal.id}`}>Fix it in the workspace</Link>, then
                    have the proposal approved again.
                  </div>
                </InfoNote>
              </div>
            ) : null}

            {staleDraft ? (
              <div className="mb-4">
                <InfoNote tone="attention">
                  <strong>The client details have changed since this was drafted.</strong> The
                  covering email below uses the current details, but the proposal document
                  itself was written from the earlier ones and still carries them.{" "}
                  <Link href={`/proposals/${proposal.id}`}>Open the workspace</Link> to
                  regenerate the affected sections, or send as it stands if the difference
                  does not appear in the prose.
                </InfoNote>
              </div>
            ) : null}
            <h2 className="panel-title mb-3">Covering email</h2>
            <DeliverPanel
              proposalId={proposal.id}
              recipient={proposal.intake.client_email}
              subject={restored?.subject ?? drafted.subject}
              bodyText={restored?.bodyText ?? drafted.bodyText}
              restoredFromLastSend={Boolean(restored)}
              approverEmail={approverEmail}
              lastNoteWasStale={restoreWasDropped}
              proposalLink={proposalLink}
              linkIsFinal={Boolean(share?.token)}
              alreadySent={proposal.status === "sent"}
              lanes={config.deliveryLanes}
            />
          </div>

          <aside className="flex flex-col gap-4">
            <div className="panel p-4">
              <h2 className="panel-title mb-2">Delivery lanes</h2>
              <ul className="flex flex-col gap-2 t-sm">
                <li className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className={`mt-[3px] t-2xs ${config.deliveryLanes.n8n ? "text-[var(--good)]" : "text-[var(--muted)]"}`}
                  >
                    {config.deliveryLanes.n8n ? "●" : "○"}
                  </span>
                  <div>
                    <div className="font-semibold">Lane A: n8n workflow</div>
                    <div className="text-[var(--muted)]">
                      {config.deliveryLanes.n8n
                        ? "Signed webhook. Sends via Gmail and notifies Discord."
                        : "Not configured. Skipped without failing."}
                    </div>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className={`mt-[3px] t-2xs ${config.deliveryLanes.resend ? "text-[var(--good)]" : "text-[var(--muted)]"}`}
                  >
                    {config.deliveryLanes.resend ? "●" : "○"}
                  </span>
                  <div>
                    <div className="font-semibold">Lane B: Resend</div>
                    <div className="text-[var(--muted)]">
                      {config.deliveryLanes.resend
                        ? "Direct send with the PDF attached. Used when lane A does not answer."
                        : "Not configured. Falls through to a downloadable .eml."}
                    </div>
                  </div>
                </li>
              </ul>
              <p className="hint mt-2">
                Both lanes share one idempotency key, so a failover after a partial success
                cannot put a second copy in the client&rsquo;s inbox.
              </p>
            </div>

            {/*
              THE ATTEMPT LOG IS A SUMMARY HERE, NOT AN ARCHIVE.
              
              Every attempt used to render as a full card with its error
              string printed in full, unwrapped. A proposal that failed a
              few times produced a column taller than the form it sits
              beside, and a single provider error can be several hundred
              characters, so the page grew without bound in the one place
              somebody is trying to concentrate on an email.
              
              What matters here is whether the last attempt worked. Three
              rows answer that; the rest fold away, and the full text of a
              failure lives on the system page, which is the screen for
              reading failures.
            */}
            {deliveries.length > 0 ? (
              <div className="panel p-4">
                <div className="mb-2 flex items-baseline gap-2">
                  <h2 className="panel-title">Attempts</h2>
                  <span className="ml-auto t-xs text-[var(--muted)]">
                    {deliveries.length} total
                  </span>
                </div>

                <ul className="flex flex-col gap-1.5 t-sm">
                  {deliveries.slice(0, 3).map((d) => (
                    <AttemptRow key={d.id} delivery={d} />
                  ))}
                </ul>

                {deliveries.length > 3 ? (
                  <details className="mt-2">
                    <summary className="disclosure t-sm text-[var(--ink-2)]">
                      <span>{deliveries.length - 3} earlier</span>
                      <Caret />
                    </summary>
                    <ul className="mt-1.5 flex flex-col gap-1.5 t-sm">
                      {deliveries.slice(3).map((d) => (
                        <AttemptRow key={d.id} delivery={d} />
                      ))}
                    </ul>
                  </details>
                ) : null}

                {deliveries.some((d) => d.error_detail) ? (
                  <p className="hint mt-2 mb-0">
                    Full failure text, with its correlation id, is on the{" "}
                    <Link href="/system">system page</Link>.
                  </p>
                ) : null}
              </div>
            ) : null}

            <InfoNote>
              The client-facing page needs no sign-in, strips every internal marker, and prints
              to a clean PDF from the browser.
            </InfoNote>
          </aside>
        </div>
      )}
    </AppShell>
  );
}

/** How each lane is named to a reader, rather than in the database. */
const LANE_LABEL: Record<string, string> = {
  n8n: "n8n",
  resend: "Resend",
  manual_eml: "manual .eml",
};

/**
 * One delivery attempt: a header line, then one line per lane tried.
 *
 * The reason used to be a single clamped blob, because that is how it is
 * stored: `error_detail` is every lane's message joined with a pipe, so a
 * send that failed twice produced one run-on string and the clamp cut it
 * mid-sentence, usually just as the second lane started explaining itself.
 * A reader could see that something failed and not which half.
 *
 * `lane_attempts` has the same information already separated, one row per
 * lane with its own outcome and latency, so there is no reason to render
 * the joined version. Each lane gets a line, truncated at the end of that
 * line rather than at an arbitrary character count, with the full text on
 * hover and in full on the system page.
 */
function AttemptRow({
  delivery,
}: {
  delivery: {
    id: string;
    status: string;
    channel: string;
    recipient: string;
    error_detail: string | null;
    lane_attempts: LaneAttempt[];
    created_at: Date;
  };
}) {
  const lanes = delivery.lane_attempts ?? [];

  return (
    <li className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className="t-2xs">
          {delivery.status === "sent" ? "●" : delivery.status === "blocked" ? "○" : "■"}
        </span>
        <span className="font-semibold uppercase tracking-wide">{delivery.status}</span>
        <span className="text-[var(--muted)]">via {delivery.channel}</span>
        <span className="ml-auto shrink-0 text-[var(--muted)]">
          <TimeAgo at={delivery.created_at} />
        </span>
      </div>
      <div className="truncate t-xs text-[var(--muted)]" title={delivery.recipient}>
        {delivery.recipient}
      </div>

      {lanes.length > 0 ? (
        <ul className="mt-1 flex list-none flex-col gap-0.5 p-0">
          {lanes.map((lane, i) => (
            <li
              key={`${lane.lane}-${i}`}
              className="flex items-baseline gap-1.5 t-2xs leading-snug"
              title={`${LANE_LABEL[lane.lane] ?? lane.lane}: ${lane.detail}`}
            >
              {/*
                Red on the cross, and nowhere else on the line.
                
                It was muted, which was over-correcting: the earlier version
                of the failure list put red on the border, the background
                and the whole message, and when everything is red nothing
                is. One glyph is the opposite problem solved. It marks which
                lane failed at a glance while the message beside it stays
                ordinary text.
              */}
              <span
                aria-hidden="true"
                className={lane.ok ? "text-[var(--good)]" : "text-[var(--bad)]"}
              >
                {lane.ok ? "✓" : "✗"}
              </span>
              <span className="shrink-0 font-semibold text-[var(--ink-2)]">
                {LANE_LABEL[lane.lane] ?? lane.lane}
              </span>
              <span className="mono truncate text-[var(--muted)]">{lane.detail}</span>
            </li>
          ))}
        </ul>
      ) : delivery.error_detail ? (
        // Older rows, written before lane attempts were recorded.
        <p
          className="mono m-0 mt-1 truncate t-2xs text-[var(--muted)]"
          title={delivery.error_detail}
        >
          {delivery.error_detail}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Puts the placeholder back where a live link was.
 *
 * A stored note carries the exact URL that went out with it. Showing that URL
 * again would be wrong in two ways: a re-send may mint a fresh token, and the
 * previous one may since have been revoked, so the text a salesperson is
 * editing would contain a link that no longer resolves.
 *
 * Both the link as it stands now and any link-shaped string from an earlier
 * send are folded back to the placeholder, because the token in an older row
 * is not the one `proposalLink` currently holds.
 */
function restorePlaceholder(bodyText: string, proposalLink: string): string {
  const withCurrent = bodyText.split(proposalLink).join(LINK_PLACEHOLDER);
  // Any /p/<token> URL from an earlier send, whatever its host.
  return withCurrent.replace(/https?:\/\/[^\s<>"']+\/p\/[A-Za-z0-9_-]+/g, LINK_PLACEHOLDER);
}

/**
 * Whether a previously composed note still fits the current intake.
 *
 * Checks the three substitutions the template makes: the greeting, the
 * subject, and the sign-off. If the client has been renamed, the company
 * corrected or the salesperson changed, the stored note is addressed to
 * somebody who is no longer the recipient and must not be offered back.
 */
function stillAddressesTheSameClient(
  composed: { subject: string; bodyText: string },
  intake: { client_name: string; company_name: string; salesperson_name: string },
): boolean {
  const greeting = firstNameOf(intake.client_name);
  if (greeting && !composed.bodyText.includes(greeting)) return false;
  if (intake.company_name && !composed.subject.includes(intake.company_name)) return false;
  if (intake.salesperson_name && !composed.bodyText.includes(intake.salesperson_name)) return false;
  return true;
}

/** The approver's address, or null for every reason it might not resolve. */
async function approverAddress(approverId: string | null): Promise<string | null> {
  if (!approverId) return null;
  try {
    const row = await queryOne<{ email: string }>(
      "SELECT email FROM users WHERE id = $1 AND is_active",
      [approverId],
    );
    return row?.email ?? null;
  } catch {
    return null;
  }
}
