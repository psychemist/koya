import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/auth";
import { formatUsd } from "../../../lib/claude/models";
import { describeExtraction } from "../../../lib/extract";
import { getApprovals, getComments, getGaps } from "../../../lib/proposal/repo";
import { citationTargets, loadWorkspace } from "../../../lib/proposal/service";
import { canAccess } from "../../../lib/proposal/access";
import { AppShell } from "../../../components/AppShell";
import { listAssignableApprovers } from "../../../lib/proposal/repo";
import { Workspace } from "../../../components/workspace/Workspace";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return { title: "Proposal" };
  try {
    const { proposal } = await loadWorkspace(id, user);
    return { title: `${proposal.ref} · ${proposal.intake.company_name}` };
  } catch {
    // Includes the access refusal: a title is a disclosure too, and a proposal
    // this viewer may not open must not name its client in the browser tab.
    return { title: "Proposal" };
  }
}

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;

  // A malformed id must 404 rather than reach Postgres and produce an invalid
  // uuid error, which would surface as a 500 for what is really a bad URL.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  /**
   * One round trip, not two.
   *
   * This used to await `loadWorkspace` and only then fetch the gaps,
   * approvals and comments, which made six queries into two sequential
   * waits. Nothing in the second group needs anything from the first: they
   * are all keyed by the proposal id, which came in on the URL. Against a
   * database roughly 230ms away that second wait was a fifth of a second of
   * pure latency on every page load, for no reason.
   *
   * `loadWorkspace` still does the access check, and it runs before any of
   * this data is rendered. Fetching a row and then discarding it because
   * the reader may not see it costs a query; it does not disclose anything.
   */
  let data;
  let gaps;
  let approvals;
  let comments;
  let approvers;
  try {
    [data, gaps, approvals, comments, approvers] = await Promise.all([
      loadWorkspace(id, user),
      getGaps(id),
      getApprovals(id),
      getComments(id),
      listAssignableApprovers(),
    ]);
  } catch {
    notFound();
  }

  const { proposal, sections, sources } = data;

  /**
   * Which attachment each `[[source:N]]` marker points at. Resolved here
   * rather than in the browser: the numbering skips uploads the model never
   * saw, and a client-side recount would attribute a figure to the wrong
   * document the first time an extraction failed.
   */
  const citations = new Map(citationTargets(sources).map((c) => [c.id, c.index]));

  const isAuthor = proposal.author_id === user.id;
  // The approver's own view of whether they may act. The server enforces this
  // again on the action itself, including the rule that an author may never
  // approve their own proposal whatever role they hold.
  const canApprove =
    (user.role === "approver" || user.role === "admin") && proposal.author_id !== user.id;

  /**
   * Whether THIS viewer may edit the document, from the same function the
   * server enforces with.
   *
   * The workspace used to decide this from the status alone, so an approver
   * opening a colleague's draft was shown Draft with Claude, Submit for
   * approval, the section editors, the intake editor and the attachment
   * control. Every one of those was refused by `assertAccess` the moment it
   * was pressed, which is the boundary working, but the interface had spent
   * the whole time telling them the proposal was theirs to write.
   *
   * `canAccess` rather than `isAuthor`, because an administrator may edit any
   * proposal and hiding the controls from them would be a different lie.
   */
  const canEdit = canAccess(proposal, user, "edit");

  /**
   * Claude spend, for administrators only.
   *
   * A salesperson cannot act on the figure - they do not choose the model,
   * the routing or the budget - so a running cost beside their own work only
   * invites them to draft less, or to feel watched for drafting at all. An
   * approver is judging the document, not the spend. The System page still
   * reports every penny, to the people who set the budget.
   */
  /**
   * Who signed it off, by name.
   *
   * Read from the assignable list rather than joined in SQL: the list is
   * already loaded, it holds every approver and admin, and `approver_id`
   * can only ever point at one of them. A deactivated approver drops out of
   * the list, so the name falls back to nothing rather than to a wrong name.
   */
  const approvedByName =
    approvers.find((a) => a.id === proposal.approver_id)?.name ?? null;

  const costLabel = user.role === "admin" ? formatUsd(Number(proposal.cost_micro_usd)) : null;

  return (
    <AppShell user={user} bleed>
      <Workspace
        proposalId={proposal.id}
        ref_={proposal.ref}
        status={proposal.status}
        version={proposal.version}
        isAuthor={isAuthor}
        canEdit={canEdit}
        canApprove={canApprove}
        costLabel={costLabel}
        approvers={approvers.filter((a) => a.id !== proposal.author_id)}
        assignedApproverId={proposal.assigned_approver_id}
        approvedByName={approvedByName}
        companyName={proposal.intake.company_name}
        clientName={proposal.intake.client_name}
        intake={proposal.intake}
        sections={sections.map((s) => ({
          key: s.key,
          heading: s.heading,
          bodyMd: s.body_md,
          version: s.version,
          editedByHuman: s.edited_by_human,
          updatedAt: s.updated_at.toISOString(),
        }))}
        gaps={gaps.map((g) => ({
          id: g.id,
          sectionKey: g.section_key,
          field: g.field,
          severity: g.severity,
          message: g.message,
          detectedBy: g.detected_by,
          status: g.status,
          waiverReason: g.waiver_reason,
        }))}
        sources={sources.map((s) => ({
          id: s.id,
          filename: s.filename,
          status: s.extract_status,
          summary: describeExtraction(s),
          pageCount: s.page_count,
          citationIndex: citations.get(s.id) ?? null,
        }))}
        comments={comments.map((c) => ({
          id: c.id,
          sectionKey: c.section_key,
          body: c.body,
          authorName: c.author_name,
          resolved: c.resolved_at !== null,
          resolverName: c.resolver_name,
          createdAt: c.created_at.toISOString(),
        }))}
        approvals={approvals.map((a) => ({
          decision: a.decision,
          note: a.note,
          actorName: a.actor_name,
          createdAt: a.created_at.toISOString(),
        }))}
      />
    </AppShell>
  );
}
