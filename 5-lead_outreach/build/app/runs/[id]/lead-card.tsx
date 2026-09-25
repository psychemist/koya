'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

type Mark = { status: string | null; setStatus: (next: string | null) => void };

const MarkContext = createContext<Mark>({ status: null, setStatus: () => {} });

/** Read and write the reviewer's own verdict on this lead. */
export const useHumanMark = () => useContext(MarkContext);

/**
 * The card around one lead, and the one piece of it that a click can change.
 *
 * The left edge carries the agent's verdict as fill density. A reviewer who
 * has ruled on the lead outranks that, so their answer takes the edge and
 * takes it in colour: green accepted, red rejected. A lead nobody has ruled on
 * keeps the density its bucket earned.
 *
 * The state lives here rather than in the button that sets it, because the
 * edge, the head and the button are three places that have to agree the
 * instant the answer is saved, without a trip back to the server.
 */
export function LeadShell({ verdict, humanStatus, children }: {
  verdict: string; humanStatus: string | null; children: ReactNode;
}) {
  const [status, setStatus] = useState(humanStatus);
  return (
    <MarkContext.Provider value={{ status, setStatus }}>
      <article className="card lead" data-verdict={verdict} data-human={status ?? undefined}>
        {children}
      </article>
    </MarkContext.Provider>
  );
}

/**
 * The head slot for the reviewer's verdict. The colour on the edge says
 * accepted or rejected; this says which in words, for the reviewer who cannot
 * separate the two and for the printed page.
 */
export function HumanMark() {
  const { status } = useHumanMark();
  return (
    <span className="small lead-mark">
      {status && <b>You marked this {status}</b>}
    </span>
  );
}
