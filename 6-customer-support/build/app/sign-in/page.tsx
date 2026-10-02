import { SignIn } from '../ui/sign-in.tsx';

export const metadata = { title: 'Sign in: RelayPay Support Console' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="rp-auth">
      <img src="/relaypay-logo.png" alt="RelayPay" width={147} height={30} />
      <section className="rp-card" aria-labelledby="signin-title">
        <h1 id="signin-title">Support console</h1>
        <p className="rp-lede">Review conversations and work tickets and escalations. Admins also record evaluations.</p>
        <SignIn next={next} />
      </section>
      <p className="rp-auth-foot">Looking for help with your account? <a href="/">Contact support</a></p>
    </main>
  );
}
