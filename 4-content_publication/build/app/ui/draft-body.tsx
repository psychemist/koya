import { esc, markBody } from './mark-body';

/**
 * A stored draft, rendered as something to read.
 *
 * The workspace used to put the body in a <pre>, which gets the line breaks
 * right and everything else wrong: a 3,000-word article in a monospace block
 * with `## ` still showing is a thing people scroll past rather than read.
 *
 * `proof` on purpose, so the article looks the same here as on the review
 * screen. Two renderings of one draft is two chances for a reviewer to
 * approve something that looked different when they read it.
 */
export default function DraftBody({
  body, unsupported = [], citations = {}, compact = false,
}: {
  body: string; unsupported?: string[]; citations?: Record<string, string>; compact?: boolean;
}) {
  const blocks = body.split(/\n{2,}/).map((raw, i) => {
    const text = raw.trim();
    if (!text) return null;

    if (text.startsWith('## ')) {
      return <h3 key={i} className="t-h2">{text.slice(3)}</h3>;
    }
    if (text.startsWith('# ')) {
      return <h2 key={i} className="t-h1">{text.slice(2)}</h2>;
    }
    return (
      <p
        key={i}
        className="t-p"
        dangerouslySetInnerHTML={{ __html: markBody(esc(text), unsupported, citations) }}
      />
    );
  });

  return <div className={`proof${compact ? ' proof-compact' : ''}`}>{blocks}</div>;
}
