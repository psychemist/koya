'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePersisted } from './ui/use-persisted';
import Confirm, { type ConfirmSpec } from './ui/confirm';

const CHANNELS = [
  { id: 'linkedin', label: 'LinkedIn Post' },
  { id: 'x', label: 'X Post' },
  { id: 'newsletter', label: 'Email Newsletter' },
] as const;

type Draft = {
  idea: string;
  audience: string;
  goal: 'awareness' | 'demand' | 'thought_leadership';
  channels: string[];
  urls: string;
  keyword: string;
  publishToX: boolean;
  xIncludeLink: boolean;
  sourcesOnly: boolean;
  /**
   * Generated once and kept WITH the draft. The idempotency key has to
   * survive the refresh that the draft survives: if the form comes back with
   * the same text but a fresh key, resubmitting creates a second request for
   * the same idea and someone has to work out which one to keep.
   */
  key: string;
  /**
   * The id the current key has already created a request under, if any.
   *
   * Once that row exists, the key is spent: it now identifies THAT idea, not
   * this draft. Editing idea/audience/etc after this is set describes a
   * different request, and resubmitting with the same key would make the
   * server replay the OLD row instead of creating a new one for the new
   * text — a "new" request that silently runs on the previous run's idea.
   */
  createdRequestId: string | null;
};

const EMPTY: Draft = {
  idea: '', audience: '', goal: 'awareness',
  channels: ['linkedin', 'x', 'newsletter'],
  urls: '', keyword: '', publishToX: false, xIncludeLink: true, sourcesOnly: false, key: '',
  createdRequestId: null,
};

