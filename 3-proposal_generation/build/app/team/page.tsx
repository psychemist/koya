import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/auth";
import { listInvites, listMembers } from "../../lib/team";
import { AppShell, PageHeader } from "../../components/AppShell";
import { TeamPanel } from "./TeamPanel";

export const metadata: Metadata = { title: "Team · Koya Proposal Studio" };
export const dynamic = "force-dynamic";

/**
 * Admin only, checked here as well as in middleware.
 *
 * A salesperson who types the URL gets sent to the pipeline rather than a
 * 403: they have not done anything wrong, and an error page for a link that
 * simply is not theirs is noise.
 */
export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/team");
  if (user.role !== "admin") redirect("/");

  const [members, invites] = await Promise.all([listMembers(), listInvites()]);

  return (
    <AppShell user={user}>
      <PageHeader
        title="Team"
        description="Who works on proposals, who may approve one, and which addresses are allowed to create an account."
      />
      <TeamPanel members={members} invites={invites} currentUserId={user.id} />
    </AppShell>
  );
}
