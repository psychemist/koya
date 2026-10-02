import Link from 'next/link';

export const metadata = { title: 'Page not found: RelayPay Support' };

/** Any address the site does not have. The page says what happened and offers the two places people mean to go. */
export default function NotFound() {
  return (
    <div className="sp-page">
      <header className="sp-top">
        <img src="/relaypay-logo.png" alt="RelayPay" width={137} height={28} />
        <span className="sp-top-note">Customer Support</span>
      </header>
      <main className="nf-main">
        <div className="nf-box">
          <p className="nf-kicker">Page not found</p>
          <h1>We could not find that page</h1>
          <p className="nf-lede">The link may be out of date, or the address may have a typo. Nothing about your account or payments has changed.</p>
          <div className="rp-row nf-actions">
            <Link href="/" className="rp-btn">Go to support</Link>
            <Link href="/console" className="rp-btn rp-btn-quiet">Support console</Link>
          </div>
          <p className="nf-note">Need help now? You can talk to RelayPay support by voice or chat from the support page.</p>
        </div>
      </main>
    </div>
  );
}
