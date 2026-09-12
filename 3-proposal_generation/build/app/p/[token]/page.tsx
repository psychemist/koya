import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  countOpenBlockingGaps,
  getProposalOrThrow,
  getSections,
} from "../../../lib/proposal/repo";
import { resolveShareToken } from "../../../lib/proposal/share";
import { formatCallDate } from "../../../lib/proposal/intake";
import { SECTIONS } from "../../../lib/proposal/sections";
import { stripCitationMarkers, stripGapMarkers } from "../../../lib/proposal/parse";
import { DocumentBody } from "../../../components/DocumentBody";
import { recordEvent } from "../../../lib/audit";
import { newCorrelationId } from "../../../lib/errors";
import { PrintButton } from "./PrintButton";
import { ThemeToggle } from "../../../components/ThemeToggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Proposal",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The client-facing proposal.
 *
 * No sign-in. Authenticated entirely by the token in the URL, which is 32
 * bytes of CSPRNG output stored only as a SHA-256 hash — so the database
 * contains no usable link, and a leaked dump exposes nobody's proposals.
 *
 * Three independent defences stand between an internal marker and a client's
 * eyes:
 *
 *   1. The send endpoint refuses to run while any blocking gap is open.
 *   2. This page refuses to render if one is open anyway.
 *   3. The text is stripped of gap and citation markers before rendering, and
 *      DocumentBody is told not to render markers even if any survived.
 *
 * Any one would probably do. Having all three is the difference between
 * believing it cannot happen and knowing.
 */
export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const correlationId = newCorrelationId();

  const resolved = await resolveShareToken(token);
  if (!resolved) {
    // Unknown, revoked and expired are deliberately indistinguishable. A
    // client sent a cancelled link should ring their contact rather than read
    // inferences off an error page.
    await recordEvent({
      correlationId,
      action: "public.proposal_view",
      outcome: "denied",
      detail: { reason: "unresolvable_token" },
    });
    notFound();
  }

  const proposal = await getProposalOrThrow(resolved.proposalId);
  const sections = await getSections(proposal.id);
  const blocking = await countOpenBlockingGaps(proposal.id);

  if (blocking > 0) {
    // Defence 2. Should be unreachable, since the send path already refuses —
    // which is exactly why reaching it is recorded as an error rather than a
    // denial. It means something upstream is wrong.
    await recordEvent({
      correlationId,
      action: "public.proposal_view",
      outcome: "error",
      proposalId: proposal.id,
      errorCode: "BLOCKING_GAPS_OPEN",
      detail: { blocking, note: "client-facing render refused" },
    });
    notFound();
  }

  await recordEvent({
    correlationId,
    action: "public.proposal_view",
    outcome: "ok",
    proposalId: proposal.id,
    detail: { ref: proposal.ref, views: null },
  });

  const bodyByKey = new Map(sections.map((s) => [s.key, s.body_md]));

  // Defence 3, applied here so the string handed to the renderer is already
  // clean rather than relying on the renderer to hide anything.
  const visible = SECTIONS.map((def) => ({
    def,
    body: stripCitationMarkers(stripGapMarkers(bodyByKey.get(def.key) ?? "")).trim(),
  })).filter((s) => s.body.length > 0);

  const groupCounts = new Map<string, number>();
  for (const s of visible) {
    groupCounts.set(s.def.group, (groupCounts.get(s.def.group) ?? 0) + 1);
  }

  let lastGroup = "";

  return (
    <main className="min-h-screen bg-[var(--page)] py-8 print:bg-white print:py-0">
      <div className="mx-auto w-full max-w-[48rem] px-4 sm:px-6">
        <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="t-sm text-[var(--muted)]">
            Prepared for {proposal.intake.client_name} · {proposal.ref}
          </div>
          <div className="flex items-center gap-2">
            {/* Compact: a client reading a proposal does not need three words
                of theme label competing with the download button. */}
            <ThemeToggle compact />
            {/* `download` as well as the server's attachment header. Either
                alone is enough; both together mean no browser has to infer
                what a link called "Download PDF" is for. */}
            <a
              href={`/api/p/${token}/pdf`}
              download
              className="btn btn-sm no-underline hover:no-underline"
            >
              Download PDF
            </a>
            <PrintButton />
          </div>
        </div>

        <article className="paper px-7 py-9 sm:px-14 sm:py-14 print:px-0 print:py-0">
          <header className="mb-10 border-b border-[var(--paper-rule)] pb-8">
            <div className="eyebrow text-[var(--accent)]">Koya Talent</div>
            <h1 className="mt-4 font-serif text-[40px] font-normal leading-[1.05] tracking-[-0.03em] text-[var(--paper-ink)] sm:text-[46px]">
              Proposal
            </h1>
            <p className="mt-2 font-serif text-[22px] italic text-[var(--paper-muted)]">
              for {proposal.intake.company_name}
            </p>

            <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 t-sm">
              <dt className="eyebrow">Prepared for</dt>
              <dd className="m-0 text-[var(--paper-ink)]">{proposal.intake.client_name}</dd>
              <dt className="eyebrow">Prepared by</dt>
              <dd className="m-0 text-[var(--paper-ink)]">
                {proposal.intake.salesperson_name}
              </dd>
              <dt className="eyebrow">Date</dt>
              <dd className="m-0 text-[var(--paper-ink)]">
                {formatCallDate(proposal.intake.date_of_call)}
              </dd>
              <dt className="eyebrow">Reference</dt>
              <dd className="mono m-0 text-[var(--paper-ink)]">{proposal.ref}</dd>
            </dl>
          </header>

          {visible.map(({ def, body }) => {
            const showGroup = def.group !== lastGroup;
            if (showGroup) lastGroup = def.group;
            const needsSubheading = (groupCounts.get(def.group) ?? 1) > 1;

            return (
              <section key={def.key} className="mb-9 break-avoid">
                {showGroup ? (
                  <h2 className="mb-3 border-b border-[var(--paper-rule)] pb-1.5 font-sans t-xs font-bold uppercase tracking-[0.09em] text-[var(--accent)]">
                    {def.group}
                  </h2>
                ) : null}
                {needsSubheading ? (
                  <h3 className="mb-2 font-sans t-base font-semibold text-[var(--paper-ink)]">
                    {def.heading}
                  </h3>
                ) : null}
                <div className="prose-doc">
                  <DocumentBody bodyMd={body} showGaps={false} />
                </div>
              </section>
            );
          })}

          <footer className="mt-12 border-t border-[var(--paper-rule)] pt-5 text-center t-xs text-[var(--paper-muted)]">
            Koya Talent · {proposal.ref}
          </footer>
        </article>

        <p className="no-print mt-4 text-center t-xs text-[var(--muted)]">
          This link is private. Please do not forward it.
        </p>
      </div>
    </main>
  );
}
