import Link from 'next/link';

/**
 * A console address with no record behind it, most often an old escalation or conversation link from Discord
 * or the support email. It renders inside the console frame, so the sidebar is still there to go elsewhere.
 */
export default function ConsoleNotFound() {
  return (
    <div className="nf-box nf-box-console">
      <p className="nf-kicker">Not found</p>
      <h1>That record does not exist</h1>
      <p className="nf-lede">The conversation, ticket or escalation this link points to is not in the console. It may have been removed with test data, or the link may be incomplete.</p>
      <div className="rp-row nf-actions">
        <Link href="/console" className="rp-btn">Conversations</Link>
        <Link href="/console/escalations" className="rp-btn rp-btn-quiet">Escalations</Link>
      </div>
    </div>
  );
}