export default function NewRequest() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { value: draft, setValue: setDraft, clear, restored } = usePersisted<Draft>('new-request', EMPTY);

  /**
   * The idempotency key is minted when the form OPENS, not when it is
   * submitted.
   *
   * Minting it inside submit() reads `draft.key` from a state value that the
   * previous keystroke may not have flushed yet, so two submissions close
   * together can mint two different keys for the same text and raise the same
   * request twice. Doing it here means one key exists for the whole life of
   * one draft, it is saved alongside the text, and it survives the refresh the
   * text survives.
   */
  useEffect(() => {
    if (open && restored && !draft.key) {
      setDraft({ ...draft, key: crypto.randomUUID() });
    }
  }, [open, restored, draft, setDraft]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cannibal, setCannibal] = useState<any>(null);
  const [falsePremise, setFalsePremise] = useState<any>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  /**
   * Files live in component state, NOT in the persisted draft.
   *
   * Everything else on this form survives a refresh because it is JSON in
   * localStorage, and a File is not JSON. Trying to keep them would have
   * stored `{}` per file and restored a form that looked like it still had
   * three attachments and did not, which is worse than losing them honestly.
   * The empty file input after a refresh is the truth.
   */
  const [files, setFiles] = useState<File[]>([]);
  const [uploaded, setUploaded] = useState<any[] | null>(null);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    // A key that has already created a request is spent: it now identifies
    // THAT request's content, not this draft. Editing anything past that
    // point means this is a different request, so the key is dropped (the
    // effect above mints a fresh one) rather than letting a resubmit make
    // the server replay the old row under the new text.
    const startingOver = draft.createdRequestId != null;
    setDraft({
      ...draft,
      [k]: v,
      ...(startingOver ? { key: '', createdRequestId: null } : {}),
    });
  };

  const ready = draft.idea.trim().length >= 10
    && draft.audience.trim().length >= 3
    && draft.channels.length > 0;

  async function submit(overrides: { cannibal?: boolean; falsePremise?: boolean } = {}) {
    setConfirm(null);
    setBusy('Creating the Request');
    setError(null);
    setCannibal(null);
    setFalsePremise(null);

    const key = draft.key || crypto.randomUUID();   // belt and braces

    const sourceUrls = draft.urls.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);

    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: key,
          idea: draft.idea, audience: draft.audience, goal: draft.goal,
          channels: draft.channels, sourceUrls,
          keywordHint: draft.keyword || undefined,
          publishToX: draft.publishToX,
          xIncludeLink: draft.xIncludeLink,
          sourcesOnly: draft.sourcesOnly,
          overrideCannibalisation: Boolean(overrides.cannibal),
          overrideFalsePremise: Boolean(overrides.falsePremise),
        }),
      });
      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setBusy(null);
        setError(json?.error?.message ?? 'The request could not be created.');
        return;
      }
      if (json.data?.blocked === 'cannibalisation') {
        setBusy(null);
        setCannibal(json.data);
        return;
      }
      if (json.data?.blocked === 'false_premise') {
        setBusy(null);
        setFalsePremise(json.data);
        return;
      }

      const id: string = json.data.id;
      setCreatedId(id);
      setDraft({ ...draft, createdRequestId: id });

      /*
       * Attachments go up BEFORE research runs, and are read on arrival.
       *
       * Order matters. Research decides whether there is a corpus worth
       * drafting from, so an upload arriving afterwards would be a source the
       * planner never saw. Reading them here also means a scan that came out
       * upside down is reported while the person who has the original is
       * still sitting in front of the form.
       */
      if (files.length > 0) {
        setBusy(`Reading ${files.length} file${files.length === 1 ? '' : 's'}. Scanned pages are transcribed, which takes a moment each.`);
        const body = new FormData();
        for (const f of files) body.append('files', f);
        const up = await fetch(`/api/requests/${id}/attachments`, { method: 'POST', body });
        const upJson = await up.json().catch(() => null);
        if (!up.ok) {
          setBusy(null);
          setError(
            `${upJson?.error?.message ?? 'The files could not be read.'} ` +
            `The request itself was created, so nothing is lost.`);
          return;
        }
        setUploaded(upJson?.data?.files ?? []);

        // A file that could not be read is not a reason to stop, but it IS a
        // reason to say so before spending money on research that will be
        // working from less than the person thinks it is.
        const usable = (upJson?.data?.files ?? []).filter((f: any) => f.status === 'read');
        if (usable.length === 0 && draft.sourcesOnly && !sourceUrls.length) {
          setBusy(null);
          setError(
            'None of those files could be read, and this request is set to use only the ' +
            'material you supply. Add a URL, or re-upload, before researching.');
          return;
        }
      }

      // Research is the long step, so the button says what is happening
      // rather than spinning at somebody for a minute.
      setBusy(draft.sourcesOnly
        ? 'Reading your sources and planning three angles. This takes about a minute.'
        : 'Reading the sources, searching for comparable articles, and planning three angles. This takes about a minute.');
      const r2 = await fetch(`/api/requests/${id}/research`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceUrls }),
      });
      setBusy(null);

      if (!r2.ok) {
        /**
         * THE ERROR HAS TO OUTLIVE THIS FUNCTION.
         *
         * The previous version set the error and then navigated away on the
         * very next line, so the message rendered for one frame at most.
         * Research failing is the most likely failure in the whole pipeline
         * (paywalls, robots.txt, a dead link) and it was the one failure the
         * user could never read. Staying put keeps the reason on screen, and
         * the request still exists, so the link below goes to it.
         */
        const e2 = await r2.json().catch(() => null);
        setError(
          `${e2?.error?.message ?? 'Research did not complete.'}` +
          (e2?.error?.correlationId ? ` Reference ${e2.error.correlationId}.` : ''),
        );
        return;
      }

      // Only now is the draft genuinely spent.
      clear();
      setFiles([]);
      setOpen(false);
      router.push(`/requests/${id}`);
      router.refresh();
    } catch {
      setBusy(null);
      setError('The request did not reach the server. Nothing was created. Check the connection.');
    }
  }

  function askToSubmit() {
    const sourceCount = draft.urls.split(/[\s,]+/).filter(Boolean).length;
    const parts = [
      sourceCount > 0 ? `your ${sourceCount} URL${sourceCount === 1 ? '' : 's'}` : '',
      files.length > 0 ? `${files.length} attachment${files.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);

    setConfirm({
      title: 'Start research on this idea?',
      confirmLabel: 'Start Research',
      body: (
        <>
          <p>
            This reads {parts.length ? parts.join(' and ') : 'what it can find'}
            {draft.sourcesOnly ? '' : ', searches for comparable articles'}, then asks Claude to
            plan three angles. It is the first step that costs money, roughly ten to twenty
            cents.
          </p>
          {files.length > 0 && (
            <p>
              Each attachment is transcribed by the model reading the page, which is what makes
              a scan work and is charged per page. A typical document adds two to five cents.
            </p>
          )}
          {draft.sourcesOnly && (
            <p>
              Nothing outside what you supplied will be read, so the section depth target falls
              back to 700 to 800 words unless your own material provides comparables.
            </p>
          )}
          <p>Nothing is written, and nothing is published, until you choose an angle.</p>
        </>
      ),
      onConfirm: () => submit(),
    });
  }

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        New Request
      </button>
    );
  }

  return (
    <>
      <section className="sheet w-full p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-[-0.01em]">New Content Request</h2>
            <p className="mt-0.5 text-sm text-muted">
              What you type here is kept if you close the tab, so a refresh costs you nothing.
            </p>
          </div>
          <button className="btn btn-quiet" onClick={() => setOpen(false)}>Close</button>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="idea" className="label">The Idea</label>
            <textarea
              id="idea" rows={3} className="field" value={draft.idea}
              onChange={(e) => set('idea', e.target.value)}
              placeholder="What do you want to say, and why now?"
            />
          </div>

          <div>
            <label htmlFor="audience" className="label">Who it is for</label>
            <input
              id="audience" className="field" value={draft.audience}
              onChange={(e) => set('audience', e.target.value)}
              placeholder="Heads of talent at 50 to 200 person startups"
            />
          </div>

          <div>
            <label htmlFor="goal" className="label">What it is for</label>
            <select
              id="goal" className="field" value={draft.goal}
              onChange={(e) => set('goal', e.target.value as Draft['goal'])}
            >
              <option value="awareness">Awareness</option>
              <option value="demand">Demand</option>
              <option value="thought_leadership">Thought Leadership</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="urls" className="label">
              Source URLs{' '}
              <span className="hint">
                {draft.sourcesOnly ? 'optional' : 'optional, we also search'}
              </span>
            </label>
            <textarea
              id="urls" rows={2} className="field" value={draft.urls}
              onChange={(e) => set('urls', e.target.value)}
              placeholder="One per line. Anything we cannot fetch is reported, never skipped quietly."
            />
          </div>

          {/*
            ATTACHMENTS, WHICH ARE THE OTHER HALF OF "supporting material".

            A search finds what is public and ranks well. A fee note, a scanned
            report, an internal deck, the PDF a client emailed: none of that is
            reachable by a URL, and it is frequently the material actually
            worth writing from.

            A scan has no text layer, so it is read by the model looking at the
            page. That is the OCR, it is charged per page, and both facts are
            said here rather than discovered on the invoice.
          */}
          <div className="sm:col-span-2">
            <label htmlFor="files" className="label">
              Attachments{' '}
              <span className="hint">optional. PDFs, scans and photographs of pages</span>
            </label>
            <input
              id="files"
              type="file"
              multiple
              accept="application/pdf,image/jpeg,image/png,image/gif,image/webp"
              className="field file:mr-3 file:rounded file:border-0 file:px-3
                         file:py-1 file:text-sm file:font-medium file:text-ink
                         file:bg-[color-mix(in_oklab,var(--color-sunk)_80%,var(--color-waiting))]
                         hover:file:bg-[color-mix(in_oklab,var(--color-sunk)_66%,var(--color-waiting))]"
              onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 6))}
            />
            <p className="hint mt-1">
              Up to six files, 24MB each. A scanned page is transcribed by the model reading it,
              so a page with no text layer works. Every upload goes through the same prompt
              injection screen as a scraped page, and a flagged one is kept out of the excerpt
              pool.
            </p>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate">{f.name}</span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {(f.size / 1048576).toFixed(1)}MB
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox" className="mt-0.5 size-4 accent-[var(--color-ink)]"
                checked={draft.sourcesOnly}
                onChange={(e) => set('sourcesOnly', e.target.checked)}
              />
              <span>
                <strong className="font-semibold">Use only what I supply.</strong>{' '}
                <span className="text-muted">
                  No search and no competitor discovery, so the article is written from your
                  URLs and attachments and nothing else. What that costs is the section depth
                  target, which is measured from comparable articles and falls back to 700 to
                  800 words when there are none. The request records which one applied.
                </span>
              </span>
            </label>
          </div>

          <div>
            <label htmlFor="keyword" className="label">
              Primary keyword <span className="hint">optional</span>
            </label>
            <input
              id="keyword" className="field" value={draft.keyword}
              onChange={(e) => set('keyword', e.target.value)}
            />
          </div>

          <fieldset>
            <legend className="label">Channels</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
              {CHANNELS.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-ink)]"
                    checked={draft.channels.includes(c.id)}
                    onChange={(e) => set('channels', e.target.checked
                      ? [...draft.channels, c.id]
                      : draft.channels.filter((x) => x !== c.id))}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {draft.channels.includes('x') && (
          <div className="mt-4 rounded-md border border-advisory/25 bg-advisory-bg p-3">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox" className="mt-0.5 size-4 accent-[var(--color-advisory)]"
                checked={draft.publishToX}
                onChange={(e) => set('publishToX', e.target.checked)}
              />
              <span>
                <strong className="font-semibold">Post to X automatically.</strong> No free tier 
                since February 2026, so this channel bills per post. Leave it off and the post is 
                still written, checked and approved, and you copy it out by hand at no cost.
              </span>
            </label>

            {/*
              THE LINK IS A THIRTEENFOLD PRICE DIFFERENCE, so it is a question
              rather than an assumption.

              X charges $0.015 to post and $0.20 if the post contains a link.
              Every post this system writes contains one, so the expensive
              answer was being chosen silently on every single run, and $0.20
              is roughly 45% of what producing the whole pack costs.

              Both prices are printed. Someone deciding how to spend money
              should not have to remember a rate card, and neither option is
              presented as the responsible one: the link is usually the entire
              point of the post.
            */}
            {draft.publishToX && (
              <fieldset className="mt-3 border-t border-advisory/25 pt-3">
                <legend className="sr-only">Include the link in the X post</legend>
                <p className="text-xs font-semibold">What X bills for this post</p>
                <div className="mt-2 space-y-1.5">
                  {[
                    { on: true, price: '$0.20',
                      label: 'Keep the link',
                      note: 'What the post is for. Readers can get to the article.' },
                    { on: false, price: '$0.015',
                      label: 'Drop the link',
                      note: 'The link is removed just before posting. The approved text is not changed.' },
                  ].map((o) => (
                    <label key={String(o.on)} className="flex items-start gap-2.5 text-sm">
                      <input
                        type="radio"
                        name="x-include-link"
                        className="mt-1 size-3.5 accent-[var(--color-advisory)]"
                        checked={draft.xIncludeLink === o.on}
                        onChange={() => set('xIncludeLink', o.on)}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{o.label}</span>
                        <span className="ml-1.5 tabular-nums text-muted">{o.price} per post</span>
                        <span className="block text-xs text-muted">{o.note}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}

        {/* Per file, because "3 files uploaded" is not the useful sentence when
            one of them was a blurry scan and another was a duplicate. */}
        {uploaded && uploaded.length > 0 && (
          <ul className="mt-4 space-y-1.5 rounded-md border border-rule bg-sunk/40 p-3 text-sm">
            {uploaded.map((f: any, i: number) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className={`pill mt-0.5 shrink-0 ${
                  f.status === 'read' ? 'bg-ok-bg text-ok'
                  : f.status === 'quarantined' ? 'bg-blocking-bg text-blocking'
                  : 'bg-advisory-bg text-advisory'}`}>
                  {f.status === 'read' ? 'Read'
                    : f.status === 'quarantined' ? 'Quarantined'
                    : f.status === 'duplicate' ? 'Duplicate'
                    : f.status === 'rejected' ? 'Rejected' : 'Unreadable'}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{f.name}</span>
                  {f.reason && <span className="block text-xs text-muted">{f.reason}</span>}
                  {f.status === 'read' && (
                    <span className="block text-xs text-muted">
                      {f.excerpts} excerpt{f.excerpts === 1 ? '' : 's'} pulled from it
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {cannibal && (
          <div className="mt-4 rounded-md border border-advisory/25 bg-advisory-bg p-4 text-sm">
            <p className="font-semibold">{cannibal.message}</p>
            <ul className="mt-2 space-y-1">
              {cannibal.matches?.map((m: any) => (
                <li key={m.id}>
                  <a href={m.url} target="_blank" rel="noreferrer" className="underline">{m.title}</a>
                  <span className="text-muted"> at {(m.similarity * 100).toFixed(0)}% similar</span>
                </li>
              ))}
            </ul>
            <button className="btn btn-quiet mt-3" onClick={() => submit({ cannibal: true })}>
              Write it anyway
            </button>
          </div>
        )}

        {/*
          A DIFFERENT COLOUR FROM THE DUPLICATE-CONTENT WARNING ABOVE, ON
          PURPOSE. A near-duplicate topic is a ranking problem; this is a
          request to assert something false under the firm's name, and the
          override sits behind red rather than amber so it reads as the
          heavier decision it is. The claim and the reason are both shown
          verbatim, because "trust us" is not an acceptable answer to "why was
          my request blocked".
        */}
        {falsePremise && (
          <div className="mt-4 rounded-md border border-blocking/30 bg-blocking-bg p-4 text-sm">
            <p className="font-semibold text-blocking">{falsePremise.message}</p>
            {falsePremise.claim && (
              <p className="mt-2 text-ink-70">
                <span className="text-muted">The claim: </span>
                &ldquo;{falsePremise.claim}&rdquo;
              </p>
            )}
            {falsePremise.reason && (
              <p className="mt-1 text-ink-70">{falsePremise.reason}</p>
            )}
            <p className="mt-2 text-xs text-muted">
              This check reads only the idea you typed, using general knowledge, not the
              sources. It flags a plain violation of settled fact and nothing more: an idea
              that argues an unpopular position, or examines a false belief rather than
              asserting it, should not trigger this. If this one is wrong, say so below.
            </p>
            <button
              className="btn btn-danger mt-3"
              onClick={() => submit({ falsePremise: true })}
            >
              This is not false, write it anyway
            </button>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-md border border-blocking/25 bg-blocking-bg p-3 text-sm">
            <p className="text-blocking">{error}</p>
            {createdId && (
              <p className="mt-1.5 text-ink-70">
                The request itself was created.{' '}
                <a href={`/requests/${createdId}`} className="font-medium underline">
                  Open it to see which sources failed
                </a>{' '}
                and add one by hand.
              </p>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center gap-3 border-t border-rule pt-4">
          <button className="btn btn-primary" onClick={askToSubmit} disabled={Boolean(busy) || !ready}>
            {busy ?? 'Research and Plan'}
          </button>
          {!busy && !ready && (
            <span className="hint">
              An idea of at least ten characters, an audience and one channel.
            </span>
          )}
          {(draft.idea || draft.audience) && !busy && (
            <button className="btn btn-ghost ml-auto" onClick={clear}>Clear the form</button>
          )}
        </div>
      </section>

      <Confirm spec={confirm} busy={Boolean(busy)} onCancel={() => setConfirm(null)} />
    </>
  );
}
