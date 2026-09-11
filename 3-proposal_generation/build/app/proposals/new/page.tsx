import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/auth";
import { AppShell, PageHeader } from "../../../components/AppShell";
import { IntakeForm } from "./IntakeForm";

export const metadata: Metadata = { title: "New proposal" };
export const dynamic = "force-dynamic";

export default async function NewProposalPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AppShell user={user}>
      {/*
        Narrower than the shell allows.

        The shell caps pages at 1400px, which is right for the pipeline table
        and wrong for a form: at that width the two-column field grid gave
        each text input around 500px, and a single-line answer like a client
        name in a 500px box is a field that looks unfinished however much you
        type into it. 1180px puts the inputs at a little over 400px, which is
        the width the eye reads a name or a fee in.
      */}
      <div className="mx-auto w-full max-w-[1180px]">
        <PageHeader
          title="New proposal"
          back={{ href: "/", label: "Pipeline" }}
          description="What you took from the call. Only four fields are required. Anything you do not have becomes a tracked gap rather than something the proposal invents."
        />
        <IntakeForm salespersonName={user.name} />
      </div>
    </AppShell>
  );
}
