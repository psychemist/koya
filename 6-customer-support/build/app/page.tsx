import { cookies } from 'next/headers';
import { ModeSwitch } from './mode-switch.tsx';
import { DEFAULT_HOURS } from '../lib/hours.ts';
import { one } from '../lib/db.ts';
import { CALLER_COOKIE, readCallerCookie } from '../lib/caller.ts';
import { SupportShell } from './support/shell.tsx';
import { SignInForm } from './support/sign-in-form.tsx';
import { SwitchCaller } from './support/switch-caller.tsx';
import { ShieldIcon } from './ui/icons.tsx';

export const dynamic = 'force-dynamic';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
const PHONE = process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? '';

/** Callback hours come from the same config the booking tool checks, so the page cannot promise a time the agent refuses. */
function callbackHours() {
  const d = DEFAULT_HOURS.days;
  const days = d.length > 1 ? `${DAY[d[0]]} to ${DAY[d[d.length - 1]]}` : DAY[d[0]];
  return `${days}, ${hh(DEFAULT_HOURS.startHour)} to ${hh(DEFAULT_HOURS.endHour)} UTC`;
}

const TOPICS = [
  ['Fees and pricing', 'How fees are set for each transaction type and payment method.'],
  ['Payment timelines', 'When money normally arrives, and what can hold it up.'],
  ['A transaction or payout', 'Live status, looked up against your account once you sign in.'],
  ['A specialist', 'For compliance holds, disputes or anything urgent.'],
] as const;

const GUEST_STARTERS = [
  'What fees apply to an international payment?',
  'How long does a payment to Kenya usually take?',
  'Why do I need to verify my business?',
  'I need to speak to a specialist.',
];
const CUSTOMER_STARTERS = [
  'Can you check the status of my transaction?',
  'Why is my payout delayed?',
  'What fees apply to an international payment?',
  'I need to speak to a specialist.',
];

type Account = { customer_id: string; contact_name: string; company_name: string; plan: string; account_status: string };
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Safety() {
  return <p className="sp-safe"><ShieldIcon size={18} /><span>We never ask for card numbers, passwords or one-time codes.</span></p>;
}
function Hours() {
  return (
    <div className="sp-hours">
      <p className="sp-hours-h">Specialist callbacks</p>
      <p>{callbackHours()}{PHONE ? `. Or call ${PHONE}.` : '.'}</p>
    </div>
  );
}

export default async function SupportPage() {
  const caller = readCallerCookie((await cookies()).get(CALLER_COOKIE)?.value);
  const account = caller?.mode === 'customer'
    ? await one<Account>('select customer_id, contact_name, company_name, plan, account_status from public.customers where customer_id = $1',
        [caller.customerId]).catch(() => null)
    : null;

  // Nobody chosen yet, or a customer cookie for an account we cannot read: the sign-in screen.
  if (!caller || (caller.mode === 'customer' && !account)) {
    return (
      <SupportShell rail="signed-out" railText="What we can help with" panel={
        <>
          <p className="sp-kicker">Support by voice or chat</p>
          <h1 className="sp-title">Get help with your payments</h1>
          <p className="sp-lede">Answers come from our help centre and, when you sign in, from your own account. Anything we cannot settle goes to a specialist.</p>
          <dl className="sp-topics">{TOPICS.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
          <div className="sp-grow" />
          <Safety />
        </>
      }>
        <SignInForm />
      </SupportShell>
    );
  }

  if (caller.mode === 'guest') {
    return (
      <SupportShell rail="guest" railText="Guest: general questions" topRight={<><span className="sp-who">Guest</span><SwitchCaller kind="guest" /></>} panel={
        <>
          <p className="sp-kicker" data-tone="quiet">Guest</p>
          <h1 className="sp-title">Ask us anything general</h1>
          <p className="sp-lede">As a guest you get answers from our help centre on fees, timelines and policies. Sign in to check a payment or your account.</p>
          <dl className="sp-topics">{TOPICS.filter(([t]) => t !== 'A transaction or payout').map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
          <Hours />
          <div className="sp-grow" />
          <Safety />
        </>
      }>
        <ModeSwitch hint="Guest: general questions" starters={GUEST_STARTERS} />
      </SupportShell>
    );
  }

  const a = account!;
  const first = a.contact_name.split(/\s+/)[0];
  return (
    <SupportShell rail="customer" railText={`${a.contact_name}, ${a.company_name}`} initials={a.contact_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('')}
      topRight={<><span className="sp-who">{a.contact_name}</span><SwitchCaller kind="customer" /></>} panel={
      <>
        <p className="sp-kicker">Signed in</p>
        <h1 className="sp-title">Welcome back, {first}</h1>
        <p className="sp-lede">We can see your account, so you can go straight to your question.</p>
        <dl className="sp-account">
          <div><dt>Company</dt><dd>{a.company_name}</dd></div>
          <div><dt>Customer ID</dt><dd>{a.customer_id}</dd></div>
          <div><dt>Plan</dt><dd>{a.plan}</dd></div>
          <div><dt>Account</dt><dd>{sentence(a.account_status)}</dd></div>
        </dl>
        <Hours />
        <div className="sp-grow" />
        <Safety />
      </>
    }>
      <ModeSwitch hint={`Signed in as ${a.company_name}`} starters={CUSTOMER_STARTERS} />
    </SupportShell>
  );
}
