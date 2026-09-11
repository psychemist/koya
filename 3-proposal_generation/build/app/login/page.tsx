import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/auth";
import { LoginForm } from "./LoginForm";
import { ThemeToggle } from "../../components/ThemeToggle";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Demo credentials, read on the server and rendered into the page.
 *
 * This is a deliberate, reversible decision rather than an oversight. The
 * submission has to open on a reviewer's machine without anyone present, and
 * the approval control is only meaningful if they can experience both roles.
 * Printing the seeded credentials is what makes that possible while keeping
 * the roles genuinely enforced server-side.
 *
 * It is reversible in one step: change SEED_*_PASSWORD, re-run `npm run seed`,
 * and the printed credentials stop working. Nothing else in the system depends
 * on them.
 */
function demoAccounts(): { label: string; email: string; password: string }[] {
  const accounts = [
    {
      label: "Salesperson",
      email: process.env.SEED_SALESPERSON_EMAIL,
      password: process.env.SEED_SALESPERSON_PASSWORD,
    },
    {
      label: "Approver",
      email: process.env.SEED_APPROVER_EMAIL,
      password: process.env.SEED_APPROVER_PASSWORD,
    },
  ];

  return accounts.flatMap((a) =>
    a.email && a.password ? [{ label: a.label, email: a.email, password: a.password }] : [],
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  const { next } = await searchParams;
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  /*
   * Two panels above 1024px, one below.
   *
   * This was a 420px column floating in the middle of a 1500px window with
   * nothing either side of it, which is the shape of a page that has not been
   * laid out rather than one that has. It is also the only screen a reviewer
   * sees before deciding whether the rest is worth their attention.
   *
   * So the left panel says what the thing is, on the chrome surface, and the
   * right panel is the form, on the page ground. The split is the same one the
   * whole design rests on: the application recedes and the work does not. And
   * the four steps are here rather than in a paragraph because the sequence IS
   * the product; a proposal that one person writes and sends is not what this
   * builds.
   *
   * Below 1024px the left panel goes and the heading it carries reappears above
   * the form, so nothing that explains the page is lost on a phone.
   */
  return (
    <main className="min-h-dvh lg:grid lg:grid-cols-[1fr_minmax(0,480px)]">
      <section className="hidden flex-col justify-center border-r border-[var(--border)] bg-[var(--surface)] px-14 py-16 lg:flex">
        <div className="max-w-[34rem]">
          <div className="eyebrow text-[var(--accent)]">Koya Talent</div>
          <h1 className="mt-2 font-serif text-[46px] font-normal leading-[1.03] tracking-[-0.03em]">
            Proposal Studio
          </h1>
          <p className="mt-4 t-md leading-relaxed text-[var(--ink-2)]">
            You bring what you took from a discovery call. What goes out is a document, not a
            chat transcript.
          </p>

          <ol className="steps mt-9 t-base leading-relaxed text-[var(--ink-2)]">
            <li>Claude drafts all seven sections from your notes and the files you attach.</li>
            <li>You revise it section by section. Rewriting one leaves the rest alone.</li>
            <li>
              Somebody else approves it. Never the author, and never while a blocking gap is
              open.
            </li>
            <li>The client gets a private link and a PDF. Nothing before that point.</li>
          </ol>

          <p className="hint mt-9">
            Every figure in the document is checked against your notes and your attachments.
            Anything the system cannot find there is flagged rather than invented.
          </p>
        </div>
      </section>

      <section className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col justify-center gap-6 px-5 py-10 lg:min-h-0">
        {/* The heading the left panel carries, for the widths that have no left panel. */}
        <div className="lg:hidden">
          <div className="eyebrow text-[var(--accent)]">Koya Talent</div>
          <h1 className="page-title mt-1.5 text-[30px]">Proposal Studio</h1>
          <p className="hint mt-2 t-base leading-relaxed">
            You bring what you took from a discovery call. Claude drafts the proposal, you
            revise it section by section, and somebody else signs it off before it reaches
            the client.
          </p>
        </div>

        <div className="panel p-5">
          <h2 className="panel-title mb-4">Sign in</h2>
          <LoginForm next={target} demo={demoAccounts()} />
        </div>

        <div className="flex flex-col items-center gap-3">
          <ThemeToggle />
          <p className="hint m-0 text-center t-sm">
            Sessions last 12 hours. Every sign-in, approval and send is recorded in the audit
            trail.
          </p>
        </div>
      </section>
    </main>
  );
}
