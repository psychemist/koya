import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "../../../../lib/auth";
import { getApprovals, getComments, getGaps } from "../../../../lib/proposal/repo";
import { CommentThread } from "../../../../components/CommentThread";
import { loadWorkspace } from "../../../../lib/proposal/service";
import { buildDocumentModel } from "../../../../lib/docgen/markdown";
import { AppShell, PageHeader } from "../../../../components/AppShell";
import { DocumentBody } from "../../../../components/DocumentBody";
import { InfoNote, StatusBadge, TimeAgo } from "../../../../components/ui";
import { ApprovalPanel } from "./ApprovalPanel";
import { RecallPanel } from "./RecallPanel";

export const metadata: Metadata = { title: "Approve" };
export const dynamic = "force-dynamic";

/**
 * The approval view.
 *
 * Deliberately a different page rather than a mode of the workspace. The
 * approver's job is to read, not to edit, and giving them a read-only document
 * with the decision beside it makes that unambiguous. Sharing the workspace
 * would have put a Regenerate button in front of someone whose only job is to
 * say yes or no.
 *
 * The document is rendered here with gap markers VISIBLE, because the approver
 * is exactly the person who should see what the system could not support.
 */
export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  let data;
  try {
    data = await loadWorkspace(id, user);
  } catch {
    notFound();
  }

  const { proposal, sections } = data;
  const [gaps, approvals, comments] = await Promise.all([
    getGaps(proposal.id),
    getApprovals(proposal.id),
    getComments(proposal.id),
  ]);

  const gapViews = gaps.map((g) => ({
    id: g.id,
    sectionKey: g.section_key,
    field: g.field,
    severity: g.severity,
    message: g.message,
    detectedBy: g.detected_by,
    status: g.status,
    waiverReason: g.waiver_reason,
  }));

  const blockingGaps = gapViews.filter((g) => g.status === "open" && g.severity === "blocking");
  const waivedGaps = gapViews.filter((g) => g.status === "waived");

  const isApprover = user.role === "approver" || user.role === "admin";
  const isAuthor = proposal.author_id === user.id;
  const rightStatus = proposal.status === "pending_approval";

  // The same three conditions the server checks, restated for the person
  // looking at the screen so the disabled button is never a mystery.
  const refusalReason = !isApprover
    ? `Approval needs the approver role. You are signed in as ${user.role}. Sign in as the approver account to complete this step.`
    : isAuthor
      ? "You wrote this proposal, so you cannot approve it. Approval exists to get a second pair of eyes on it."
      : !rightStatus
        ? `This proposal is ${proposal.status.replace(/_/g, " ")}, so there is no decision to make.`
        : null;

  const model = buildDocumentModel({
    ref: proposal.ref,
    intake: proposal.intake,
    sections: sections.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
    // Internal view: markers stay in.
    forClient: false,
  });

  return (
    <AppShell user={user}>
      <PageHeader
        title={`Approve ${proposal.ref}`}
        back={{ href: `/proposals/${proposal.id}`, label: "Workspace" }}
        description={`${proposal.intake.company_name} · ${proposal.intake.client_name}. Read it as the client would, then decide. Approving sends nothing on its own.`}
        actions={<StatusBadge status={proposal.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <article className="paper px-7 py-8 sm:px-10">
          <header className="mb-8 border-b border-[var(--paper-rule)] pb-6">
            <div className="eyebrow text-[var(--accent)]">Koya Talent</div>
            <h2 className="mt-2.5 font-serif text-[30px] font-normal leading-tight tracking-[-0.025em] text-[var(--paper-ink)]">
              Proposal
            </h2>
            <p className="mt-1 font-serif t-lg italic text-[var(--paper-muted)]">
              for {model.companyName}
            </p>
            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 t-sm">
              <dt className="eyebrow">Prepared for</dt>
              <dd className="m-0">{model.clientName}</dd>
              <dt className="eyebrow">Prepared by</dt>
              <dd className="m-0">{model.salespersonName}</dd>
              <dt className="eyebrow">Date</dt>
              <dd className="m-0">{model.dateLabel}</dd>
              <dt className="eyebrow">Reference</dt>
              <dd className="mono m-0">{model.ref}</dd>
            </dl>
          </header>

          {sections
            .filter((s) => s.body_md.trim().length > 0)
            .map((section) => (
              <section key={section.key} className="mb-7 break-avoid">
                <h3 className="mb-2 font-sans t-sm font-bold uppercase tracking-[0.07em] text-[var(--accent)]">
                  {section.heading}
                </h3>
                <div className="prose-doc">
                  <DocumentBody bodyMd={section.body_md} showGaps />
                </div>
              </section>
            ))}
        </article>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-[76px] lg:self-start">
          <div className="panel p-4">
            <h2 className="panel-title mb-2.5">Decision</h2>
            <ApprovalPanel
              proposalId={proposal.id}
              blockingGaps={blockingGaps}
              waivedGaps={waivedGaps}
              canApprove={isApprover && !isAuthor && rightStatus}
              refusalReason={refusalReason}
            />

            {/*
              Undoing an approval, offered where it was given.

              `assertCanWithdraw` has always allowed an approver to recall an
              approved proposal, and the only control for it lived in the
              workspace - so an approver who changed their mind was told here
              that there was "no decision to make" and had to go and find
              somewhere else. Not offered once the proposal is sent: that is a
              record of what a client received, and no permission makes it
              untrue.
            */}
            {proposal.status === "approved" && (isApprover || isAuthor) ? (
              <RecallPanel proposalId={proposal.id} isAuthor={isAuthor} />
            ) : null}

            {/*
              The reviewer's way of asking a question without rendering a
              verdict. Placed under the decision controls on purpose: it is the
              thing to reach for when neither Approve nor Request changes is
              quite what you mean.
            */}
            <CommentThread
              proposalId={proposal.id}
              initial={comments.map((c) => ({
                id: c.id,
                sectionKey: c.section_key,
                body: c.body,
                authorName: c.author_name,
                resolved: c.resolved_at !== null,
                resolverName: c.resolver_name,
                createdAt: c.created_at.toISOString(),
              }))}
            />
          </div>

          <div className="panel p-4">
            <h2 className="panel-title mb-2">What was checked</h2>
            <ul className="flex flex-col gap-1.5 t-sm text-[var(--ink-2)]">
              <li>
                <span aria-hidden="true">
                  {gapViews.some((g) => g.detectedBy === "grounding" && g.status === "open")
                    ? "▲"
                    : "✓"}
                </span>{" "}
                Every figure, date, duration and percentage was compared against the intake and
                the attachments.
              </li>
              <li>
                <span aria-hidden="true">✓</span> Claude was instructed to mark, not guess, and
                its markers appear in amber above.
              </li>
              <li>
                <span aria-hidden="true">
                  {blockingGaps.length === 0 ? "✓" : "▲"}
                </span>{" "}
                {blockingGaps.length} blocking, {gapViews.filter((g) => g.status === "open" && g.severity === "advisory").length}{" "}
                advisory gaps open.
              </li>
            </ul>
            <p className="hint mt-2">
              Amber highlights are internal. They are removed from the PDF, the Word file and
              the client-facing page, and a blocking one stops this proposal reaching a client
              at all.
            </p>
          </div>

          {approvals.length > 0 ? (
            <div className="panel p-4">
              <h2 className="panel-title mb-2">History</h2>
              <ul className="flex flex-col gap-2 t-sm">
                {approvals.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="t-2xs">
                        {a.decision === "approved" ? "●" : "▲"}
                      </span>
                      <span className="font-semibold">
                        {a.decision === "approved" ? "Approved" : "Changes requested"}
                      </span>
                      <span className="ml-auto text-[var(--muted)]">
                        <TimeAgo at={a.created_at} />
                      </span>
                    </div>
                    <div className="mt-0.5 text-[var(--muted)]">{a.actor_name}</div>
                    {a.note ? <p className="m-0 mt-1 text-[var(--ink-2)]">{a.note}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <InfoNote>
            Approving records who approved it and when, then unlocks delivery.{" "}
            <Link href={`/proposals/${proposal.id}`}>Back to the workspace</Link> to see the
            full gap list and section history.
          </InfoNote>
        </aside>
      </div>
    </AppShell>
  );
}
