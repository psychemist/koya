import { VoicePanel } from './voice-panel.tsx';

export default function SupportPage() {
  return (
    <main className="rp-shell">
      <header className="rp-header">
        <img src="/relaypay-logo.png" alt="RelayPay" width={137} height={28} />
      </header>
      <section className="rp-card" aria-labelledby="support-title">
        <h1 id="support-title">RelayPay Support</h1>
        <p className="rp-lede">Ask about fees, payment timelines, a transaction or payout, or get connected to a specialist.</p>
        <VoicePanel />
      </section>
    </main>
  );
}
