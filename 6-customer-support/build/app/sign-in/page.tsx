import { SignIn } from '../ui/sign-in.tsx';

export const metadata = { title: 'Sign in: RelayPay support console' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="rp-shell">
      <header className="rp-header"><img src="/relaypay-logo.png" alt="RelayPay" width={137} height={28} /></header>
      <section className="rp-card" aria-labelledby="signin-title">
        <h1 id="signin-title">Support console</h1>
        <p className="rp-lede">Review conversations, work tickets and escalations, and record evaluations.</p>
        <SignIn next={next} />
      </section>
    </main>
  );
}
